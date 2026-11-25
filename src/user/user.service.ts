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
import { profileImageUrl } from '../utils/profile-image';
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
    departement?: string,
  ): Promise<{ data: ResponseListUsersDto[]; total: number; hasMore: boolean }>;
  listDepartments(): Promise<string[]>;
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
        kpiAdmin: true,
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

  async listDepartments(): Promise<string[]> {
    const rows = await this.prismaService.dT_USER.findMany({
      where: { departement: { not: null } },
      distinct: ['departement'],
      select: { departement: true },
    });
    return [...new Set(rows.map((row) => row.departement?.trim() ?? '').filter((name) => name.length > 0))].sort(
      (a, b) => a.localeCompare(b, 'id'),
    );
  }

  async findAllPaginated(
    limit: number,
    offset: number,
    search?: string,
    departement?: string,
  ): Promise<{ data: ResponseListUsersDto[]; total: number; hasMore: boolean }> {
    const whereClause: any = {};
    const department = departement?.trim();
    if (department) {
      whereClause.departement = department;
    }
    if (search && search.trim()) {
      const q = search.trim();
      whereClause.OR = [
        { nik: { contains: q } },
        { nama: { contains: q } },
        { email: { contains: q } },
        { noTelp: { contains: q } },
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
          kpiAdmin: true,
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
          kpiAdmin: getRole.id === 'HEAD' ? Boolean(data.kpiAdmin ?? existingUser.kpiAdmin) : false,
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

  async importWebUsers(): Promise<WebImportResult> {
    await this.roleService.getOrSave(ERole.STAFF);
    await this.roleService.getOrSave(ERole.HEAD);

    const rows = await this.prismaService.$queryRaw<WebImportRow[]>`
      SELECT
        LTRIM(RTRIM(ISNULL(p.NomorIndukStr, ''))) AS nik,
        LEFT(LTRIM(RTRIM(ISNULL(p.NamaLengkapStr, ''))), 40) AS nama,
        LEFT(LTRIM(RTRIM(ISNULL(w.PHONE_NUMBER, ''))), 13) AS phone,
        LTRIM(RTRIM(w.ROLL_CODE)) AS rollCode,
        LEFT(LTRIM(RTRIM(ISNULL(dept.DepartemenStr, ''))), 50) AS departement,
        ss.photoUrl AS photoUrl,
        ph.photoImg AS photoImg,
        CASE WHEN p.PegawaiIDLng IS NULL THEN 0 ELSE 1 END AS activeMatch
      FROM pos_server.dbo.WEB_USER_MAIN w
      LEFT JOIN hris.dbo.tblpegawai p
        ON LTRIM(RTRIM(p.NomorIndukStr)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(w.ID_USER)) COLLATE DATABASE_DEFAULT
       AND ISNULL(p.PegawaiNonAktifInt, 0) = 0
      OUTER APPLY (
        SELECT TOP 1 td.DepartemenStr
        FROM hris.dbo.tblpegawaijabatan tj
        LEFT JOIN hris.dbo.tbldepartemen td ON tj.DepartemenIDLng = td.DepartemenIDLng
        WHERE tj.PegawaiIDLng = p.PegawaiIDLng
        ORDER BY tj.PegawaiJabatanIDLng DESC
      ) dept
      OUTER APPLY (
        SELECT TOP 1 ph.PhotoImg AS photoImg
        FROM hris.dbo.tblpegawaiphoto ph
        WHERE ph.PegawaiIDLng = p.PegawaiIDLng
          AND DATALENGTH(ph.PhotoImg) > 32
          AND DATALENGTH(ph.PhotoImg) <= 2000000
        ORDER BY ph.PegawaiPhotoIDLng DESC
      ) ph
      OUTER APPLY (
        SELECT TOP 1 LTRIM(RTRIM(ss.Photo)) AS photoUrl
        FROM hris.dbo.WEB_SELF_SERVICE_PHOTO_PEGAWAI ss
        WHERE LTRIM(RTRIM(ss.NIK)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(p.NomorIndukStr)) COLLATE DATABASE_DEFAULT
          AND LTRIM(RTRIM(ISNULL(ss.Photo, ''))) <> ''
        ORDER BY ss.id DESC
      ) ss
      WHERE w.ROLL_CODE IN ('1313', '8877', '7788')
        AND w.ID_USER NOT LIKE 'gh%'
    `;

    const existing = await this.prismaService.dT_USER.findMany({ select: { nik: true } });
    const existingNiks = new Set(existing.map((user) => user.nik.trim()));
    const queued = new Set<string>();
    const result: WebImportResult = {
      inserted: 0,
      skippedExisting: 0,
      skippedInactiveOrMissing: 0,
      skippedBadNik: 0,
      photoSaved: 0,
      photoMissing: 0,
      failed: 0,
    };

    for (const row of rows) {
      const active = Number(row.activeMatch) === 1;
      const nik = (row.nik || '').trim();
      const nama = (row.nama || '').trim();
      if (!active) {
        result.skippedInactiveOrMissing += 1;
        continue;
      }
      if (nik.length !== 8 || !nama) {
        result.skippedBadNik += 1;
        continue;
      }
      if (existingNiks.has(nik) || queued.has(nik)) {
        result.skippedExisting += 1;
        continue;
      }
      queued.add(nik);

      const roleId = row.rollCode === '8877' || row.rollCode === '7788' ? ERole.HEAD : ERole.STAFF;
      let photo = generateColorFromString(nama);
      let savedPhoto = false;
      try {
        const uploaded = await this.photoForImport(nik, row.photoUrl, row.photoImg);
        if (uploaded) {
          photo = uploaded;
          savedPhoto = true;
        }
      } catch {
        savedPhoto = false;
      }

      try {
        await this.prismaService.dT_USER.create({
          data: {
            nik,
            nama,
            password: encodePassword('ArahTimurLaut12'),
            noTelp: row.phone?.trim() ? row.phone.trim() : null,
            email: null,
            roleId,
            statusActive: true,
            handleWeb: false,
            photo,
            departement: row.departement?.trim() ? row.departement.trim() : null,
            mustChangePassword: true,
          },
        });
        result.inserted += 1;
        if (savedPhoto) result.photoSaved += 1;
        else result.photoMissing += 1;
      } catch {
        result.failed += 1;
      }
    }

    const filled = await this.syncSelfServicePhotos();
    result.photoSaved += filled;
    result.photoMissing = Math.max(0, result.photoMissing - filled);

    return result;
  }

  async syncSelfServicePhotos(): Promise<number> {
    const photos = await this.prismaService.$queryRaw<{ nik: string; photo: string }[]>`
      SELECT
        u.nik AS nik,
        LTRIM(RTRIM(ss.Photo)) AS photo
      FROM DT_USER u
      INNER JOIN hris.dbo.WEB_SELF_SERVICE_PHOTO_PEGAWAI ss
        ON LTRIM(RTRIM(ss.NIK)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(u.nik)) COLLATE DATABASE_DEFAULT
      WHERE LTRIM(RTRIM(ISNULL(ss.Photo, ''))) <> ''
        AND (
          u.photo IS NULL
          OR LTRIM(RTRIM(u.photo)) = ''
          OR u.photo NOT LIKE 'https://web.amscorp.id:3060/ImageProfile/%'
        )
    `;

    let filled = 0;
    for (const row of photos) {
      const nik = row.nik?.trim();
      const url = profileImageUrl(row.photo);
      if (!nik || !url) continue;
      if (url.length > 500) {
        console.warn(`photo url too long for ${nik}: ${url.length}`);
        continue;
      }
      await this.prismaService.dT_USER.update({
        where: { nik },
        data: { photo: url },
      });
      filled += 1;
    }
    return filled;
  }

  private async photoForImport(
    nik: string,
    photoUrl: string | null,
    photoImg: Buffer | Uint8Array | null,
  ): Promise<string | null> {
    const url = profileImageUrl(photoUrl);
    if (url && url.length <= 500) return url;

    const buffer = toBuffer(photoImg);
    const image = buffer ? sniffImage(buffer) : null;
    if (!buffer || !image || buffer.length > 2 * 1024 * 1024) return null;

    const uploaded = await this.storageService.uploadFile(
      safeUserPhotoPath(`avatar.${image.ext}`, nik),
      buffer,
      image.mime,
    );
    return uploaded.url;
  }
}

type WebImportRow = {
  nik: string;
  nama: string;
  phone: string | null;
  rollCode: string;
  departement: string | null;
  photoUrl: string | null;
  photoImg: Buffer | Uint8Array | null;
  activeMatch: number;
};

export type WebImportResult = {
  inserted: number;
  skippedExisting: number;
  skippedInactiveOrMissing: number;
  skippedBadNik: number;
  photoSaved: number;
  photoMissing: number;
  failed: number;
};

function toBuffer(value: Buffer | Uint8Array | null): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function sniffImage(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mime: 'image/bmp', ext: 'bmp' };
  }
  if (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}
