import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { CreateProblemDto } from './dto/create-problem.dto';
import { ProblemsService } from './problems.service';

/**
 * 10 MB upper bound on the uploaded image. Locked by PRD; see
 * `docs/prd/problems.md` §"MIME 白名单" and §"文件大小上限".
 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Locked MIME whitelist. The Multer `fileFilter` rejects anything else
 * BEFORE the file buffer reaches the controller, so `ProblemsService`
 * never has to second-guess the type.
 */
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * Map Multer's English `MulterError.code` to the locked Chinese messages
 * (see `docs/prd/problems.md` §"Error messages (locked)"). We only
 * translate what we configured; any other Multer error falls through to
 * the global exception filter's 500 handling.
 */
function multerErrorToMessage(err: unknown): string | null {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    'field' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    const code = (err as { code: string }).code;
    const field = (err as { field: string }).field;
    if (code === 'LIMIT_FILE_SIZE') return '图片过大，最大 10MB';
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return `请上传题目图片`;
    }
    // Should not happen with our config, but log defensively.
    return `上传失败 (${code}, field=${field})`;
  }
  return null;
}

/**
 * (Helper kept minimal — see `multerErrorToMessage` above. Any error from
 * FileInterceptor that doesn't match the locked codes is re-thrown so the
 * global exception filter handles it as a 500.)
 */

@Controller('problems')
@UseGuards(JwtAuthGuard)
export class ProblemsController {
  constructor(private readonly problemsService: ProblemsService) {}

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
  @UseInterceptors(
    FileInterceptor('image', {
      // 10 MB hard cap. The fileFilter below rejects bad MIMEs before any
      // bytes are buffered for an oversize file? No — multer buffers first,
      // then checks size. That's why we still set both.
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      // Multer calls this for each part. We accept the file (return true)
      // only if the MIME is on our whitelist; anything else becomes a
      // `LIMIT_UNEXPECTED_FILE` error translated above.
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) {
          cb(null, true);
          return;
        }
        // Pass a Chinese message so the user sees the locked copy.
        cb(
          new BadRequestException(
            `不支持的图片格式: ${file.mimetype}，仅允许 JPEG/PNG/GIF/WEBP`,
          ),
          false,
        );
      },
    }),
  )
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
}
