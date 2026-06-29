import { multerErrorToMessage } from '../../../src/problems/upload/multer-options';

/**
 * Unit tests for the Multer → Chinese error translation used by the
 * upload endpoint. The e2e suite already exercises the success path
 * (no error) and the size/MIME paths indirectly; this spec pins down
 * the translation function in isolation, including the "non-Multer
 * error" branch the e2e cannot easily reach.
 *
 * Locked source-of-truth: `docs/prd/problems.md` §"Error messages
 * (locked)" + the function body in `src/problems/upload/multer-options.ts`.
 */
describe('multerErrorToMessage', () => {
  it('translates LIMIT_FILE_SIZE to "图片过大，最大 10MB"', () => {
    // Shape mirrors what multer actually throws — the function checks
    // `code` and `field` are both present and that `code` is a string.
    const err = { code: 'LIMIT_FILE_SIZE', field: 'image' };
    expect(multerErrorToMessage(err)).toBe('图片过大，最大 10MB');
  });

  it('translates LIMIT_UNEXPECTED_FILE to "请上传题目图片"', () => {
    // We reuse the missing-field message for unexpected field names —
    // both are user-facing signals that the upload itself was wrong.
    const err = { code: 'LIMIT_UNEXPECTED_FILE', field: 'images' };
    expect(multerErrorToMessage(err)).toBe('请上传题目图片');
  });

  it('falls back to a generic "上传失败 (code, field=...)" for unknown Multer codes', () => {
    // The fallback exists so a future Multer code (e.g. LIMIT_PARTIAL)
    // surfaces a recognizable error string instead of bubbling a raw
    // English message to the user.
    const err = { code: 'LIMIT_PARTIAL', field: 'image' };
    expect(multerErrorToMessage(err)).toBe(
      '上传失败 (LIMIT_PARTIAL, field=image)',
    );
  });

  it('returns null when the input is not a Multer-shaped error', () => {
    // The controller's catch only translates when multerErrorToMessage
    // returns a non-null string — a plain Error (e.g. a programmer
    // throw) must pass through unchanged so the global exception
    // filter can deal with it.
    expect(multerErrorToMessage(new Error('boom'))).toBeNull();
    expect(multerErrorToMessage(null)).toBeNull();
    expect(multerErrorToMessage(undefined)).toBeNull();
    expect(multerErrorToMessage('a string is not a multer error')).toBeNull();
    // And the "looks like an object but missing `code`/`field`"
    // branch — defensive against accidental shape matches.
    expect(multerErrorToMessage({})).toBeNull();
    expect(multerErrorToMessage({ code: 'LIMIT_FILE_SIZE' })).toBeNull();
  });
});
