import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DT_USER } from '@prisma/client';
import { ERole } from '../constant/ERole';
import { RoleService } from '../role/role.service';
import { RegisterRequest } from './dto/request/registerRequest';
import { RegisterResponse } from '../auth/dto/response/registerResponse';
import { comparePassword, encodePassword } from '../utils/bcrypt';
import { RequestUpdateUser } from './dto/request/requestUpdateUser';
import { ConfigService } from '@nestjs/config';
import { EmpHRIS, ResponseListUsersDto, ResponseUserContains } from './dto/response-users.dto';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { assertImageFile, getOriginalName, safeUserPhotoPath } from '../utils/file';
import { generateColorFromString } from '../utils/color';
import { MailService } from '../utils/mail/mail.service';
import { PushService } from '../notifications/push.service';

interface IuserService {
  create(data: RegisterRequest, file?: Express.Multer.File): Promise<RegisterResponse>;
  updateUser(nik: string, data: RequestUpdateUser, file?: Express.Multer.File): Promise<void>;
  updatePhoto(
    nik: string,
    photo?: string,
    color?: string,
    file?: Express.Multer.File,
  ): Promise<{ photo: string }>;
  findAll(): Promise<ResponseListUsersDto[]>;
  findAllPaginated(
    limit: number,
    offset: number,
    search?: string,
  ): Promise<{ data: ResponseListUsersDto[]; total: number; hasMore: boolean }>;
  findAdmin(): Promise<{ nik: string; nama: string }[]>;
  isActive(nik: string): Promise<boolean>;
  resetPassword(nik: string): Promise<void>;
  deleteUser(nik: string): Promise<void>;
  findOne(nik: string): Promise<DT_USER>;
  UsrHRIS(
    search?: string,
    limit?: number,
    offset?: number,
  ): Promise<{ data: EmpHRIS[]; hasMore: boolean }>;
}

