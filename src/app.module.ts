import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';
import { WrapResponseInterceptor } from './common/interceptors/wrap-response.interceptor';
import { AuthModule } from './auth/auth.module';
import { ChildrenModule } from './children/children.module';
import { HealthController } from './health.controller';
import { AnthropicModule } from './integrations/anthropic/anthropic.module';
import { JanitorModule } from './janitor/janitor.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProblemsModule } from './problems/problems.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    // Both lifted to `@Global()` on 2026-06-29 (issue 003/4).
    // Imported once here for global registration; feature modules can
    // inject their tokens without re-importing.
    StorageModule,
    AnthropicModule,
    // Janitor cron (issue 009). `@Global()` itself; registered once
    // here. Background sweep starts on `OnModuleInit` — see
    // `JanitorService` for the interval + first-tick semantics.
    JanitorModule,
    ProblemsModule,
    // Children CRUD — see docs/prd/children.md. Imports AuthModule
    // for JwtAuthGuard; PrismaService comes from the global PrismaModule.
    ChildrenModule,
  ],
  controllers: [HealthController],
  providers: [
    // DI-aware registration: Nest injects Reflector into the interceptor.
    { provide: APP_INTERCEPTOR, useClass: WrapResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // TraceIdMiddleware must run on every route so the X-Trace-Id
    // response header is always present and req.traceId is set before
    // any filter or interceptor touches the request.
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
