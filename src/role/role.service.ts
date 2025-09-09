import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DT_ROLE } from '@prisma/client';
import { ERole } from '../constant/ERole';

@Injectable()
export class RoleService {
  constructor(private readonly prismaService: PrismaService) {}

  async findOne(id: ERole): Promise<DT_ROLE | null> {
    return this.prismaService.dT_ROLE.findUnique({
      where: { id },
    });
  }
  async findAll(): Promise<DT_ROLE[]> {
    return this.prismaService.dT_ROLE.findMany({
      orderBy: { id: 'asc' },
    });
  }

  async getOrSave(role: ERole): Promise<DT_ROLE> {
    Logger.log(`Start getOrSave(${role})`, 'RoleService');

    let existingRole = await this.prismaService.dT_ROLE.findUnique({
      where: { id: role },
    });

    if (!existingRole) {
      existingRole = await this.prismaService.dT_ROLE.create({
        data: {
          id: role,
          nama: role,
        },
      });
      Logger.log(`Created new role: ${role}`, 'RoleService');
    }

    Logger.log(`End getOrSave(${role})`, 'RoleService');
    return existingRole;
  }
}
