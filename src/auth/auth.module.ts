import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    // Read JWT_SECRET + JWT_EXPIRES_IN from env (never hardcode).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // jwt-typings expects StringValue (e.g. "15m") or number (seconds).
          //
          // KNOWN GAP (tracked for Day 5 — refresh token + Redis blacklist):
          // 15m is intentionally tight. A stolen access token is now usable
          // for at most one class period instead of a full week, BUT we
          // still have NO way to revoke a token before its natural expiry
          // (no jti, no blacklist, no rotation). Day 5 closes that gap with
          // refresh tokens (issued at /auth/login alongside accessToken)
          // and a Redis denylist for compromised access tokens.
          //
          // Until then: assume any leaked access token is good for 15m.
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '15m') as
            | `${number}${'s' | 'm' | 'h' | 'd'}`
            | number
            | undefined,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
})
export class AuthModule {}