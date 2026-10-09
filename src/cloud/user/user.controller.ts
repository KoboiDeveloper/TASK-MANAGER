import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserService } from './user.service';
import { AuthGuard } from '../security/authGuard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { ERole } from '../constant/ERole';
import { CommonResponse } from '../common/commonResponse';
import { RegisterRequest } from './dto/request/registerRequest';
import { UpdateQuotaRequest } from './dto/request/updateQuotaRequest';
import { UpdateUserRequest } from './dto/request/updateUserRequest';
import { ResetPasswordRequest } from './dto/request/resetPasswordRequest';
import { handleException } from '../utils/handleException';

@Controller('api/cloud/users')
@UseGuards(AuthGuard, RolesGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @Roles(ERole.SUPER, ERole.ADMIN)
  async list(@Query('search') search?: string) {
    try {
      const users = await this.userService.findAll(search);
      return new CommonResponse('OK', HttpStatus.OK, users);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('search')
  async search(@Query('q') q: string) {
    try {
      const users = await this.userService.search(q || '');
      return new CommonResponse('OK', HttpStatus.OK, users);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('hris')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async hris(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    try {
      const limitNum = Math.min(Number(limit) || 10, 50);
      const pageNum = Math.max(Number(page) || 1, 1);
      const offset = (pageNum - 1) * limitNum;
      const result = await this.userService.searchHris(search, limitNum, offset);
      return new CommonResponse('HRIS List', HttpStatus.OK, result);
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('sync-from-pm')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async syncFromPm() {
    try {
      const result = await this.userService.syncFromProjectManager();
      return new CommonResponse(
        `Synced ${result.created} new, ${result.updated} updated from Task Manager`,
        HttpStatus.OK,
        result,
      );
    } catch (err) {
      return handleException(err);
    }
  }

  @Post('add')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async add(@Body() body: RegisterRequest) {
    try {
      const user = await this.userService.create(body);
      return new CommonResponse('User created', HttpStatus.OK, user);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':nik')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async update(@Param('nik') nik: string, @Body() body: UpdateUserRequest) {
    try {
      const user = await this.userService.updateUser(nik, body);
      return new CommonResponse('User updated', HttpStatus.OK, user);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':nik/quota')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async updateQuota(@Param('nik') nik: string, @Body() body: UpdateQuotaRequest) {
    try {
      const quota = await this.userService.updateQuota(nik, body.limitBytes);
      return new CommonResponse('Quota updated', HttpStatus.OK, quota);
    } catch (err) {
      return handleException(err);
    }
  }

  @Patch(':nik/reset-password')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async resetPassword(@Param('nik') nik: string, @Body() body: ResetPasswordRequest) {
    try {
      const result = await this.userService.resetPassword(
        nik,
        body.password,
        body.requirePasswordChange !== false,
      );
      return new CommonResponse('Password reset', HttpStatus.OK, result);
    } catch (err) {
      return handleException(err);
    }
  }

  @Delete(':nik')
  @Roles(ERole.SUPER)
  async remove(
    @Param('nik') nik: string,
    @Query('withData') withData?: string,
  ) {
    try {
      const includeData = withData === 'true' || withData === '1';
      const result = await this.userService.deleteUser(nik, includeData);
      return new CommonResponse(
        includeData ? 'User and data deleted' : 'User deactivated',
        HttpStatus.OK,
        result,
      );
    } catch (err) {
      return handleException(err);
    }
  }
}
