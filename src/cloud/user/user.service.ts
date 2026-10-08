import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CloudPrismaService } from '../prisma/prisma.service';
import { RoleService } from '../role/role.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { RegisterRequest } from './dto/request/registerRequest';
import { encodePassword } from '../utils/bcrypt';
import { ERole } from '../constant/ERole';

const DEFAULT_QUOTA = BigInt(process.env.DEFAULT_QUOTA_BYTES || '5368709120');
const PM_DB = process.env.PM_DATABASE || 'PROJECT_MANAGER';

export type EmpHRIS = {
  nik: string;
  name: string;
  department?: string | null;
  status: boolean;
};

type PmUserRow = {
  nik: string;
  nama: string;
  password: string;
  noTelp: string | null;
  email: string | null;
  roleId: string;
  handleWeb: boolean;
  statusActive: boolean;
  photo: string | null;
  departement: string | null;
};

@Injectable()
export class UserService {
  constructor(
    private prisma: CloudPrismaService,
    private roleService: RoleService,
    private storage: DropboxStorageService,
  ) {}

  async findAll(search?: string) {
    const where: any = {};
    if (search?.trim()) {
      const q = search.trim();
      where.OR = [
        { nik: { contains: q } },
        { nama: { contains: q } },
        { email: { contains: q } },
      ];
    }

    const users = await this.prisma.dT_USER.findMany({
      where,
      orderBy: { nik: 'asc' },
      select: {
        nik: true,
        nama: true,
        noTelp: true,
        email: true,
        roleId: true,
        handleWeb: true,
        statusActive: true,
        photo: true,
        departement: true,
        quota: { select: { limitBytes: true, usedBytes: true } },
      },
    });

    return users.map((u) => ({
      ...u,
      quota: u.quota
        ? {
            limitBytes: u.quota.limitBytes.toString(),
            usedBytes: u.quota.usedBytes.toString(),
          }
        : null,
    }));
  }

  async search(q: string) {
    return this.prisma.dT_USER.findMany({
      where: {
        statusActive: true,
        OR: [{ nik: { contains: q } }, { nama: { contains: q } }],
      },
      take: 20,
      select: { nik: true, nama: true, email: true, photo: true },
    });
  }

