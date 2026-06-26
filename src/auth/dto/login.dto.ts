import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Identical shape to RegisterDto — but separate class so future changes
 * (e.g. adding 2FA fields only at login) don't force register to change.
 */
export class LoginDto {
  @IsString({ message: '邮箱必须是字符串' })
  @IsNotEmpty({ message: '邮箱不能为空' })
  @MaxLength(255, { message: '邮箱长度不能超过 255' })
  @IsEmail({}, { message: '邮箱格式不正确，请检查 @ 和域名' })
  email!: string;

  @IsString({ message: '密码必须是字符串' })
  @IsNotEmpty({ message: '密码不能为空' })
  @MinLength(8, { message: '密码至少 8 位' })
  @IsStrongPassword(
    {
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 0,
    },
    {
      message:
        '密码强度不够：至少 8 位，且包含大小写字母和数字（特殊字符可选）',
    },
  )
  password!: string;
}
