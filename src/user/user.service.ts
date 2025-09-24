import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DT_USER, Prisma } from '@prisma/client';
import { ERole } from '../constant/ERole';
import { StoreService } from '../store/store.service';
import { RoleService } from '../role/role.service';
import { RegisterRequest } from './dto/request/registerRequest';
import { RegisterResponse } from '../auth/dto/response/registerResponse';
import { encodePassword } from '../utils/bcrypt';
import { RequestUpdateUser } from './dto/request/requestUpdateUser';
import { ConfigService } from '@nestjs/config';
import { ResponseListUsersDto } from './dto/response-users.dto';

interface IuserService {
  create(data: RegisterRequest): Promise<RegisterResponse>;
  updateUser(nik: string, data: RequestUpdateUser): Promise<void>;
  findAll(): Promise<ResponseListUsersDto[]>;
  findAdmin(): Promise<{ nik: string; nama: string }[]>;
  isActive(nik: string): Promise<boolean>;
  resetPassword(nik: string): Promise<void>;
  findOne(nik: string): Promise<DT_USER>;
}

@Injectable()
export class UserService implements IuserService {
  private storeAccessRoles: ERole[] = [ERole.SC, ERole.SPVJ, ERole.SPV, ERole.CASHIER];
  private regionAccessRoles: ERole[] = [ERole.AC];
  constructor(
    private readonly prismaService: PrismaService,
    private readonly storeService: StoreService,
    private readonly roleService: RoleService,
    private readonly configService: ConfigService,
  ) {}

  async findAll(): Promise<ResponseListUsersDto[]> {
    return await this.prismaService.dT_USER.findMany({
      select: {
        nik: true,
        nama: true,
        noTelp: true,
        email: true,
        roleId: true,
        statusActive: true,
        handleWeb: true,
        accessStoreIds: {
          select: {
            storeId: true,
          },
        },
        accessRegionIds: {
          select: {
            regionId: true,
          },
        },
      },
    });
  }
  async findAdmin(): Promise<{ nik: string; nama: string }[]> {
    return await this.prismaService.dT_USER.findMany({
      where: {
        roleId: {
          in: ['ADMIN', 'SUPER'],
        },
      },
      select: {
        nik: true,
        nama: true,
      },
    });
  }
  async create(data: RegisterRequest): Promise<RegisterResponse> {
    const existingUser = await this.prismaService.dT_USER.findUnique({
      where: { nik: data.nik },
    });
    if (existingUser) throw new ConflictException('User already exists');

    if (!Object.values(ERole).includes(data.roleId)) {
      throw new ConflictException('Invalid role');
    }

    const getRole = await this.roleService.getOrSave(data.roleId);
    const hashedPassword = encodePassword(data.password);

    await this.validateStoreAccess(data.roleId, data.accessStoreIds);
    await this.validateRegionAccess(data.roleId, data.accessRegionIds);

    return this.prismaService.$transaction(async (tx) => {
      const newUser = await tx.dT_USER.create({
        data: {
          nik: data.nik,
          nama: data.nama,
          password: hashedPassword,
          noTelp: data.noTelp,
          email: data.email,
          roleId: getRole.id,
          statusActive: data.statusActive,
          handleWeb: data.handleWeb,
        },
      });

      if (this.storeAccessRoles.includes(data.roleId) && data.accessStoreIds?.length) {
        await this.handleStoreAccess(tx, newUser.nik, data.accessStoreIds);
      }

      if (this.regionAccessRoles.includes(data.roleId) && data.accessRegionIds?.length) {
        await this.handleRegionAccess(tx, newUser.nik, data.accessRegionIds);
      }

      return {
        nik: newUser.nik,
        nama: newUser.nama,
        role: newUser.roleId,
      };
    });
  }
  async updateUser(nik: string, data: RequestUpdateUser): Promise<void> {
    const existingUser = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!existingUser) throw new ConflictException('User tidak ditemukan');

    // pastikan role valid
    if (!Object.values(ERole).includes(data.roleId)) {
      throw new ConflictException('Role tidak valid');
    }

    // aturan khusus untuk SUPER role
    if (existingUser.roleId === String(ERole.SUPER) && data.roleId !== ERole.SUPER) {
      const countSuper = await this.prismaService.dT_USER.count({
        where: { roleId: ERole.SUPER, NOT: { nik } },
      });

      if (countSuper === 0) {
        throw new ConflictException('At least one user must retain the SUPER role.');
      }
    }

