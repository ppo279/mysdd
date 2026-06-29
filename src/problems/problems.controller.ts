import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  MessageEvent,
  Param,
  ParseIntPipe,
  Post,
  Res,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Observable, Subscription, interval, map } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { CreateProblemDto } from './dto/create-problem.dto';
import { StreamIdorGuard } from './guards/stream-idor.guard';
import { ProblemSolverService } from './problem-solver.service';
import { ProblemsService } from './problems.service';
import type {
  SseEventName,
  SseEventPayload,
  SseSink,
} from './problem-sse-sink';
import {
  multerErrorToMessage,
  problemImageMulterOptions,
} from './upload/multer-options';

@Controller('problems')
@UseGuards(JwtAuthGuard)
export class ProblemsController {
  private readonly logger = new Logger(ProblemsController.name);

  /**
   * 15s heartbeat interval. Locked by PRD §"SSE transport (locked)":
   * mobile networks silently drop idle connections, so we emit a
   * frame every 15s. Nest's `@Sse()` decorator serializes `MessageEvent`
   * objects to `data:` lines — there is no built-in way to emit a raw
   * `: keep-alive\n\n` comment, so we emit a `ping` event instead.
   * Functionally identical (any incoming bytes reset the mobile
   * network's idle timer); not part of the 5 PRD-locked event names.
   */
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000;

  constructor(
    private readonly problemsService: ProblemsService,
    private readonly problemSolverService: ProblemSolverService,
  ) {}

  /**
   * POST /problems (multipart/form-data, JwtAuthGuard).
   *
   * Fields:
   * - `image`: file (required, MIME whitelisted, ≤10 MB)
   * - `childId`: integer string (required)
   *
   * 201 → `{ code: 0, data: { id, childId, imageUrl: '/problems/:id/image', status: 'pending', createTime } }`
   * 400 → missing image / bad childId / wrong MIME / oversize
   * 401 → inherited from JwtAuthGuard
   * 404 → `child 不存在` (IDOR-safe)
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('image', problemImageMulterOptions))
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateProblemDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // FileInterceptor rejects via exceptions — but if it crashes mid-pipe
    // (e.g. the BadRequestException we threw from fileFilter), the global
    // exception filter handles it. We still need to defend against the
    // case where `file` is undefined (no `image` field at all).
    if (!file) {
      throw new BadRequestException('请上传题目图片');
    }

    try {
      return await this.problemsService.create(user.userId, dto, file);
    } catch (err) {
      // Translate known Multer errors. Anything else propagates.
      const message = multerErrorToMessage(err);
      if (message) {
        throw new BadRequestException(message);
      }
      throw err;
    }
  }

  /**
   * GET /problems/:id (JwtAuthGuard).
   *
   * 200 → `{ code: 0, data: ProblemView }`
   * 401 → token issue
   * 404 → `problem 不存在` (covers both "doesn't exist" and "not yours")
   */
  @Get(':id')
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.problemsService.getOne(user.userId, id);
  }

  /**
   * GET /problems/:id/image (JwtAuthGuard, raw binary).
   *
   * Decorated `@RawResponse()` because binary image bytes cannot be
   * JSON-wrapped by the success envelope.
   *
   * 200 → image bytes with `Content-Type` matching the original upload
   * 401 / 404 → standard `{code, message, traceId}` error envelope
   */
  @Get(':id/image')
  @RawResponse()
  async getImage(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const { stream, mime } = await this.problemsService.getImage(
      user.userId,
      id,
    );

    res.setHeader('Content-Type', mime);
    // Disable caching of authenticated images — they're user-scoped.
    res.setHeader('Cache-Control', 'private, no-store');

    // Pipe the storage stream straight to the response. We deliberately
    // do NOT await the pipe — it completes asynchronously and any errors
    // after headers are sent cannot become a JSON error body anyway.
    stream.pipe(res);
  }

  /**
   * GET /problems/:id/stream (JwtAuthGuard + StreamIdorGuard, SSE,
   * `@RawResponse()`).
   *
   * Drives the AI loop for a `pending` problem and streams the answer
   * back to the client. See `ProblemSolverService` for the full flow.
   *
   * Event schema (locked by PRD):
   *   status          → first frame, sets `solving` | `done` | ...
   *   reasoning_delta → zero or more, the model's "think" channel
   *   content_delta   → zero or more, the model's answer channel
   *   done            → final frame on success
   *   error           → on solver failure (translated to Chinese)
   *
   * 401 → inherited from JwtAuthGuard
   * 404 → `problem 不存在` (pre-stream, surfaced by the
   *       StreamIdorGuard as a standard error envelope — the guard
   *       runs BEFORE `@Sse()` opens the response, so we don't lose
   *       the status code to SSE's eager 200)
   *
   * 200 → raw SSE stream (no `{code, message, data}` envelope)
   */
  @UseGuards(StreamIdorGuard)
  @Sse(':id/stream')
  @RawResponse()
  stream(
    @CurrentUser() _user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let solverDone = false;

      // 1. Build the sink that bridges solver emissions to SSE
      //    frames. The `complete()` call is idempotent — safe to
      //    call from both the heartbeat teardown and the solver.
      const sink: SseSink = {
        emit(event: SseEventName, data: SseEventPayload) {
          if (solverDone) return;
          subscriber.next({ type: event, data });
        },
        complete() {
          if (solverDone) return;
          solverDone = true;
          subscriber.complete();
        },
      };

      // 2. 15s heartbeat. The `ping` event is a real SSE frame
      //    (not a comment line) — see the comment on
      //    `HEARTBEAT_INTERVAL_MS` for the trade-off. When the
      //    solver's stream closes, the heartbeat subscriber
      //    unsubscribes in the teardown below.
      const heartbeatSub: Subscription = interval(
        ProblemsController.HEARTBEAT_INTERVAL_MS,
      )
        .pipe(map(() => ({ type: 'ping', data: { ts: Date.now() } })))
        .subscribe({
          next: (ev) => {
            if (!solverDone) subscriber.next(ev);
          },
        });

      // 3. Kick off the solver. We swallow its Promise — expected
      //    failures (timeout, network, etc.) are all translated
      //    to SSE `error` frames inside the service, never to
      //    rejections. A rejection here is a programming bug
      //    (e.g. DB unreachable on the final transaction); log
      //    and close the stream rather than emit a partial state.
      this.problemSolverService.solve(id, sink).catch((err: unknown) => {
        this.logger.error(
          `unexpected solver rejection for problem ${id}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
        if (!solverDone) {
          solverDone = true;
          subscriber.next({
            type: 'error',
            data: { message: '解题失败，请稍后重试' },
          });
          subscriber.complete();
        }
      });

      // Teardown. Runs when:
      //   - the sink calls `subscriber.complete()` (normal end)
      //   - the client disconnects (Express closes the response)
      return () => {
        if (heartbeatSub) heartbeatSub.unsubscribe();
      };
    });
  }
}
