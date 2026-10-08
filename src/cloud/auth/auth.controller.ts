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
import { handleException } from '../utils/handleException';

@Controller('api/cloud/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setAuthCookies(res: Response, tokens: LoginResponse) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('access_token', tokens.token, {
      path: '/',
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 15,
    });
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
      const result = await this.authService.validateUser(
        request,
        typeof ua === 'string' ? ua : undefined,
      );
      this.setAuthCookies(res, result);
      return new CommonResponse('Login Successful', HttpStatus.OK, result);
    } catch (err) {
      return handleException(err);
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
      const bodyToken = body?.refreshToken;
      const tokenToVerify = cookieToken || bodyToken;
      if (!tokenToVerify) throw new UnauthorizedException('Refresh token not found');
      const result = await this.authService.refreshToken(tokenToVerify);
      this.setAuthCookies(res, result);
      return new CommonResponse('Token refreshed successfully', HttpStatus.OK, result);
    } catch (err) {
      this.clearAuthCookies(res);
      if (err instanceof UnauthorizedException) throw err;
      return handleException(err);
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
      const token = cookieToken || body?.refreshToken;
      if (token) await this.authService.revokeToken(token);
      this.clearAuthCookies(res);
      return new CommonResponse('Logged out successfully', HttpStatus.OK, 'Logged out successfully');
    } catch (err) {
      return handleException(err);
    }
  }

  @UseGuards(AuthGuard)
  @Get('user-info')
  async getUserInfo(@Req() request: Request) {
    const user = request['user'] as { nik: string };
    const userInfo = await this.authService.userInfo(user.nik);
    return new CommonResponse('Welcome', HttpStatus.OK, userInfo);
  }

  @UseGuards(AuthGuard)
  @Get('upload-ticket')
  async getUploadTicket(@Req() request: Request) {
    const user = request['user'] as { nik: string; nama: string; roleId: string };
    const token = await this.authService.issueUploadTicket({
      nik: user.nik,
      nama: user.nama,
      roleId: user.roleId,
    });
    return new CommonResponse('Upload ticket issued', HttpStatus.OK, {
      token,
      expiresIn: 900,
    });
  }
}
