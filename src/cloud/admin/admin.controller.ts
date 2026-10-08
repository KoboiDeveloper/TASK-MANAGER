import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuthGuard } from '../security/authGuard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { ERole } from '../constant/ERole';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';

@Controller('api/cloud/admin')
@UseGuards(AuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('overview')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async overview() {
    try {
      const data = await this.adminService.overview();
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }

  @Get('dropbox-quota')
  @Roles(ERole.SUPER, ERole.ADMIN)
  async dropboxQuota() {
    try {
      const data = await this.adminService.dropboxQuota();
      return new CommonResponse('OK', HttpStatus.OK, data);
    } catch (err) {
      return handleException(err);
    }
  }
}
