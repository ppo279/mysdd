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
          // jwt-typings expects StringValue (e.g. "7d") or number (seconds).
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') as
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