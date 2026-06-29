import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * DTO for `GET /children` query string.
 *
 * Query string values are always strings on the wire. We use
 * `@Type(() => Number)` (from class-transformer) to coerce before
 * `@IsInt` runs — without it, `?page=2` arrives as the string `"2"`
 * and `@IsInt` rejects it.
 *
 * Both fields are `@IsOptional`: Nest's global ValidationPipe with
 * `transform: true` (see `buildValidationPipe()`) leaves `undefined`
 * values alone, and the service falls back to its own defaults
 * (page=1, pageSize=20) so the client never gets a 400 for omitting
 * either param.
 *
 * The `pageSize <= 100` ceiling is enforced here rather than the
 * service so the rejection surfaces as a clean 400 with a Chinese
 * message (matching the rest of the API), instead of an `Internal`
 * `ServerError` from a custom service-side check.
 */
export class ListChildrenQueryDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 必须大于等于 1' })
  page?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 必须大于等于 1' })
  @Max(100, { message: 'pageSize 必须小于等于 100' })
  pageSize?: number;
}
