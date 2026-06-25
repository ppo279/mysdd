import { BadRequestException, ValidationPipe } from '@nestjs/common';

/**
 * Shared ValidationPipe factory.
 *
 * Use this from BOTH `src/main.ts` (production) and test bootstraps so
 * the error format is identical in both — otherwise tests can pass while
 * production users see a different shape.
 *
 * Behavior:
 * - whitelist + forbidNonWhitelisted: drop/reject unknown fields
 * - transform: instantiate DTO classes so decorators run
 * - exceptionFactory: format validation errors as a single newline-joined
 *   Chinese string (`email：邮箱格式不正确\npassword：密码强度不够`),
 *   instead of Nest's default nested array.
 */
export const buildValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => {
      const messages = errors
        .map((err) => {
          const field = err.property;
          const reasons = Object.values(err.constraints ?? {})
            .map((m) => m)
            .join('；');
          return `${field}：${reasons}`;
        })
        .join('\n');
      return new BadRequestException(messages);
    },
  });
