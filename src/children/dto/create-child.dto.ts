import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * DTO for creating a Child row.
 *
 * Status: DRAFT (003 #2). The `ChildrenModule` is a separate PRD
 * (not yet started); this DTO is the source of truth for the
 * `grade` range that the eventual `POST /children` endpoint will
 * accept. It is NOT yet wired into any controller — the e2e
 * tests in `test/problems/` create children via `prisma.child.create`
 * directly, which is the established pattern until ChildrenModule
 * lands (see `docs/prd/problems.md` §"Prerequisites").
 *
 * The 1..12 range mirrors the DB CHECK constraint added in
 * `prisma/migrations/20260629110000_add_child_grade_range_check/`.
 * Both layers must agree: the DTO rejects bad payloads at the API
 * boundary (clean 400), the DB rejects direct-write bypasses
 * (defense in depth).
 */
export class CreateChildDto {
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(50, { message: 'name 长度不能超过 50' })
  name!: string;

  @IsInt({ message: 'grade 必须是整数' })
  @Min(1, { message: 'grade 必须大于等于 1' })
  @Max(12, { message: 'grade 必须小于等于 12' })
  grade!: number;
}
