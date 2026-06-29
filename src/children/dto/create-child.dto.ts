import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * DTO for `POST /children`.
 *
 * The 1..12 range mirrors the DB CHECK constraint added in
 * `prisma/migrations/20260629110000_add_child_grade_range_check/`.
 * Both layers must agree: the DTO rejects bad payloads at the API
 * boundary (clean 400), the DB rejects direct-write bypasses
 * (defense in depth).
 *
 * `@IsNotEmpty` on `name` catches the empty-string case that
 * `@MaxLength(50)` alone lets through (`''` is 0 chars, under the
 * limit but semantically useless).
 */
export class CreateChildDto {
  @IsString({ message: 'name 必须是字符串' })
  @IsNotEmpty({ message: 'name 不能为空' })
  @MaxLength(50, { message: 'name 长度不能超过 50' })
  name!: string;

  @IsInt({ message: 'grade 必须是整数' })
  @Min(1, { message: 'grade 必须大于等于 1' })
  @Max(12, { message: 'grade 必须小于等于 12' })
  grade!: number;
}
