import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildValidationPipe } from './common/validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation: rejects payloads that don't match DTOs.
  // Config in src/common/validation.ts (shared with e2e tests).
  app.useGlobalPipes(buildValidationPipe());

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();