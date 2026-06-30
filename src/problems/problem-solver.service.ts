import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'stream';
import type { AnthropicClient } from '../integrations/anthropic/anthropic-client';
import { ANTHROPIC_CLIENT } from '../integrations/anthropic/anthropic.tokens';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.tokens';
import type { StorageService } from '../storage/storage.service';
import type { SseSink } from './problem-sse-sink';

/**
 * Model identifier sent in the request body. Locked by PRD §"LLM
 * provider clarification" — we use the Anthropic wire protocol against
 * the MiniMax-hosted endpoint, NOT Anthropic's own API.
 */
const MODEL_ID = 'MiniMax-M3';

/**
 * Hard cap on how long a single solve can run, default 180s (env-
 * overridable). The PRD's failure message (`解题超时，请稍后重试`)
 * maps to a 180s wall-clock breach.
 */
const DEFAULT_SOLVER_TIMEOUT_MS = 180_000;

/**
 * Default answer-token ceiling. Thinking tokens are a SEPARATE budget
 * on the LLM side; `max_tokens` is just the answer.
 */
const DEFAULT_SOLVER_MAX_TOKENS = 8_192;

/**
 * ProblemSolverService — drives the AI loop that turns a `pending`
 * `Problem` row into a `done` row + a `Solution` row.
 *
 * Concurrency contract (PRD §"Concurrency guard"):
 *   1. Atomic `updateMany` flips `pending → solving`. If `count === 0`,
 *      somebody else got there first (or status is already `done` /
 *      `failed`); we emit `status: already_processing` and bail.
 *   2. From that point on, exactly one solve is in flight for this
 *      problem. Two concurrent SSE opens → the second gets
 *      `already_processing` and the SDK is called once total.
 *
 * Failure contract:
 *   Any throw (timeout, network, malformed JSON, 4xx, 5xx) → mark
 *   row `status: 'failed'` → emit `status: failed` + `error` → close
 *   stream. The DB row is the audit trail; the SSE error frame is
 *   the user-facing signal.
 */
@Injectable()
export class ProblemSolverService {
  private readonly logger = new Logger(ProblemSolverService.name);

