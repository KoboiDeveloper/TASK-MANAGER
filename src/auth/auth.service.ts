import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { comparePassword, encodePassword } from '../utils/bcrypt';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { JwtService } from '@nestjs/jwt';
import { ForgotPwRequest } from './dto/request/forgotPwRequest';
import { ResetPwRequest } from './dto/request/resetPwRequest';
import { MailService } from '../utils/mail/mail.service';
import { SuspendedUserException } from '../utils/suspendExecption';

interface JwtPayload {
  nik: string;
  nama: string;
  roleId: string;
  accessStores: string[];
  accessRegions: string[];
}

interface IAuthService {
  validateUser(data: LoginRequest): Promise<LoginResponse>;
  sendForgotPw(data: ForgotPwRequest): Promise<string>;
  resetPw(data: ResetPwRequest): Promise<string>;
}

@Injectable()
export class AuthService implements IAuthService {
  constructor(
    private prismaService: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
  ) {}
  async validateUser(data: LoginRequest): Promise<LoginResponse> {
    const user = await this.prismaService.dT_USER.findUnique({
      where: { nik: data.nik },
      include: {
        accessStoreIds: { select: { storeId: true } },
        accessRegionIds: { select: { regionId: true } },
      },
    });

    if (!user || !(await comparePassword(data.password, user.password))) {
      throw new UnauthorizedException('Bad credentials');
    }

    if (!user.statusActive) {
      throw new SuspendedUserException();
    }

    const payload: JwtPayload = {
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
      accessStores: user.accessStoreIds.map((s) => s.storeId),
      accessRegions: user.accessRegionIds.map((r) => r.regionId),
    };

    const token = await this.jwtService.signAsync(payload);
    return { token };
  }

  async sendForgotPw({ email }: ForgotPwRequest): Promise<string> {
    const user = await this.prismaService.dT_USER.findFirstOrThrow({ where: { email } });
    if (!user.email) throw new BadRequestException('Email tidak tersedia');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const token = this.jwtService.sign(
      { otp },
      {
        expiresIn: '15m',
        secret: process.env.SECRET_KEY,
        issuer: process.env.ISSUER_STAMP,
      },
    );

    await this.prismaService.lOG_FORGOT_PASSWORD.create({
      data: { otp, nik: user.nik, expiresAt },
    });
    await this.mailService.sendResetPasswordEmail(user.email, token, otp);

    return 'Reset code sent via email';
  }

  async resetPw({ otp, newPassword }: ResetPwRequest): Promise<string> {
    const whorequest = await this.prismaService.lOG_FORGOT_PASSWORD.findUnique({ where: { otp } });

    if (!whorequest || whorequest.used || new Date() > new Date(whorequest.expiresAt)) {
      throw new BadRequestException('OTP is invalid or expired');
    }

    const password = encodePassword(newPassword);

    await this.prismaService.$transaction([
      this.prismaService.dT_USER.update({ where: { nik: whorequest.nik }, data: { password } }),
      this.prismaService.lOG_FORGOT_PASSWORD.update({ where: { otp }, data: { used: true } }),
    ]);

    return 'Change Password Successfully';
  }
}
