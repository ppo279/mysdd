import { Transform } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

/**
 * Fields parsed from the multipart/form-data body of `POST /problems`.
 *
 * Multipart fields are ALWAYS strings on the wire — even when the client
 * sends a number. The `@Transform` hook below coerces `childId` to a
 * number BEFORE `@IsInt` runs, so `class-validator` sees a real integer
 * and can apply its integer/positive checks.
 *
 * If `childId` is non-numeric (e.g. `"abc"`), `Number("abc")` returns
 * `NaN`, which fails `@IsInt` → 400 `childId 必须是整数`.
 * If it's negative or zero, `@IsPositive` catches it → 400 `childId 必须大于 0`.
 */
export class CreateProblemDto {
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') {
      return value;
    }
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  })
  @IsInt({ message: 'childId 必须是整数' })
  @IsPositive({ message: 'childId 必须大于 0' })
  childId!: number;
}
