import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildValidationPipe } from './common/validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation: rejects payloads that don't match DTOs.
  // Config in src/common/validation.ts (shared with e2e tests).
  app.useGlobalPipes(buildValidationPipe());

  // Global error envelope — wraps every error response in {code, message, traceId}.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Success envelope is registered via APP_INTERCEPTOR in AppModule (DI-aware).

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