@Injectable()
export class UserService implements IuserService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly roleService: RoleService,
    private readonly configService: ConfigService,
    private readonly storageService: DropboxStorageService,
    private readonly mailService: MailService,
    private readonly pushService: PushService,
  ) {}

  async findAll(): Promise<ResponseListUsersDto[]> {
    const users = await this.prismaService.dT_USER.findMany({
      select: {
        nik: true,
        nama: true,
        noTelp: true,
        email: true,
        roleId: true,
        statusActive: true,
        handleWeb: true,
        photo: true,
        departement: true,
        notificationPrefs: true,
      },
    });

    return users.map((u) => ({
      ...u,
      departemen: u.departement,
    }));
  }

  async findAllPaginated(
    limit: number,
    offset: number,
    search?: string,
  ): Promise<{ data: ResponseListUsersDto[]; total: number; hasMore: boolean }> {
    const whereClause: any = {};
    if (search && search.trim()) {
      const q = search.trim();
      whereClause.OR = [
        { nik: { contains: q } },
        { nama: { contains: q } },
        { email: { contains: q } },
        { departement: { contains: q } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prismaService.dT_USER.count({ where: whereClause }),
      this.prismaService.dT_USER.findMany({
        where: whereClause,
        skip: offset,
        take: limit,
        orderBy: { nik: 'asc' },
        select: {
          nik: true,
          nama: true,
          noTelp: true,
          email: true,
          roleId: true,
          statusActive: true,
          handleWeb: true,
          photo: true,
          departement: true,
          notificationPrefs: true,
        },
      }),
    ]);

    return {
      data: users.map((u) => ({
        ...u,
        departemen: u.departement,
      })),
      total,
      hasMore: offset + users.length < total,
    };
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

  async UsrHRIS(
    search?: string,
    limit = 10,
    offset = 0,
  ): Promise<{ data: EmpHRIS[]; hasMore: boolean }> {
    const keyword = search ? `%${search}%` : `%`;

    const fetchLimit = limit + 1; // fetch 1 extra to detect hasMore

    const data = await this.prismaService.$queryRaw<EmpHRIS[]>`
      SELECT
        t1.NomorIndukStr as nik, 
        t1.NamaLengkapStr as name,
        (
          SELECT TOP 1 td.DepartemenStr
          FROM hris.dbo.tblpegawaijabatan tj
          LEFT JOIN hris.dbo.tbldepartemen td ON tj.DepartemenIDLng = td.DepartemenIDLng
          WHERE tj.PegawaiIDLng = t1.PegawaiIDLng
          ORDER BY tj.PegawaiJabatanIDLng DESC
        ) as department
      FROM hris.dbo.tblpegawai t1
      WHERE (t1.NomorIndukStr LIKE ${keyword} OR t1.NamaLengkapStr LIKE ${keyword})
      ORDER BY t1.NamaLengkapStr ASC
      OFFSET ${offset} ROWS
      FETCH NEXT ${fetchLimit} ROWS ONLY
  `;

    const current = await this.findAll();
    const dtNikList = current.map((x) => x.nik);

    const hasMore = data.length > limit;
    const sliced = hasMore ? data.slice(0, limit) : data;

    return {
      data: sliced.map((emp) => ({
        nik: emp.nik,
        name: emp.name,
        department: emp.department,
        status: dtNikList.includes(emp.nik),
      })),
      hasMore,
    };
  }

  async create(data: RegisterRequest, file?: Express.Multer.File): Promise<RegisterResponse> {
    const existingUser = await this.prismaService.dT_USER.findUnique({
      where: { nik: data.nik },
    });
    if (existingUser) throw new ConflictException('User already exists');

    if (!Object.values(ERole).includes(data.roleId)) {
      throw new ConflictException('Invalid role');
    }

    const getRole = await this.roleService.getOrSave(data.roleId);
    const hashedPassword = encodePassword(data.password);

    let photoValue = await this.processPhotoValue(data.nik, file, data.photo, data.color);
    if (!photoValue) {
      photoValue = generateColorFromString(data.nama);
    }

    const dept = data.departement || data.departemen || null;

    return this.prismaService.$transaction(async (tx) => {
      const newUser = await tx.dT_USER.create({
        data: {
          nik: data.nik,
          nama: data.nama,
          password: hashedPassword,
          noTelp: data.noTelp || null,
          email: data.email || null,
          roleId: getRole.id,
          statusActive: data.statusActive,
          handleWeb: data.handleWeb,
          photo: photoValue,
          departement: dept,
        },
      });

      return {
        nik: newUser.nik,
        nama: newUser.nama,
        role: newUser.roleId,
        photo: newUser.photo,
      };
    });
  }
  async updateUser(
    nik: string,
    data: RequestUpdateUser,
    file?: Express.Multer.File,
  ): Promise<void> {
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

    if (existingUser.roleId !== String(ERole.SUPER) && data.roleId === ERole.SUPER) {
      data.roleId = existingUser.roleId as ERole;
    }

    const photoUpdate: string | undefined = await this.processPhotoValue(
      nik,
      file,
      data.photo,
      data.color,
    );

    const deptUpdate = data.departement !== undefined ? data.departement : data.departemen;

    const roleChanged = existingUser.roleId !== getRole.id;
    const deactivated = existingUser.statusActive && !data.statusActive;

    await this.prismaService.$transaction(async (tx) => {
      // update data user dasar
      await tx.dT_USER.update({
        where: { nik },
        data: {
          nama: data.nama,
          noTelp: data.noTelp ? data.noTelp : null,
          email: data.email ? data.email : null,
          roleId: getRole.id,
          statusActive: data.statusActive,
          handleWeb: data.handleWeb,
          ...(photoUpdate !== undefined ? { photo: photoUpdate } : {}),
          ...(deptUpdate !== undefined ? { departement: deptUpdate } : {}),
          ...(data.notificationPrefs !== undefined
            ? { notificationPrefs: data.notificationPrefs }
            : {}),
        },
      });
    });

    if (deactivated) {
      this.pushService.notifyUser(nik, {
        type: 'account.deactivated',
        title: 'Akun dinonaktifkan',
        body: 'Akun Anda telah dinonaktifkan.',
        url: '/login',
      });
    }
    if (roleChanged) {
      this.pushService.notifyUser(nik, {
        type: 'account.role_changed',
        title: 'Role diubah',
        body: `Role sistem: ${getRole.id}`,
        url: '/dashboard',
      });
    }
  }

  private async processPhotoValue(
    nik: string,
    file?: Express.Multer.File,
    photo?: string,
    color?: string,
  ): Promise<string | undefined> {
    if (file) {
      assertImageFile(file);
      const pathname = safeUserPhotoPath(getOriginalName(file), nik);
      const uploaded = await this.storageService.uploadFile(
        pathname,
        file.buffer,
        file.mimetype || 'application/octet-stream',
      );
      return uploaded.url;
    }

    if (photo && photo.trim()) {
      const trimmedPhoto = photo.trim();
      // Check if photo is base64 DataURL (e.g. data:image/png;base64,...)
      if (trimmedPhoto.startsWith('data:image/')) {
        const matches = trimmedPhoto.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const mimetype = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          const ext = mimetype.split('/')[1]?.split('+')[0] || 'png';
          const pathname = safeUserPhotoPath(`avatar.${ext}`, nik);
          const uploaded = await this.storageService.uploadFile(pathname, buffer, mimetype);
          return uploaded.url;
        }
      }
      return trimmedPhoto;
    }

    if (color && color.trim()) {
      return color.trim();
    }

    return undefined;
  }

  async updatePhoto(
    nik: string,
    photo?: string,
    color?: string,
    file?: Express.Multer.File,
  ): Promise<{ photo: string }> {
    const existingUser = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!existingUser) throw new NotFoundException('User tidak ditemukan');

    const photoValue = await this.processPhotoValue(nik, file, photo, color);
    if (!photoValue) {
      throw new BadRequestException('Foto atau warna tidak boleh kosong');
    }

    await this.prismaService.dT_USER.update({
      where: { nik },
      data: { photo: photoValue },
    });

    return { photo: photoValue };
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
    this.pushService.notifyUser(nik, {
      type: 'account.password_changed',
      title: 'Password diubah',
      body: 'Password akun Anda berhasil diubah.',
      url: '/dashboard',
    });
  }

  async changePassword(nik: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isMatch = await comparePassword(currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Old password is incorrect');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException('Password baru tidak boleh sama dengan password lama');
    }

    if (newPassword.length < 8) {
      throw new BadRequestException('Password baru minimal 8 karakter');
    }

    if (!/[A-Z]/.test(newPassword)) {
      throw new BadRequestException('Password baru harus mengandung setidaknya 1 huruf besar');
    }

    if (!/[0-9]/.test(newPassword)) {
      throw new BadRequestException('Password baru harus mengandung setidaknya 1 angka');
    }

    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)) {
      throw new BadRequestException('Password baru harus mengandung setidaknya 1 simbol atau karakter khusus (misal: _, @, #)');
    }

    const password = encodePassword(newPassword);

    await this.prismaService.$transaction([
      this.prismaService.dT_USER.update({
        where: { nik },
        data: { password },
      }),
      this.prismaService.lOG_REFRESH_TOKEN.updateMany({
        where: { nik },
        data: { isRevoked: true },
      }),
    ]);

    if (user.email) {
      this.mailService.sendPasswordChangedEmail(user.email, user.nama);
    }
    this.pushService.notifyUser(nik, {
      type: 'account.password_changed',
      title: 'Password diubah',
      body: 'Password akun Anda berhasil diubah.',
      url: '/dashboard',
    });
  }

  async findOne(nik: string): Promise<DT_USER> {
    const user = await this.prismaService.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User tidak ditemukan');
    return user;
  }

  async findContains(nik: string): Promise<ResponseUserContains[]> {
    const user = await this.prismaService.dT_USER.findMany({
      where: {
        nik: { contains: nik },
      },
      select: {
        nik: true,
        nama: true,
        photo: true,
      },
    });
    if (!user) throw new NotFoundException('User tidak ditemukan');
    return user;
  }
  async findManyByNik(data: { nik: string }[]): Promise<DT_USER[]> {
    const nikList = [...new Set((data ?? []).map((d) => d?.nik).filter((v): v is string => !!v))];

    if (nikList.length === 0) return [];

    return this.prismaService.dT_USER.findMany({
      where: { nik: { in: nikList } },
    });
  }

  async deleteUser(nik: string): Promise<void> {
    const user = await this.prismaService.dT_USER.findUnique({
      where: { nik },
    });
    if (!user) {
      throw new NotFoundException('User tidak ditemukan');
    }

    await this.prismaService.$transaction([
      this.prismaService.lOG_FORGOT_PASSWORD.deleteMany({ where: { nik } }),
      this.prismaService.lOG_ACTIVITY.deleteMany({ where: { nik } }),
      this.prismaService.dT_MEMBER_PROJECT.deleteMany({ where: { nik } }),
      this.prismaService.dT_ASSIGNEE_TASK.deleteMany({ where: { nik } }),
      this.prismaService.dT_ASSIGNEE_SUBTASK.deleteMany({ where: { nik } }),
      this.prismaService.lOG_INVITATION_PROJECT.deleteMany({
        where: { OR: [{ sender: nik }, { to: nik }] },
      }),
      this.prismaService.dT_USER.delete({ where: { nik } }),
    ]);
  }
}
