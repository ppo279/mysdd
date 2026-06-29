import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { ChildrenService } from './children.service';
import { CreateChildDto } from './dto/create-child.dto';
import { ListChildrenQueryDto } from './dto/list-children-query.dto';

/**
 * ChildrenController — 4 endpoints, all behind `JwtAuthGuard`.
 *
 * Success responses are wrapped by the global `WrapResponseInterceptor`
 * into `{ code: 0, message: 'ok', data: T }` automatically. Errors
 * (400/401/404/409) go through the global `AllExceptionsFilter` and
 * come back as `{ code, message, traceId }`. The DELETE endpoint
 * opts out of the success envelope with `@RawResponse()` (see that
 * method's docstring for why).
 *
 * `@UseGuards(JwtAuthGuard)` is applied at the class level so every
 * handler inherits it. Individual methods don't need to repeat it.
 */
@Controller('children')
@UseGuards(JwtAuthGuard)
export class ChildrenController {
  constructor(private readonly childrenService: ChildrenService) {}

  /**
   * POST /children
   *
   * Body: `{ name: string, grade: 1..12 }`
   *
   * 201 → `{ code: 0, data: { id, name, grade, createTime } }`
   * 400 → validation error (Chinese message)
   * 401 → missing/invalid token
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateChildDto) {
    return this.childrenService.create(user.userId, dto);
  }

  /**
   * GET /children?page=1&pageSize=20
   *
   * 200 → `{ code: 0, data: { items: ChildView[], total, page, pageSize } }`
   * 400 → non-integer page / pageSize / pageSize > 100
   * 401 → missing/invalid token
   */
  @Get()
  async list(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListChildrenQueryDto,
  ) {
    // Service-side defaults match the DTO's intent (page=1, pageSize=20).
    // The DTO is `@IsOptional` on both fields, so missing params land
    // here as `undefined`.
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return this.childrenService.list(user.userId, page, pageSize);
  }

  /**
   * GET /children/:id
   *
   * 200 → `{ code: 0, data: ChildView }`
   * 400 → `:id` not an integer (ParseIntPipe)
   * 401 → missing/invalid token
   * 404 → `child 不存在` (covers both "doesn't exist" and "not yours")
   */
  @Get(':id')
  async getOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.childrenService.getOne(user.userId, id);
  }

  /**
   * DELETE /children/:id
   *
   * `@RawResponse()` so 204 has no `{code, message, data}` envelope
   * (REST convention: 204 = "fulfilled, no body needed"; the
   * envelope's `data: null` would add zero information density).
   * Error paths (404, 409, 401, 400) still go through the global
   * `AllExceptionsFilter` and DO carry the envelope — the opt-out
   * only applies to success.
   *
   * 204 → no body
   * 400 → `:id` not an integer
   * 401 → missing/invalid token
   * 404 → `child 不存在` (IDOR miss)
   * 409 → `该孩子存在题目，无法删除`
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RawResponse()
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.childrenService.remove(user.userId, id);
  }
}
