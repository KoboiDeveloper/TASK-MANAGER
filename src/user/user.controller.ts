import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { AuthGuard } from '../security/authGuard';
import { Roles } from '../security/roles.decorator';
import { RegisterRequest } from './dto/request/registerRequest';
import { RequestUpdateUser } from './dto/request/requestUpdateUser';
import { ResponseListUsersDto, ResponseUserContains } from './dto/response-users.dto';
import { ChangePasswordDto } from './dto/request/requestChangePassword';
import { OwnerGuard } from '../security/own-guard';
import { Own } from '../security/own.decorator';
import { Response } from 'express';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import multer from 'multer';

@UseGuards(AuthGuard)
@Controller('api/users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Roles('SUPER')
  @Get('/hris')
  async getHris(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    try {
      const limitNum = Math.min(Number(limit) || 10, 50);
      const pageNum = Math.max(Number(page) || 1, 1);
      const offset = (pageNum - 1) * limitNum;

      const usrResponse = await this.userService.UsrHRIS(search, limitNum, offset);

      return new CommonResponse('HRIS List', HttpStatus.OK, usrResponse);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Roles('SUPER')
  @Get()
  async findAll(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('search') search?: string,
  ) {
    try {
      if (limit !== undefined || offset !== undefined || page !== undefined) {
        const limitNum = Math.min(Number(limit) || 10, 100);
        let offsetNum = Number(offset);
        if (isNaN(offsetNum)) {
          const pageNum = Math.max(Number(page) || 1, 1);
          offsetNum = (pageNum - 1) * limitNum;
        }
        const result = await this.userService.findAllPaginated(limitNum, offsetNum, search);
        return new CommonResponse('Users List', HttpStatus.OK, result);
      }

      const userResponse: ResponseListUsersDto[] = await this.userService.findAll();
      return new CommonResponse('Users List', HttpStatus.OK, userResponse);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get('/contains/:nik')
  async findUsersContains(@Param('nik') nik: string) {
    try {
      const userResponse: ResponseUserContains[] = await this.userService.findContains(nik);
      return new CommonResponse('Users List', HttpStatus.OK, userResponse);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Roles('SUPER')
  @Post('/add')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'photo', maxCount: 1 },
        { name: 'file', maxCount: 1 },
      ],
      { storage: multer.memoryStorage() },
    ),
  )
  async register(
    @Body() request: RegisterRequest,
    @UploadedFiles()
    files?: { photo?: Express.Multer.File[]; file?: Express.Multer.File[] },
  ) {
    try {
      const photoFile = files?.photo?.[0] || files?.file?.[0];
      const result = await this.userService.create(request, photoFile);
      return new CommonResponse('Register Successfully', HttpStatus.CREATED, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @UseGuards(AuthGuard, OwnerGuard)
  @Own()
  @Patch('/update/:nik')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'photo', maxCount: 1 },
        { name: 'file', maxCount: 1 },
      ],
      { storage: multer.memoryStorage() },
    ),
  )
  async update(
    @Param('nik') nik: string,
    @Body() requestUpdateUser: RequestUpdateUser,
    @UploadedFiles()
    files?: { photo?: Express.Multer.File[]; file?: Express.Multer.File[] },
  ) {
    try {
      const photoFile = files?.photo?.[0] || files?.file?.[0];
      const result = await this.userService.updateUser(nik, requestUpdateUser, photoFile);
      return new CommonResponse('Update Successfully', HttpStatus.OK, result);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @UseGuards(AuthGuard, OwnerGuard)
  @Own()
  @Patch('/photo/:nik')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'photo', maxCount: 1 },
        { name: 'file', maxCount: 1 },
      ],
      { storage: multer.memoryStorage() },
    ),
  )
  async updatePhoto(
    @Param('nik') nik: string,
    @Body() body: { photo?: string; color?: string },
    @UploadedFiles()
    files?: { photo?: Express.Multer.File[]; file?: Express.Multer.File[] },
  ) {
    try {
      const photoFile = files?.photo?.[0] || files?.file?.[0];
      const result = await this.userService.updatePhoto(nik, body?.photo, body?.color, photoFile);
      return new CommonResponse('Photo updated successfully', HttpStatus.OK, result);
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

  @Roles('SUPER')
  @Delete('/:nik')
  @HttpCode(HttpStatus.OK)
  async deleteUser(@Param('nik') nik: string) {
    try {
      await this.userService.deleteUser(nik);
      return new CommonResponse('Delete User Successfully', HttpStatus.OK, null);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch('change-password/:nik')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, OwnerGuard)
  async changePassword(
    @Param('nik') nik: string,
    @Body() data: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      await this.userService.changePassword(nik, data.currentPassword, data.newPassword);

      // clear cookie
      res.clearCookie('access_token', {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // true di production
        sameSite: 'lax',
      });

      return new CommonResponse('Password changed successfully', HttpStatus.OK, null);
    } catch (e) {
      return handleException((e as Error).message);
    }
  }
}
