import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AuthGuard } from '../security/authGuard';
import { Roles } from '../security/roles.decorator';
import { RegisterRequest } from './dto/request/registerRequest';
import { RequestUpdateUser } from './dto/request/requestUpdateUser';
import { ResponseListUsersDto } from './dto/response-users.dto';
import { Own } from '../security/own.decorator';
import { ChangePasswordDto } from './dto/request/requestChangePassword';
import { OwnerGuard } from '../security/own-guard';

@UseGuards(AuthGuard)
@Controller('api/users')
export class UserController {
  constructor(private readonly userService: UserService) {}
  @Roles('SUPER')
  @Get()
  async findAll() {
    try {
      const userResponse: ResponseListUsersDto[] = await this.userService.findAll();
      return new CommonResponse('Users List', HttpStatus.OK, userResponse);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Roles('SUPER')
  @Post('/add')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() request: RegisterRequest) {
    try {
      const result = await this.userService.create(request);
      return new CommonResponse('Register Successfully', HttpStatus.CREATED, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
  @Roles('SUPER')
  @Patch('/update/:nik')
  @HttpCode(HttpStatus.OK)
  async update(@Param('nik') nik: string, @Body() requestUpdateUser: RequestUpdateUser) {
    try {
      const result = await this.userService.updateUser(nik, requestUpdateUser);
      return new CommonResponse('Update Successfully', HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
  @Roles('SUPER')
  @Patch('/reset-password/:nik')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Param('nik') nik: string) {
    try {
      await this.userService.resetPassword(nik);
      return new CommonResponse('Update Successfully', HttpStatus.OK, null);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Own()
  @UseGuards(AuthGuard, OwnerGuard)
  @Patch('/change-password/:nik')
  @HttpCode(HttpStatus.OK)
  async changePassword(@Param('nik') nik: string, @Body() data: ChangePasswordDto) {
    try {
      await this.userService.changePassword(nik, data.oldPassword, data.newPassword);
      return new CommonResponse('Password changed successfully', HttpStatus.OK, null);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}
