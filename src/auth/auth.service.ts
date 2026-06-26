import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import type { JwtPayload } from './jwt-payload';

const BCRYPT_ROUNDS = 12;

/**
 * Pre-computed bcrypt hash used purely for **timing equalization** when a
 * login attempt targets a non-existent email. We compare against THIS hash
 * (not against a hand-typed placeholder like "$2b$12$......") because:
 *
 * 1. It's a structurally valid bcrypt hash (53-char body + 7-char prefix),
 *    so it works across bcrypt implementations (native `bcrypt`, `bcryptjs`,
 *    future versions) instead of relying on the implementation tolerating
 *    malformed input.
 * 2. It was hashed at BCRYPT_ROUNDS = 12, exactly matching real hashes —
 *    no risk of an "optimization" path short-circuiting on length.
 * 3. Computing it once at module-load time (~250ms, one-time startup cost)
 *    is cheaper than computing it on every not-found login.
 *
 * Interview one-liner:
 *   "I didn't hard-code a placeholder hash; I pre-generated a real one at
 *    the same cost factor, so timing equalization doesn't depend on any
 *    particular bcrypt implementation being lenient about malformed input."
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

@Injectable()
export class AuthService {
  // Class-scoped Logger — log lines get the `[AuthService]` prefix for free,
  // which is what makes grep across services in production actually usable.
  private readonly logger = new Logger(AuthService.name);

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
      // Anything else is a real server error.
      //
      // Log the ORIGINAL error before throwing — otherwise the catch
      // swallows the root cause and on-call only sees the generic 500
      // text. Stack + Prisma code are the actual debugging signal.
      //
      // Context intentionally EXCLUDES dto.email: it's PII (ends up in
      // log storage forever) and it's not the cause — the cause lives in
      // the Prisma layer. The Chinese user-facing message keeps the
      // email; the log line does not.
      this.logger.error(
        'Unexpected error during user registration',
        err instanceof Error ? err.stack : String(err),
      );
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
      // Run a real bcrypt.compare against DUMMY_HASH so the not-found path
      // takes the same time as the wrong-password path. See DUMMY_HASH
      // comment above for the why.
      await bcrypt.compare(dto.password, DUMMY_HASH);
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