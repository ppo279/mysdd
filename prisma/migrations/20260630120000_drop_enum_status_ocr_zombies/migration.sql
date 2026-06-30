-- 004: drop zombie EnumStatus values `ocr_processing` / `ocr_done`.
--
-- Rationale: CONTEXT.md §1.1 — `MiniMax-M3` is multimodal, no OCR
-- stage. Application code uses only `pending` / `solving` / `done` /
-- `failed` (zero references to the two zombies in `src/` or `test/`).
-- The two values lingered in the schema as a "if OCR is ever revived"
-- safety valve, but they leak the wrong API surface to contributors
-- and are unverifiable at the type system level.
--
-- PG ENUM does not support `ALTER TYPE ... DROP VALUE`. The only
-- safe path is a full enum rebuild: rename → new → alter column →
-- drop old. The `USING` cast routes through `text` because new and
-- old enum types have different OIDs and PG will not implicitly cast.
--
-- Precondition: no Problem row may be in a zombie state. If any
-- stray row exists (e.g. from manual SQL in dev or staging), this
-- migration FAILS LOUDLY rather than silently dropping data. Run
-- `UPDATE "Problem" SET status = 'failed' WHERE status IN (...)` or
-- delete the rows by hand, then re-apply.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Problem"
    WHERE "status"::text NOT IN ('pending', 'solving', 'done', 'failed')
  ) THEN
    RAISE EXCEPTION
      'EnumStatus zombie rows exist; clean manually before this migration';
  END IF;
END $$;

-- 1. Rename the old enum so we can reuse the name.
ALTER TYPE "EnumStatus" RENAME TO "EnumStatus_old";

-- 2. Create the new enum with only the 4 valid values.
CREATE TYPE "EnumStatus" AS ENUM ('pending', 'solving', 'done', 'failed');

-- 3. Migrate the column. PG does not allow combining DROP DEFAULT /
--    TYPE / SET DEFAULT in a single ALTER COLUMN clause (commas are
--    only valid between homogeneous sub-commands), so we issue three
--    separate ALTER TABLE statements. The DEFAULT must be re-bound
--    because the old DEFAULT referenced the old enum's OID.
ALTER TABLE "Problem" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Problem"
  ALTER COLUMN "status" TYPE "EnumStatus"
    USING "status"::text::"EnumStatus";
ALTER TABLE "Problem" ALTER COLUMN "status" SET DEFAULT 'pending';

-- 4. Drop the old enum. Safe because no column references it.
DROP TYPE "EnumStatus_old";
