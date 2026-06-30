import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { $Enums } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * E2E tests for the `EnumStatus` shape.
 *
 * Why: the OCR pipeline was cancelled (CONTEXT §1.1, PRD `docs/prd/
 * problems.md`). The Prisma schema declared six `EnumStatus` values
 * of which only four are actually used by the application code:
 *   pending / solving / done / failed.
 * The other two (`ocr_processing`, `ocr_done`) are "zombie" values
 * PG cannot drop from a real enum (no `ALTER TYPE ... DROP VALUE`).
 *
 * These tests lock in the invariant that the zombie values are
 * absent at BOTH layers:
 *   1. Postgres (pg_enum)  — runtime contract
 *   2. Prisma client       — type contract via `Prisma.$Enums`
 *
 * Future schema edits that re-introduce zombies will fail RED at
 * e2e time, before code reaches production.
 *
 * Strategy: real Postgres (the dev container). No fixture data
 * needed — these tests only introspect the catalog tables.
 */

const EXPECTED_VALUES = ['pending', 'solving', 'done', 'failed'] as const;
const ZOMBIE_VALUES = ['ocr_processing', 'ocr_done'] as const;

describe('Schema: EnumStatus shape (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────
  // DB layer: pg_type + pg_enum
  // ─────────────────────────────────────────────────────────────
  describe('DB enum (pg_type + pg_enum)', () => {
    it('EnumStatus has exactly the 4 valid labels, no zombies', async () => {
      const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT enumlabel
        FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE typname = 'EnumStatus'
      `;

      const labels = new Set(rows.map((r) => r.enumlabel));

      // Set equality: order-independent. Catches both "added a value"
      // and "removed a valid value" regressions in one assertion.
      expect(labels).toEqual(new Set(EXPECTED_VALUES));

      // Defense in depth: explicit "zombie gone" check. If the set
      // assertion above is later relaxed, this still trips.
      for (const zombie of ZOMBIE_VALUES) {
        expect(labels.has(zombie)).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Prisma client layer: $Enums.EnumStatus
  // ─────────────────────────────────────────────────────────────
  describe('Prisma client $Enums.EnumStatus', () => {
    it('contains exactly the 4 valid keys, no zombies', () => {
      // prisma-client-js generates `$Enums.EnumStatus` as a runtime
      // object whose keys are the enum value names. This catches a
      // "edited schema.prisma but forgot to run `prisma generate`"
      // regression that the DB-layer test would miss while migrations
      // are pending.
      const keys = Object.keys($Enums.EnumStatus).sort();
      expect(keys).toEqual([...EXPECTED_VALUES].sort());

      // Defense in depth: explicit "zombie gone" check.
      for (const zombie of ZOMBIE_VALUES) {
        expect(keys).not.toContain(zombie);
      }
    });
  });
});
