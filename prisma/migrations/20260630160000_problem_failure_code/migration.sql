-- (Q7) lock: classify `failed` Problems by failure path.
--
-- Two new columns on Problem:
--   - failureCode    — nullable EnumFailureCode (5 values); NULL when
--                      status != 'failed'.
--   - failureReason  — nullable TEXT; underlying exception message
--                      for debugging. NULL when status != 'failed'.
--
-- The EnumFailureCode type is created first because the column DDL
-- references it. CREATE TYPE IF NOT EXISTS isn't a thing in Postgres,
-- but the migration history is linear and we know this is the first
-- occurrence.
CREATE TYPE "EnumFailureCode" AS ENUM (
  'upload_storage_failed',
  'upload_db_update_failed',
  'image_read_failed',
  'solver_timeout',
  'solver_failed'
);

ALTER TABLE "Problem"
  ADD COLUMN "failureCode" "EnumFailureCode",
  ADD COLUMN "failureReason" TEXT;