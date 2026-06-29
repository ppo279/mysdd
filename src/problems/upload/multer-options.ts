import { BadRequestException } from '@nestjs/common';
// NOTE: `MulterOptions` is NOT re-exported from the
// `@nestjs/platform-express/multer/interfaces` barrel as of Nest 11.
// Import from the concrete file. Other call sites inside Nest
// (e.g. `file.interceptor.d.ts`) use the same deep import.
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

/**
 * Upload-layer concerns for the Problems module — extracted into a
 * standalone file so the controller body stays focused on routing
 * and the upload rules are reviewable in one place.
 *
 * Source of truth for all upload-related constants and error mappings
 * lives here. The controller imports `problemImageMulterOptions` and
 * `multerErrorToMessage`; nothing else.
 */

/**
 * 10 MB upper bound on the uploaded image. Locked by PRD; see
 * `docs/prd/problems.md` §"MIME 白名单" and §"文件大小上限".
 */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Locked MIME whitelist. The Multer `fileFilter` rejects anything else
 * BEFORE the file buffer reaches the controller, so `ProblemsService`
 * never has to second-guess the type.
 */
export const ALLOWED_MIME: ReadonlySet<string> = new Set([
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
export function multerErrorToMessage(err: unknown): string | null {
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
 * FileInterceptor options for the problem image upload.
 *
 * The `fileFilter` is intentionally strict: a non-whitelisted MIME
 * results in a Chinese 400 BEFORE any bytes are buffered, saving the
 * user the cost of waiting for an oversize upload that we'd reject
 * anyway.
 *
 * The `limits.fileSize` cap runs in parallel — a 11 MB file is rejected
 * with `LIMIT_FILE_SIZE` regardless of its MIME.
 */
export const problemImageMulterOptions: MulterOptions = {
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
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
};
