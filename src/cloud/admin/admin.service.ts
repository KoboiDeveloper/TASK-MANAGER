import { Injectable } from '@nestjs/common';
import { CloudPrismaService } from '../prisma/prisma.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: CloudPrismaService,
    private storage: DropboxStorageService,
  ) {}

  async dropboxQuota() {
    return this.storage.getSpaceUsage();
  }

  async overview() {
    const [userCount, fileAgg, folderCount, quotas] = await Promise.all([
      this.prisma.dT_USER.count({ where: { statusActive: true } }),
      this.prisma.dT_FILE.aggregate({
        where: { trashedAt: null },
        _sum: { bytes: true },
        _count: true,
      }),
      this.prisma.dT_FOLDER.count({ where: { trashedAt: null } }),
      this.prisma.dT_USER_QUOTA.findMany({
        include: { user: { select: { nik: true, nama: true, roleId: true, statusActive: true } } },
        orderBy: { usedBytes: 'desc' },
      }),
    ]);

    return {
      userCount,
      fileCount: fileAgg._count,
      folderCount,
      totalUsedBytes: (fileAgg._sum.bytes || BigInt(0)).toString(),
      users: quotas.map((q) => ({
        nik: q.nik,
        nama: q.user.nama,
        roleId: q.user.roleId,
        statusActive: q.user.statusActive,
        limitBytes: q.limitBytes.toString(),
        usedBytes: q.usedBytes.toString(),
      })),
    };
  }
}
