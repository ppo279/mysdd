import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_SERVICE } from '../storage/storage.tokens';
import type { StorageService } from '../storage/storage.service';
import type { CreateProblemDto } from './dto/create-problem.dto';

/**
 * Shape returned by `create` and `getOne`. The `imageUrl` here is the
 * **API path** (`/problems/${id}/image`) — never the raw storage key
 * stored in `Problem.imageUrl`. The DB column is internal detail.
 */
export interface ProblemView {
  id: number;
  childId: number;
  imageUrl: string;
  status: 'pending' | 'solving' | 'done' | 'failed';
  createTime: Date;
  solution: SolutionView | null;
}

export interface SolutionView {
  id: number;
  content: string;
  model: string | null;
  token: number | null;
  createTime: Date;
}

const apiImagePath = (problemId: number): string =>
  `/problems/${problemId}/image`;

/**
 * ProblemsService — Phase 1 vertical slice.
 *
 * Covers `create`, `getOne`, `getImage` (no streaming/solve yet — that's
 * issue 002). All write paths are DB-first so a storage failure leaves
 * the row marked `status: 'failed'` with no orphan file.
 *
 * IDOR policy: any "this resource is not yours" miss is reported as
 * `<resource> 不存在` (404), not 403 — this prevents family-id
 * enumeration via probing different ids.
 */
