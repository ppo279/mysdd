import {
  buildSystemPrompt,
  tierForGrade,
} from '../../src/problems/problem-solver.service';

/**
 * Unit tests for the grade→prompt mapping (003 #5) and out-of-range
 * fallback (003 #2 — even though the DB CHECK constraint now
 * enforces `1..12`, the solver still has a `default` tier for
 * defensive coverage during tests or future schema drift).
 *
 * Why a unit test and not just an e2e test? Because the higher tier
 * (`grade >= 13`) cannot be reached through the e2e suite anymore:
 * the `Child.grade` CHECK constraint added in
 * `prisma/migrations/20260629110000_add_child_grade_range_check/`
 * rejects values > 12 at write time. The e2e covers the in-range
 * tiers via case #11d; this spec covers the rest.
 */
describe('buildSystemPrompt / tierForGrade', () => {
  describe('tierForGrade', () => {
    it('grades 1-6 → primary', () => {
      expect(tierForGrade(1)).toBe('primary');
      expect(tierForGrade(3)).toBe('primary');
      expect(tierForGrade(6)).toBe('primary');
    });

    it('grades 7-12 → middle', () => {
      expect(tierForGrade(7)).toBe('middle');
      expect(tierForGrade(9)).toBe('middle');
      expect(tierForGrade(12)).toBe('middle');
    });

    it('grade 13 and above → higher', () => {
      expect(tierForGrade(13)).toBe('higher');
      expect(tierForGrade(99)).toBe('higher');
    });

    it('out-of-range (≤0, non-integer, NaN) → default', () => {
      expect(tierForGrade(0)).toBe('default');
      expect(tierForGrade(-3)).toBe('default');
      expect(tierForGrade(1.5)).toBe('default');
      expect(tierForGrade(Number.NaN)).toBe('default');
    });
  });

  describe('buildSystemPrompt', () => {
    it('embeds a tier marker that the e2e test can grep for', () => {
      // The marker scheme is the contract between the solver and
      // test/problems/problems.e2e-spec.ts case #11d. Tests assert
      // `lastBody.system` contains the marker for the chosen grade.
      expect(buildSystemPrompt(1)).toContain('【小学阶段】');
      expect(buildSystemPrompt(6)).toContain('【小学阶段】');
      expect(buildSystemPrompt(7)).toContain('【中学阶段】');
      expect(buildSystemPrompt(12)).toContain('【中学阶段】');
      expect(buildSystemPrompt(13)).toContain('【高阶阶段】');
    });

    it('falls back to the default prompt for out-of-range grades', () => {
      const prompt = buildSystemPrompt(0);
      expect(prompt).toContain('【默认】');
    });

    it('every prompt contains the "答案：" summary instruction (the LLM produces it; the system prompt tells it to)', () => {
      // The system prompt instructs the model to end its response
      // with "答案：...". The instruction itself is part of every
      // tier's prompt; whether the model actually produces the
      // prefix in its OUTPUT is a separate question (covered by
      // e2e case #11a which reads `solution.content`).
      for (const grade of [1, 6, 7, 12, 13, 0, -1, 100]) {
        const prompt = buildSystemPrompt(grade);
        expect(prompt).toContain('答案：');
      }
    });
  });
});