  async searchHris(
    search?: string,
    limit = 10,
    offset = 0,
  ): Promise<{ data: EmpHRIS[]; hasMore: boolean }> {
    const keyword = search ? `%${search}%` : `%`;
    const fetchLimit = limit + 1;

    const data = await this.prisma.$queryRaw<
      { nik: string; name: string; department: string | null }[]
    >`
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

    const existing = await this.prisma.dT_USER.findMany({ select: { nik: true } });
    const nikSet = new Set(existing.map((x) => x.nik));

    const hasMore = data.length > limit;
    const sliced = hasMore ? data.slice(0, limit) : data;

    return {
      data: sliced.map((emp) => ({
        nik: String(emp.nik || '').trim(),
        name: emp.name,
        department: emp.department,
        status: nikSet.has(String(emp.nik || '').trim()),
      })),
      hasMore,
    };
  }

  async syncFromProjectManager() {
    const rows = await this.prisma.$queryRawUnsafe<PmUserRow[]>(
      `SELECT
        RTRIM(nik) as nik,
        nama,
        password,
        noTelp,
        email,
        roleId,
        handleWeb,
        statusActive,
        photo,
        departement
      FROM [${PM_DB}].dbo.DT_USER`,
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const nik = String(row.nik || '').trim().slice(0, 8);
      if (!nik || nik.length !== 8) {
        skipped += 1;
        continue;
      }

      const roleId = Object.values(ERole).includes(row.roleId as ERole)
        ? row.roleId
        : ERole.STAFF;
      await this.roleService.getOrSave(roleId);

      const nama = (row.nama || nik).slice(0, 40);
      const noTelp = row.noTelp ? String(row.noTelp).slice(0, 13) : null;
      const email = row.email ? String(row.email).slice(0, 100) : null;
      const photo = row.photo ? String(row.photo).slice(0, 500) : null;
      const departement = row.departement ? String(row.departement).slice(0, 50) : null;

      const existing = await this.prisma.dT_USER.findUnique({ where: { nik } });
      if (!existing) {
        await this.prisma.$transaction(async (tx) => {
          await tx.dT_USER.create({
            data: {
              nik,
              nama,
              password: row.password,
              noTelp,
              email,
              roleId,
              handleWeb: row.handleWeb ?? true,
              statusActive: row.statusActive ?? true,
              photo,
              departement,
            },
          });
          await tx.dT_USER_QUOTA.create({
            data: { nik, limitBytes: DEFAULT_QUOTA, usedBytes: BigInt(0) },
          });
        });
        created += 1;
      } else {
        await this.prisma.dT_USER.update({
          where: { nik },
          data: {
            nama,
            password: row.password,
            noTelp,
            email,
            roleId,
            handleWeb: row.handleWeb ?? existing.handleWeb,
            statusActive: row.statusActive ?? existing.statusActive,
            photo: photo ?? existing.photo,
            departement: departement ?? existing.departement,
          },
        });
        await this.ensureQuota(nik);
        updated += 1;
      }
    }

    return { total: rows.length, created, updated, skipped };
  }

  async create(data: RegisterRequest) {
    const existing = await this.prisma.dT_USER.findUnique({ where: { nik: data.nik } });
    if (existing) throw new ConflictException('User already exists');
    if (!Object.values(ERole).includes(data.roleId as ERole)) {
      throw new ConflictException('Invalid role');
    }

    const role = await this.roleService.getOrSave(data.roleId);
    const password = encodePassword(
      data.password || process.env.DEFAULT_PASSWORD || 'AdityaMandiri_2025',
    );

    const quotaLimit =
      data.limitBytes && BigInt(data.limitBytes) > BigInt(0)
        ? BigInt(data.limitBytes)
        : DEFAULT_QUOTA;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dT_USER.create({
        data: {
          nik: data.nik,
          nama: data.nama.slice(0, 40),
          password,
          noTelp: data.noTelp || null,
          email: data.email || null,
          roleId: role.id,
          statusActive: data.statusActive ?? true,
          handleWeb: data.handleWeb ?? true,
          departement: data.departement || null,
          photo: data.photo || null,
        },
      });
      await tx.dT_USER_QUOTA.create({
        data: {
          nik: created.nik,
          limitBytes: quotaLimit,
          usedBytes: BigInt(0),
        },
      });
      return created;
    });

    return { nik: user.nik, nama: user.nama, role: user.roleId };
  }

  async updateUser(
    nik: string,
    data: {
      roleId?: string;
      handleWeb?: boolean;
      statusActive?: boolean;
      noTelp?: string;
      email?: string;
      departement?: string;
      nama?: string;
    },
  ) {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');

    if (data.roleId && !Object.values(ERole).includes(data.roleId as ERole)) {
      throw new ConflictException('Invalid role');
    }
    if (data.roleId) await this.roleService.getOrSave(data.roleId);

    const updated = await this.prisma.dT_USER.update({
      where: { nik },
      data: {
        ...(data.roleId !== undefined ? { roleId: data.roleId } : {}),
        ...(data.handleWeb !== undefined ? { handleWeb: data.handleWeb } : {}),
        ...(data.statusActive !== undefined ? { statusActive: data.statusActive } : {}),
        ...(data.noTelp !== undefined ? { noTelp: data.noTelp || null } : {}),
        ...(data.email !== undefined ? { email: data.email || null } : {}),
        ...(data.departement !== undefined ? { departement: data.departement || null } : {}),
        ...(data.nama !== undefined ? { nama: data.nama } : {}),
      },
      select: {
        nik: true,
        nama: true,
        noTelp: true,
        email: true,
        roleId: true,
        handleWeb: true,
        statusActive: true,
        departement: true,
      },
    });
    return updated;
  }

  async updateQuota(nik: string, limitBytes: string) {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');

    const limit = BigInt(limitBytes);
    const quota = await this.prisma.dT_USER_QUOTA.upsert({
      where: { nik },
      create: { nik, limitBytes: limit, usedBytes: BigInt(0) },
      update: { limitBytes: limit },
    });

    return {
      nik,
      limitBytes: quota.limitBytes.toString(),
      usedBytes: quota.usedBytes.toString(),
    };
  }

  async softDeactivate(nik: string) {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { statusActive: false },
    });
    return { nik, statusActive: false, withData: false };
  }

  /**
   * Delete user account.
   * - withData=false: deactivate account only (keep files)
   * - withData=true: remove Dropbox files + DB folders/files/shares, then delete user
   */
  async deleteUser(nik: string, withData: boolean) {
    const user = await this.prisma.dT_USER.findUnique({ where: { nik } });
    if (!user) throw new NotFoundException('User not found');
    if (user.roleId === ERole.SUPER) {
      const superCount = await this.prisma.dT_USER.count({
        where: { roleId: ERole.SUPER, statusActive: true },
      });
      if (superCount <= 1) {
        throw new BadRequestException('Cannot delete the last SUPER user');
      }
    }

    if (!withData) {
      return this.softDeactivate(nik);
    }

    const files = await this.prisma.dT_FILE.findMany({
      where: { ownerNik: nik },
      select: { id: true, dropboxPath: true },
    });
    for (const file of files) {
      try {
        await this.storage.deleteFile(file.dropboxPath);
      } catch {
        // ignore missing Dropbox file
      }
    }

    const fileIds = files.map((f) => f.id);
    const folders = await this.prisma.dT_FOLDER.findMany({
      where: { ownerNik: nik },
      select: { id: true },
    });
    const folderIds = folders.map((f) => f.id);

    await this.prisma.$transaction(async (tx) => {
      if (fileIds.length) {
        await tx.dT_SHARE.deleteMany({
          where: { itemType: 'FILE', itemId: { in: fileIds } },
        });
        await tx.dT_SHARE_LINK.deleteMany({
          where: { itemType: 'FILE', itemId: { in: fileIds } },
        });
      }
      if (folderIds.length) {
        await tx.dT_SHARE.deleteMany({
          where: { itemType: 'FOLDER', itemId: { in: folderIds } },
        });
        await tx.dT_SHARE_LINK.deleteMany({
          where: { itemType: 'FOLDER', itemId: { in: folderIds } },
        });
      }

      await tx.dT_SHARE.deleteMany({
        where: { OR: [{ targetNik: nik }, { createdBy: nik }] },
      });
      await tx.dT_SHARE_LINK.deleteMany({ where: { createdBy: nik } });
      await tx.dT_FILE.deleteMany({ where: { ownerNik: nik } });

      // delete folders bottom-up (children first)
      let remaining = await tx.dT_FOLDER.findMany({
        where: { ownerNik: nik },
        select: { id: true, parentId: true },
      });
      while (remaining.length) {
        const ids = new Set(remaining.map((f) => f.id));
        const leaves = remaining.filter((f) => !f.parentId || !ids.has(f.parentId));
        const leafIds = leaves.map((f) => f.id);
        if (!leafIds.length) {
          await tx.dT_FOLDER.deleteMany({ where: { ownerNik: nik } });
          break;
        }
        await tx.dT_FOLDER.deleteMany({ where: { id: { in: leafIds } } });
        remaining = remaining.filter((f) => !leafIds.includes(f.id));
      }

      await tx.dT_USER_QUOTA.deleteMany({ where: { nik } });
      await tx.lOG_REFRESH_TOKEN.deleteMany({ where: { nik } });
      await tx.lOG_FORGOT_PASSWORD.deleteMany({ where: { nik } });
      await tx.dT_USER.delete({ where: { nik } });
    });

    return { nik, deleted: true, withData: true };
  }

  async ensureQuota(nik: string) {
    const existing = await this.prisma.dT_USER_QUOTA.findUnique({ where: { nik } });
    if (existing) return existing;
    return this.prisma.dT_USER_QUOTA.create({
      data: { nik, limitBytes: DEFAULT_QUOTA, usedBytes: BigInt(0) },
    });
  }
}
