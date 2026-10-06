import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { CommonResponse } from '../common/commonResponse';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { RefreshTokenRequest } from './dto/request/refreshTokenRequest';
import { AuthGuard } from '../security/authGuard';
import { DT_USER } from '@prisma/client';
import { ForgotPwRequest } from './dto/request/forgotPwRequest';
import { ResetPwRequest } from './dto/request/resetPwRequest';
import { handleException } from '../utils/handleException';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setAuthCookies(res: Response, tokens: LoginResponse) {
    const isProd = process.env.NODE_ENV === 'production';

    // Access Token: 15 menit
    res.cookie('access_token', tokens.token, {
      path: '/',
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 15,
    });

    // Refresh Token: 7 hari
    if (tokens.refreshToken) {
      res.cookie('refresh_token', tokens.refreshToken, {
        path: '/',
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    }
  }

  private clearAuthCookies(res: Response) {
    const isProd = process.env.NODE_ENV === 'production';
    const clearOpts = {
      path: '/',
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax' as const,
    };
    res.clearCookie('access_token', clearOpts);
    res.clearCookie('refresh_token', clearOpts);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() request: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const ua = req.headers['user-agent'];
      const result: LoginResponse = await this.authService.validateUser(
        request,
        typeof ua === 'string' ? ua : undefined,
      );
      this.setAuthCookies(res, result);

      return new CommonResponse('Login Successful', HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Body() body: RefreshTokenRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const cookieToken = (req.cookies as Record<string, string>)?.['refresh_token'];
      const headerToken =
        (req.headers['x-refresh-token'] as string) ||
        (req.headers['authorization']?.startsWith('Bearer ')
          ? req.headers['authorization'].slice(7).trim()
          : undefined);
      const bodyToken = body?.refreshToken;

      const tokenToVerify = cookieToken || headerToken || bodyToken;

      if (!tokenToVerify) {
        throw new UnauthorizedException('Refresh token not found');
      }

      const result = await this.authService.refreshToken(tokenToVerify);
      this.setAuthCookies(res, result);

      return new CommonResponse('Token refreshed successfully', HttpStatus.OK, result);
    } catch (err) {
      // Clear cookies on refresh failure (e.g. reuse detected or token expired)
      this.clearAuthCookies(res);
      if (err instanceof UnauthorizedException || err?.status === 401) {
        throw err;
      }
      return handleException((err as Error).message);
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Body() body: RefreshTokenRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const cookieToken = (req.cookies as Record<string, string>)?.['refresh_token'];
      const headerToken =
        (req.headers['x-refresh-token'] as string) ||
        (req.headers['authorization']?.startsWith('Bearer ')
          ? req.headers['authorization'].slice(7).trim()
          : undefined);
      const bodyToken = body?.refreshToken;
      const token = cookieToken || headerToken || bodyToken;

      if (token) {
        await this.authService.revokeToken(token);
      }

      this.clearAuthCookies(res);

      return new CommonResponse(
        'Logged out successfully',
        HttpStatus.OK,
        'Logged out successfully',
      );
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @UseGuards(AuthGuard)
  @Get('user-info')
  async getUserInfo(@Req() request: Request) {
    const user = request['user'] as DT_USER;
    const userInfo = await this.authService.userInfo(user.nik);
    return new CommonResponse('Welcome', HttpStatus.OK, userInfo);
  }

  @Post('forgot-password')
  async sendOtpResetPw(@Body() request: ForgotPwRequest) {
    try {
      const result = await this.authService.sendForgotPw(request);
      return new CommonResponse('Check your email', HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Post('reset-password')
  async resetPw(@Body() request: ResetPwRequest) {
    try {
      const result = await this.authService.resetPw(request);
      return new CommonResponse(result, HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}