@Injectable()
export class ProblemsService {
  private readonly logger = new Logger(ProblemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Upload a problem image.
   *
   * DB-first order (rationale in PRD §"DB-first create order"):
   *   1. IDOR-check the childId.
   *   2. Insert Problem row with `imageUrl: ''`, `status: 'pending'`.
   *      The empty URL is a transient sentinel no reader ever sees —
   *      the API response shape uses `/problems/${id}/image` derived
   *      from `id`, not from the column.
   *   3. Storage write. On failure → mark row `status: 'failed'`,
   *      bubble up 500.
   *   4. DB update with the real storage key. On failure → mark row
   *      `status: 'failed'` AND best-effort delete the orphaned file.
   */
  async create(
    userId: number,
    dto: CreateProblemDto,
    file: Express.Multer.File,
  ): Promise<ProblemView> {
    // Step 1: IDOR check — does this child actually belong to this user?
    const child = await this.prisma.child.findFirst({
      where: { id: dto.childId, userId },
      select: { id: true },
    });
    if (!child) {
      // Same response shape as "doesn't exist anywhere" — anti-enumeration.
      throw new NotFoundException('child 不存在');
    }

    // Step 2: DB create with placeholder.
    const problem = await this.prisma.problem.create({
      data: {
        childId: dto.childId,
        imageUrl: '',
        status: 'pending',
      },
      select: { id: true, childId: true, createTime: true, status: true },
    });

    // Step 3: storage write.
    let storedKey: string;
    try {
      const result = await this.storage.put({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        userId,
      });
      storedKey = result.key;
    } catch (err) {
      // No file was written (writeFile throws before completing), so no
      // cleanup needed — just mark the row and surface 500.
      await this.markFailed(problem.id);
      this.logger.error(
        `storage.put failed for problem ${problem.id} (user ${userId})`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException('服务器内部错误');
    }

    // Step 4: DB update with real key.
    try {
      await this.prisma.problem.update({
        where: { id: problem.id },
        data: { imageUrl: storedKey },
      });
    } catch (err) {
      // File IS on disk here — best-effort delete it, then mark row.
      await this.storage.delete(storedKey);
      await this.markFailed(problem.id);
      this.logger.error(
        `DB update with storage key failed for problem ${problem.id}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException('服务器内部错误');
    }

    return {
      id: problem.id,
      childId: problem.childId,
      imageUrl: apiImagePath(problem.id),
      status: 'pending',
      createTime: problem.createTime,
      solution: null,
    };
  }

  /**
   * Read a single problem (with its solution, if any).
   * Returns 404 `problem 不存在` on miss OR IDOR.
   */
  async getOne(userId: number, problemId: number): Promise<ProblemView> {
    const problem = await this.prisma.problem.findFirst({
      where: { id: problemId, child: { userId } },
      select: {
        id: true,
        childId: true,
        createTime: true,
        status: true,
        solutions: {
          orderBy: { createTime: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            model: true,
            token: true,
            createTime: true,
          },
        },
      },
    });

    if (!problem) {
      throw new NotFoundException('problem 不存在');
    }

    return {
      id: problem.id,
      childId: problem.childId,
      imageUrl: apiImagePath(problem.id),
      status: problem.status as ProblemView['status'],
      createTime: problem.createTime,
      solution: problem.solutions[0]
        ? {
            id: problem.solutions[0].id,
            content: problem.solutions[0].content,
            model: problem.solutions[0].model,
            token: problem.solutions[0].token,
            createTime: problem.solutions[0].createTime,
          }
        : null,
    };
  }

  /**
   * Lightweight IDOR check used by the SSE stream endpoint. Confirms
   * the problem exists AND belongs to the calling user. Returns the
   * status so the controller can decide whether to even open a stream
   * (e.g. a `done` row that was already solved can short-circuit to
   * the cached solution). Throws `404 problem 不存在` on miss — same
   * shape as every other endpoint, no enumeration via probing ids.
   *
   * Why a separate method instead of reusing `getOne`? `getOne` does
   * a heavier query (loads the latest solution) and we don't need
   * any of that data on the stream path. The check has to be cheap
   * because every stream open pays for it.
   */
  async assertOwnedByUser(
    userId: number,
    problemId: number,
  ): Promise<{
    id: number;
    status: 'pending' | 'solving' | 'done' | 'failed';
  }> {
    const problem = await this.prisma.problem.findFirst({
      where: { id: problemId, child: { userId } },
      select: { id: true, status: true },
    });
    if (!problem) {
      throw new NotFoundException('problem 不存在');
    }
    return {
      id: problem.id,
      status: problem.status as 'pending' | 'solving' | 'done' | 'failed',
    };
  }

  /**
   * Stream the stored image bytes. Returns the Readable plus the MIME
   * that was sniffed at upload time.
   *
   * Status guard: a `status: 'failed'` row never has a usable image —
   * either the file was never written (step 3 failed) or the storage key
   * is empty. Either way we report `problem 不存在` to the caller. This
   * matches the IDOR miss response exactly (no status-leaking 410).
   *
   * The controller wraps the Readable in `StreamableFile` and sets the
   * `Content-Type` header — we just hand back the raw stream + metadata.
   */
  async getImage(
    userId: number,
    problemId: number,
  ): Promise<{ stream: Readable; mime: string }> {
    const problem = await this.prisma.problem.findFirst({
      where: { id: problemId, child: { userId } },
      select: { id: true, status: true, imageUrl: true },
    });

    if (!problem || problem.status === 'failed') {
      throw new NotFoundException('problem 不存在');
    }

    // imageUrl is the storage key. Read it; downstream wraps in StreamableFile.
    const stream = this.storage.read(problem.imageUrl);
    // MIME isn't stored separately — sniff from the storage key's extension.
    // The four-MIME whitelist means we have a 1:1 map (see LocalDiskStorageService).
    const mime = mimeFromKey(problem.imageUrl);
    return { stream, mime };
  }

  /**
   * Mark a problem as `failed`. Best-effort — if even this throws, the
   * upstream caller already has a 500 to surface.
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
}

/**
 * Map a storage key's extension back to the upload-time MIME.
 * The whitelist is JPEG/PNG/GIF/WEBP — see `LocalDiskStorageService.MIME_TO_EXT`.
 * Returns `application/octet-stream` if the extension is unexpected
 * (defense in depth — the controller's fileFilter should have prevented
 * anything reaching disk that's not on this list).
 */
function mimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}
