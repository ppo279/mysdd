import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import type { JwtPayload } from './guards/jwt-auth.guard';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Register a new parent account.
   *
   * Throws:
   * - ConflictException (409) if email already exists
   * - InternalServerErrorException (500) on unexpected DB errors
   */
  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
        },
        select: {
          id: true,
          email: true,
          createTime: true,
        },
      });
      return user;
    } catch (err) {
      // Prisma error code P2002 = unique constraint violation
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException(
          `邮箱 ${dto.email} 已被注册，请直接登录或换一个`,
        );
      }
      // Anything else is a real server error
      throw new InternalServerErrorException('注册失败，请稍后再试');
    }
  }

  /**
   * Verify credentials and issue an access token.
   *
   * Throws UnauthorizedException (401) for ANY credential failure —
   * we deliberately do NOT distinguish "user not found" vs "wrong password"
   * to prevent email enumeration.
   */
  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, passwordHash: true },
    });

    // Same error message in both branches to avoid leaking which is wrong.
    const invalid = new UnauthorizedException('邮箱或密码错误');

    if (!user) {
      // Still run a bcrypt compare to keep response time roughly constant.
      // (Without this, an attacker can tell which emails exist by timing.)
      await bcrypt.compare(dto.password, '$2b$12$............................................................');
      throw invalid;
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw invalid;

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
    };
    const accessToken = await this.jwt.signAsync(payload);
    return { accessToken };
  }

  /**
   * Return the current user profile (used by GET /auth/me).
   * Re-fetches from DB so deleted/updated users are reflected immediately.
   */
  async me(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, createTime: true },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    return user;
  }
}