import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';
import { WrapResponseInterceptor } from './common/interceptors/wrap-response.interceptor';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { ProblemsModule } from './problems/problems.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    StorageModule,
    ProblemsModule,
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