  private readonly solverTimeoutMs: number;
  private readonly solverMaxTokens: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ANTHROPIC_CLIENT) private readonly ai: AnthropicClient,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.solverTimeoutMs = config.get<number>(
      'SOLVER_TIMEOUT_MS',
      DEFAULT_SOLVER_TIMEOUT_MS,
    );
    this.solverMaxTokens = config.get<number>(
      'SOLVER_MAX_TOKENS',
      DEFAULT_SOLVER_MAX_TOKENS,
    );
  }

  /**
   * Solve a single problem and stream results to `sink`.
   *
   * Caller responsibilities:
   * - IDOR-check the problem against the current user BEFORE calling
   *   (this method assumes the caller has already done so). The
   *   `findUnique` inside this method is for loading `grade` only.
   * - Pass a sink bound to the active SSE response.
   *
   * Returns once the stream has either emitted `done` (success),
   * emitted `error` (failure), or detected `already_processing`
   * (concurrency lost). The caller never gets a Promise rejection for
   * expected failure modes — they all surface as `error` SSE frames.
   * Programming errors (DB connection lost mid-write) DO reject.
   */
  async solve(problemId: number, sink: SseSink): Promise<void> {
    // 1. Atomic state transition pending → solving. count === 0 means
    //    somebody else already started (or it's done/failed) — no SDK
    //    call, no DB write, no further side effects.
    const claimed = await this.prisma.problem.updateMany({
      where: { id: problemId, status: 'pending' },
      data: { status: 'solving' },
    });
    if (claimed.count === 0) {
      sink.emit('status', { status: 'already_processing' });
      sink.complete();
      return;
    }

    // 1a. First event on every successful subscribe: `status: solving`.
    //     PRD §"SSE event schema" — the `status` event is the very first
    //     frame so the client can paint the "AI is thinking" UI before
    //     any thinking_delta content arrives.
    sink.emit('status', { status: 'solving' });

    // 2. Load the problem with the grade we need for the system prompt.
    //    This is a single round-trip, NOT an N+1 — `select` on the
    //    relation lets Prisma fetch `grade` in the same query.
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        id: true,
        imageUrl: true,
        child: { select: { grade: true } },
      },
    });
    if (!problem) {
      // Race: row got deleted between updateMany and findUnique. Mark
      // failed and bail — there's nothing left to solve.
      await this.markFailed(problemId);
      sink.emit('status', { status: 'failed' });
      sink.emit('error', { message: '解题失败，请稍后重试' });
      sink.complete();
      return;
    }

    // 3. Read the image bytes. The LLM is multimodal — we hand it
    //    the image directly (no OCR). Storage gives us a Readable;
    //    we need a single Buffer for the Anthropic message body.
    let imageBuffer: Buffer;
    let mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    try {
      const stream = this.storage.read(problem.imageUrl);
      imageBuffer = await streamToBuffer(stream);
      mediaType = this.mimeFromKey(problem.imageUrl);
    } catch (err) {
      this.logger.error(
        `image read failed for problem ${problemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.markFailed(problemId);
      sink.emit('status', { status: 'failed' });
      sink.emit('error', { message: '解题失败，请稍后重试' });
      sink.complete();
      return;
    }

    // 4. The hard-timeout contract. AbortController fires at the env
    //    bound; the Anthropic SDK listens on the AbortSignal and tears
    //    down the underlying HTTP request. We surface a Chinese
    //    timeout message to the client (PRD §"Error messages").
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      this.solverTimeoutMs,
    );

    // Local accumulators for the final transaction. `reasoningText`
    // is intentionally NOT accumulated — per PRD §"Out of Scope",
    // reasoning is SSE-only and never persisted. Only the answer
    // text goes into the Solution row.
    let answerText = '';
    // (C) usage holds the full SDK `finalMessage().usage` object;
    // emitted on the SSE `done` event in (γ) follow-up commit.
    // `totalTokens` (a derived number) is kept here for the
    // intermediate state — (γ) will replace it.
    let totalTokens: number | null = null;
    let usage: import('../integrations/anthropic/anthropic-client').Usage | null = null;

    try {
      // 5. Open the stream. The SDK's `.on('text')` and
      //    `.on('thinking')` events give us deltas in shape we can
      //    forward 1:1 to the SSE sink.
      const stream = this.ai.messages.stream(
        {
          model: MODEL_ID,
          max_tokens: this.solverMaxTokens,
          thinking: { type: 'adaptive' },
          system: buildSystemPrompt(problem.child.grade),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: imageBuffer.toString('base64'),
                  },
                },
                { type: 'text', text: '请解答这道题' },
              ],
            },
          ],
        },
        { signal: abortController.signal },
      );

      // 6. Wire the SDK events to our SSE sink. We accumulate the
      //    answer text locally for the final Solution row; reasoning
      //    text is SSE-only (per PRD §"Out of Scope") and forwarded
      //    straight to the client without local copy.
      stream.on('thinking', (delta: string) => {
        sink.emit('reasoning_delta', { text: delta });
      });
      stream.on('text', (delta: string) => {
        answerText += delta;
        sink.emit('content_delta', { text: delta });
      });

      // 7. Wait for the stream to finish. `finalMessage()` resolves
      //    with the assembled message object — we capture the FULL
      //    `usage` object per (C) lock (no folding to just
      //    output_tokens). (γ) follow-up commit will plumb it to
      //    the SSE `done` event payload.
      const final = await stream.finalMessage();
      totalTokens = final.usage.output_tokens;
      usage = final.usage;

      // 8. Commit the result. One short transaction — we never hold
      //    a DB transaction across a 180s AI call.
      const solution = await this.prisma.$transaction(async (tx) => {
        const created = await tx.solution.create({
          data: {
            problemId,
            content: answerText,
            model: MODEL_ID,
            // (C) Solution.usage is the full SDK usage JSON object.
            usage: usage as object,
          },
          select: { id: true },
        });
        await tx.problem.update({
          where: { id: problemId },
          data: { status: 'done' },
        });
        return created;
      });

      sink.emit('done', { problemId, solutionId: solution.id, totalTokens });
    } catch (err) {
      // Failure path: translate the throw to a Chinese user-facing
      // message. Distinguish timeout (AbortError) from generic
      // failure (everything else) per PRD §"Error messages (locked)".
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const userMessage = isTimeout
        ? '解题超时，请稍后重试'
        : '解题失败，请稍后重试';
      this.logger.error(
        `solve failed for problem ${problemId} (timeout=${isTimeout}): ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.markFailed(problemId);
      sink.emit('status', { status: 'failed' });
      sink.emit('error', { message: userMessage });
    } finally {
      clearTimeout(timer);
      sink.complete();
    }
  }

  /**
   * Best-effort status update. If even THIS throws, we let the
   * upstream error propagate — there's no point swallowing on top of
   * a DB that's already unreachable.
   */
  private async markFailed(problemId: number): Promise<void> {
    try {
      await this.prisma.problem.update({
        where: { id: problemId },
        data: { status: 'failed' },
      });
    } catch (err) {
      this.logger.error(
        `markFailed failed for problem ${problemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Map a storage key's extension back to the upload-time MIME.
   * The whitelist (JPEG/PNG/WEBP) means we have a 1:1 map —
   * `getImage` in ProblemsService uses the same logic, kept in sync
   * here by spec. Returns `image/png` as a defensive fallback for
   * unexpected extensions.
   */
  private mimeFromKey(key: string): 'image/jpeg' | 'image/png' | 'image/webp' {
    const lower = key.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/png';
  }
}

/**
 * Drain a Readable into a single Buffer. We need the whole image in
 * memory to base64-encode it for the Anthropic message body —
 * `messages.stream` does not support chunked image uploads.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Grade band → system prompt. Each tier has a distinct marker in
 * square brackets at the start of the prompt so tests can grep for
 * it (`fakeAi.lastBody.system` carries the system prompt the
 * solver hands to the SDK).
 *
 * Tiers:
 * - `primary` (1-6):   小学 — simple, life-example-based, gentle.
 * - `middle`  (7-12):  中学 — moderate abstraction, formula-friendly.
 * - `higher`  (13+):   高阶 — formal, symbolic, proof-oriented.
 *
 * Out-of-range fallback (`grade` is not a positive integer, or the
 * Child.grade CHECK constraint is bypassed somehow): the `default`
 * tier is used. The migration adding the CHECK lives in
 * `prisma/migrations/<date>_add_child_grade_range_check` and
 * enforces `1 <= grade <= 12`, so the default branch is only
 * reachable during tests or future schema drift.
 */
type GradeTier = 'primary' | 'middle' | 'higher' | 'default';

const PROMPT_BY_TIER: Record<GradeTier, string> = {
  primary: [
    '【小学阶段】',
    '你是一位为小学生服务的辅导老师。',
    '请先在脑中推理（用 "思考" 通道），然后再给出最终答案。',
    '用生活里的具体物品打比方（比如苹果、糖果），把抽象概念变成画面。',
    '遇到几何题尽量用文字描述图形（"左边一个三角形，右边一个正方形"）。',
    '遇到应用题列出已知条件与求解目标，每一步算完都告诉孩子"我们在算什么"。',
    '最后一行以 "答案：" 开头，给出一句话总结。',
  ].join('\n'),
  middle: [
    '【中学阶段】',
    '你是一位为中学生服务的辅导老师。',
    '请先在脑中推理（用 "思考" 通道），然后再给出最终答案。',
    '可以使用符号、公式和规范的数学表达，不必每一步都用日常语言翻译。',
    '遇到几何题画辅助线、标注关键角或边；遇到应用题用"已知…求…"框架列条件。',
    '解释清楚每一步变形/代入的根据，不要跳步。',
    '最后一行以 "答案：" 开头，给出一句话总结。',
  ].join('\n'),
  higher: [
    '【高阶阶段】',
    '你是一位为高阶学习者（大学/竞赛/成人）服务的辅导老师。',
    '请先在脑中推理（用 "思考" 通道），然后再给出最终答案。',
    '使用严格的数学符号和术语，必要时给出证明或推导过程。',
    '列出关键假设和所用定理/引理；对边界条件、唯一性、收敛性等做必要说明。',
    '最后一行以 "答案：" 开头，给出一句话总结。',
  ].join('\n'),
  default: [
    '【默认】',
    '你是一位辅导老师。',
    '请先在脑中推理（用 "思考" 通道），然后再给出最终答案。',
    '请用通用的、可读的解释风格。',
    '最后一行以 "答案：" 开头，给出一句话总结。',
  ].join('\n'),
};

function tierForGradeInternal(grade: number): GradeTier {
  if (Number.isInteger(grade) && grade >= 1 && grade <= 6) return 'primary';
  if (Number.isInteger(grade) && grade >= 7 && grade <= 12) return 'middle';
  if (Number.isInteger(grade) && grade >= 13) return 'higher';
  return 'default';
}

/**
 * Map a `Child.grade` value to its system-prompt tier. Exported for
 * unit tests; production code should call `buildSystemPrompt`
 * directly rather than going through this mapping. The DB CHECK
 * constraint added in
 * `prisma/migrations/20260629110000_add_child_grade_range_check/`
 * enforces `1..12` at the storage layer, so the `higher` and
 * `default` branches are only reachable during tests or future
 * schema drift.
 */
export function tierForGrade(grade: number): GradeTier {
  return tierForGradeInternal(grade);
}

/**
 * Build the system prompt for a given `grade`.
 *
 * - Returns the `primary` tier for grades 1-6.
 * - Returns the `middle` tier for grades 7-12.
 * - Returns the `higher` tier for grades ≥13.
 * - Falls back to `default` if the grade is not a positive integer
 *   (non-integer, NaN, or ≤0). Schema-level enforcement of
 *   `1 <= grade <= 12` lives in
 *   `prisma/migrations/<date>_add_child_grade_range_check`.
 */
export function buildSystemPrompt(grade: number): string {
  return PROMPT_BY_TIER[tierForGradeInternal(grade)];
}
