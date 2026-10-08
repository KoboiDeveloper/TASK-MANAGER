import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { RoleService } from './role.service';
import { AuthGuard } from '../security/authGuard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { CommonResponse } from '../common/commonResponse';
import { ERole } from '../constant/ERole';

@Controller('api/cloud/roles')
@UseGuards(AuthGuard, RolesGuard)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @Roles(ERole.SUPER, ERole.ADMIN)
  async list() {
    const roles = await this.roleService.findAll();
    return new CommonResponse('OK', HttpStatus.OK, roles);
  }
}
