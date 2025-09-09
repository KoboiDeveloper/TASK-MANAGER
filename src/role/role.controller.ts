import { Controller, Get, Body, HttpStatus, UseGuards } from '@nestjs/common';
import { RoleService } from './role.service';
import { CommonResponse } from '../common/commonResponse';
import { AuthGuard } from '../security/authGuard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { handleException } from '../utils/handleException';

@Controller('api/roles')
@UseGuards(AuthGuard, RolesGuard)
@Roles('SUPER')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}
  @Get()
  async findAll() {
    try {
      const roles = await this.roleService.findAll();
      return new CommonResponse('List of roles', HttpStatus.OK, roles);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}