    const getRole = await this.roleService.getOrSave(data.roleId);

    await this.validateStoreAccess(data.roleId, data.accessStoreIds);
    await this.validateRegionAccess(data.roleId, data.accessRegionIds);

    await this.prismaService.$transaction(async (tx) => {
      // update data user dasar
      await tx.dT_USER.update({
        where: { nik },
        data: {
          nama: data.nama,
          noTelp: data.noTelp,
          email: data.email,
          roleId: getRole.id,
          statusActive: data.statusActive,
          handleWeb: data.handleWeb,
        },
      });

      // reset akses store & region
      await tx.dT_ACCESS_STORE.deleteMany({ where: { userNik: nik } });
      await tx.dT_ACCESS_REGION.deleteMany({ where: { userNik: nik } });

      // reassign sesuai role
      if (this.storeAccessRoles.includes(data.roleId)) {
        await this.handleStoreAccess(tx, nik, data.accessStoreIds);
      }
      if (this.regionAccessRoles.includes(data.roleId)) {
        await this.handleRegionAccess(tx, nik, data.accessRegionIds);
      }
    });
  }

  async isActive(nik: string): Promise<boolean> {
    const user = await this.prismaService.dT_USER.findUnique({
      where: { nik },
      select: { statusActive: true },
    });

    return !!user?.statusActive;
  }

  async resetPassword(nik: string): Promise<void> {
    const defaultPassword: string | undefined = this.configService.get<string>('DEFAULT_PASSWORD');
    if (!defaultPassword) {
      throw new ConflictException('Internal Error');
    }
    const password = encodePassword(defaultPassword);

    await this.prismaService.dT_USER.update({ where: { nik }, data: { password } });
  }

  async findOne(nik: string): Promise<DT_USER> {
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User tidak ditemukan');
    return user;
  }

  //helper
  private async validateStoreAccess(roleId: ERole, accessStoreIds?: { storeId: string }[]) {
    if (this.storeAccessRoles.includes(roleId)) {
      if (!accessStoreIds || accessStoreIds.length === 0) {
        throw new ConflictException('Access stores are required for this role');
      }

      const inputStoreIds = accessStoreIds.map((s) => s.storeId);
      const existingStores = await this.storeService.findMany(inputStoreIds);
      const validStoreIds = existingStores.map((s) => s.id);
      const invalidStoreIds = inputStoreIds.filter((id) => !validStoreIds.includes(id));

      if (invalidStoreIds.length > 0) {
        throw new ConflictException(`Store tidak ditemukan: ${invalidStoreIds.join(', ')}`);
      }
    }
  }

  private async validateRegionAccess(roleId: ERole, accessRegionIds?: { regionId: string }[]) {
    if (this.regionAccessRoles.includes(roleId)) {
      if (!accessRegionIds || accessRegionIds.length === 0) {
        throw new ConflictException('Access regions are required for this role');
      }

      const inputRegionIds = accessRegionIds.map((r) => r.regionId);
      const existingRegions = await this.prismaService.dT_REGION.findMany({
        where: { id: { in: inputRegionIds } },
        select: { id: true },
      });

      const validRegionIds = existingRegions.map((r) => r.id);
      const invalidRegionIds = inputRegionIds.filter((id) => !validRegionIds.includes(id));

      if (invalidRegionIds.length > 0) {
        throw new ConflictException(`Region tidak ditemukan: ${invalidRegionIds.join(', ')}`);
      }
    }
  }

  private async handleStoreAccess(
    tx: Prisma.TransactionClient,
    userNik: string,
    accessStoreIds: { storeId: string }[],
  ) {
    if (!accessStoreIds?.length) return;

    const storesData = accessStoreIds.map((store) => ({
      userNik,
      storeId: store.storeId,
    }));

    await tx.dT_ACCESS_STORE.createMany({ data: storesData });
  }

  private async handleRegionAccess(
    tx: Prisma.TransactionClient,
    userNik: string,
    accessRegionIds: { regionId: string }[],
  ) {
    if (!accessRegionIds?.length) return;

    const regionsData = accessRegionIds.map((region) => ({
      userNik,
      regionId: region.regionId,
    }));

    await tx.dT_ACCESS_REGION.createMany({ data: regionsData });
  }
}
