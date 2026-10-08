import { Injectable } from '@nestjs/common';
import { CloudPrismaService } from '../prisma/prisma.service';
import { ERole } from '../constant/ERole';

@Injectable()
export class RoleService {
  constructor(private prisma: CloudPrismaService) {}

  async getOrSave(roleId: string) {
    const existing = await this.prisma.dT_ROLE.findUnique({ where: { id: roleId } });
    if (existing) return existing;

    const names: Record<string, string> = {
      [ERole.SUPER]: 'Super Admin',
      [ERole.ADMIN]: 'Admin',
      [ERole.STAFF]: 'Staff',
    };

    return this.prisma.dT_ROLE.create({
      data: {
        id: roleId,
        nama: names[roleId] || roleId,
      },
    });
  }

  async findAll() {
    return this.prisma.dT_ROLE.findMany({ orderBy: { id: 'asc' } });
  }
}
