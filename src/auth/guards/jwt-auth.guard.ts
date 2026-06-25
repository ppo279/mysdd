import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';

/**
 * Shape of the JWT payload we issue.
 * Keep this minimal — anything you put here is publicly decodable.
 */
export interface JwtPayload {
  /** numeric user id */
  userId: number;
  /** user's email (handy for logs, not security-critical) */
  email: string;
}

/**
 * Validates the `Authorization: Bearer <token>` header.
 *
 * On success, attaches `req.user = JwtPayload` so downstream handlers
 * (and the @CurrentUser decorator) can read it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 Authorization Bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Authorization token 为空');
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      // Attach for downstream handlers / @CurrentUser()
      (req as Request & { user: JwtPayload }).user = payload;
      return true;
    } catch {
      // jwt.verifyAsync throws on expired / malformed / bad signature.
      // We deliberately swallow the original error to avoid leaking which
      // case (expired vs tampered) triggered the failure.
      throw new UnauthorizedException('token 无效或已过期，请重新登录');
    }
  }
}