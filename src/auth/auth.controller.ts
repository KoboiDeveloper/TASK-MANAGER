import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { CommonResponse } from '../common/commonResponse';
import { LoginRequest } from './dto/request/loginRequest';
import { LoginResponse } from './dto/response/loginResponse';
import { AuthGuard } from '../security/authGuard';
import { DT_USER } from '@prisma/client';
import { ForgotPwRequest } from './dto/request/forgotPwRequest';
import { ResetPwRequest } from './dto/request/resetPwRequest';
import { handleException } from '../utils/handleException';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() request: LoginRequest, @Res({ passthrough: true }) res: Response) {
    try {
      const result: LoginResponse = await this.authService.validateUser(request);

      res.cookie('access_token', result.token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 24, // 1 day
      });

      return new CommonResponse('Login Successful', HttpStatus.OK, 'Login Successful');
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
  @UseGuards(AuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    try {
      res.clearCookie('access_token', {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
      });

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
  getUserInfo(@Req() request: Request) {
    const user = request['user'] as DT_USER;
    const { nik, nama, roleId } = user;
    return new CommonResponse('Welcome', HttpStatus.OK, { nik, nama, roleId });
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
