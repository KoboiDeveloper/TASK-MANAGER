import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CloudPrismaService } from '../prisma/prisma.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { UserService } from '../user/user.service';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';

type ItemType = 'FILE' | 'FOLDER';

@Injectable()
export class DriveService {
  constructor(
    private prisma: CloudPrismaService,
    private storage: DropboxStorageService,
    private userService: UserService,
  ) {}

  private serializeFolder(f: any) {
    return {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      ownerNik: f.ownerNik,
      description: f.description,
      starred: f.starred,
      trashedAt: f.trashedAt,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      type: 'FOLDER' as const,
      owner: f.owner ? { nik: f.owner.nik, nama: f.owner.nama } : undefined,
    };
  }

  private serializeFile(f: any) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      bytes: f.bytes.toString(),
      dropboxPath: f.dropboxPath,
      url: f.url,
      folderId: f.folderId,
      ownerNik: f.ownerNik,
      description: f.description,
      starred: f.starred,
      trashedAt: f.trashedAt,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      type: 'FILE' as const,
      owner: f.owner ? { nik: f.owner.nik, nama: f.owner.nama } : undefined,
    };
  }

  async assertAccess(
    nik: string,
    itemId: string,
    itemType: ItemType,
    needEdit = false,
  ): Promise<{ ownerNik: string }> {
    if (itemType === 'FOLDER') {
      const folder = await this.prisma.dT_FOLDER.findUnique({ where: { id: itemId } });
      if (!folder || folder.trashedAt) throw new NotFoundException('Folder not found');
      if (folder.ownerNik === nik) return { ownerNik: folder.ownerNik };
      const share = await this.prisma.dT_SHARE.findFirst({
        where: { itemId, itemType: 'FOLDER', targetNik: nik },
      });
      if (!share) throw new ForbiddenException('No access');
      if (needEdit && share.permission !== 'EDIT') throw new ForbiddenException('Edit denied');
      return { ownerNik: folder.ownerNik };
    }

    const file = await this.prisma.dT_FILE.findUnique({ where: { id: itemId } });
    if (!file || file.trashedAt) throw new NotFoundException('File not found');
    if (file.ownerNik === nik) return { ownerNik: file.ownerNik };
    const share = await this.prisma.dT_SHARE.findFirst({
      where: { itemId, itemType: 'FILE', targetNik: nik },
    });
    if (!share) throw new ForbiddenException('No access');
    if (needEdit && share.permission !== 'EDIT') throw new ForbiddenException('Edit denied');
    return { ownerNik: file.ownerNik };
  }

  async listMyDrive(nik: string, folderId?: string | null) {
    if (folderId) {
      await this.assertAccess(nik, folderId, 'FOLDER', false);
    }

    const [folders, files] = await Promise.all([
      this.prisma.dT_FOLDER.findMany({
        where: {
          ownerNik: nik,
          parentId: folderId || null,
          trashedAt: null,
        },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.dT_FILE.findMany({
        where: {
          ownerNik: nik,
          folderId: folderId || null,
          trashedAt: null,
        },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);

    const foldersWithCount = await Promise.all(
      folders.map(async (f) => {
        const [subFolders, subFiles] = await Promise.all([
          this.prisma.dT_FOLDER.count({
            where: { parentId: f.id, trashedAt: null },
          }),
          this.prisma.dT_FILE.count({
            where: { folderId: f.id, trashedAt: null },
          }),
        ]);
        return {
          ...this.serializeFolder(f),
          itemCount: subFolders + subFiles,
        };
      }),
    );

    return {
      folders: foldersWithCount,
      files: files.map((f) => this.serializeFile(f)),
    };
  }

  async listSharedWithMe(nik: string) {
    const shares = await this.prisma.dT_SHARE.findMany({
      where: { targetNik: nik },
      orderBy: { createdAt: 'desc' },
    });

    const folders: any[] = [];
    const files: any[] = [];

    for (const s of shares) {
      if (s.itemType === 'FOLDER') {
        const f = await this.prisma.dT_FOLDER.findFirst({
          where: { id: s.itemId, trashedAt: null },
          include: { owner: { select: { nik: true, nama: true } } },
        });
        if (f) folders.push({ ...this.serializeFolder(f), permission: s.permission });
      } else {
        const f = await this.prisma.dT_FILE.findFirst({
          where: { id: s.itemId, trashedAt: null },
          include: { owner: { select: { nik: true, nama: true } } },
        });
        if (f) files.push({ ...this.serializeFile(f), permission: s.permission });
      }
    }

    return { folders, files };
  }

  async listRecent(nik: string) {
    const files = await this.prisma.dT_FILE.findMany({
      where: { ownerNik: nik, trashedAt: null },
      include: { owner: { select: { nik: true, nama: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return { folders: [], files: files.map((f) => this.serializeFile(f)) };
  }

  async listStarred(nik: string) {
    const [folders, files] = await Promise.all([
      this.prisma.dT_FOLDER.findMany({
        where: { ownerNik: nik, starred: true, trashedAt: null },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.dT_FILE.findMany({
        where: { ownerNik: nik, starred: true, trashedAt: null },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      folders: folders.map((f) => this.serializeFolder(f)),
      files: files.map((f) => this.serializeFile(f)),
    };
  }

  async listTrash(nik: string) {
    const [folders, files] = await Promise.all([
      this.prisma.dT_FOLDER.findMany({
        where: { ownerNik: nik, trashedAt: { not: null } },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { trashedAt: 'desc' },
      }),
      this.prisma.dT_FILE.findMany({
        where: { ownerNik: nik, trashedAt: { not: null } },
        include: { owner: { select: { nik: true, nama: true } } },
        orderBy: { trashedAt: 'desc' },
      }),
    ]);
    return {
      folders: folders.map((f) => this.serializeFolder(f)),
      files: files.map((f) => this.serializeFile(f)),
    };
  }

  async getBreadcrumb(nik: string, folderId?: string | null) {
    if (!folderId) return [{ id: null, name: 'My Drive' }];
    await this.assertAccess(nik, folderId, 'FOLDER', false);
    const crumbs: { id: string | null; name: string }[] = [];
    let currentId: string | null = folderId;
    while (currentId) {
      const folder = await this.prisma.dT_FOLDER.findUnique({ where: { id: currentId } });
      if (!folder) break;
      crumbs.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parentId;
    }
    crumbs.unshift({ id: null, name: 'My Drive' });
    return crumbs;
  }

  async createFolder(nik: string, name: string, parentId?: string) {
    if (parentId) await this.assertAccess(nik, parentId, 'FOLDER', true);

    const folder = await this.prisma.dT_FOLDER.create({
      data: {
        name: name.trim(),
        parentId: parentId || null,
        ownerNik: nik,
      },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFolder(folder);
  }

  async rename(nik: string, itemId: string, itemType: ItemType, name: string) {
    await this.assertAccess(nik, itemId, itemType, true);
    if (itemType === 'FOLDER') {
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { name: name.trim() },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { name: name.trim() },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async move(nik: string, itemId: string, itemType: ItemType, folderId?: string | null) {
    await this.assertAccess(nik, itemId, itemType, true);
    if (folderId) await this.assertAccess(nik, folderId, 'FOLDER', true);

    if (itemType === 'FOLDER') {
      if (folderId === itemId) throw new BadRequestException('Cannot move folder into itself');
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { parentId: folderId || null },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { folderId: folderId || null },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async setStarred(nik: string, itemId: string, itemType: ItemType, starred: boolean) {
    await this.assertAccess(nik, itemId, itemType, true);
    if (itemType === 'FOLDER') {
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { starred },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { starred },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async setDescription(nik: string, itemId: string, itemType: ItemType, description?: string) {
    await this.assertAccess(nik, itemId, itemType, true);
    if (itemType === 'FOLDER') {
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { description: description || null },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { description: description || null },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async trash(nik: string, itemId: string, itemType: ItemType) {
    await this.assertAccess(nik, itemId, itemType, true);
    const now = new Date();
    if (itemType === 'FOLDER') {
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { trashedAt: now },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { trashedAt: now },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async restore(nik: string, itemId: string, itemType: ItemType) {
    if (itemType === 'FOLDER') {
      const folder = await this.prisma.dT_FOLDER.findUnique({ where: { id: itemId } });
      if (!folder || folder.ownerNik !== nik) throw new ForbiddenException('No access');
      const f = await this.prisma.dT_FOLDER.update({
        where: { id: itemId },
        data: { trashedAt: null },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      return this.serializeFolder(f);
    }
    const file = await this.prisma.dT_FILE.findUnique({ where: { id: itemId } });
    if (!file || file.ownerNik !== nik) throw new ForbiddenException('No access');
    const f = await this.prisma.dT_FILE.update({
      where: { id: itemId },
      data: { trashedAt: null },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    return this.serializeFile(f);
  }

  async permanentDelete(nik: string, itemId: string, itemType: ItemType) {
    if (itemType === 'FOLDER') {
      const folder = await this.prisma.dT_FOLDER.findUnique({ where: { id: itemId } });
      if (!folder || folder.ownerNik !== nik) throw new ForbiddenException('No access');
      await this.deleteFolderRecursive(folder.id, nik);
      return { deleted: true };
    }

    const file = await this.prisma.dT_FILE.findUnique({ where: { id: itemId } });
    if (!file || file.ownerNik !== nik) throw new ForbiddenException('No access');

    try {
      await this.storage.deleteFile(file.dropboxPath);
    } catch {
      // ignore missing dropbox file
    }

    await this.prisma.$transaction([
      this.prisma.dT_SHARE.deleteMany({ where: { itemId, itemType: 'FILE' } }),
      this.prisma.dT_SHARE_LINK.deleteMany({ where: { itemId, itemType: 'FILE' } }),
      this.prisma.dT_FILE.delete({ where: { id: itemId } }),
      this.prisma.dT_USER_QUOTA.update({
        where: { nik },
        data: { usedBytes: { decrement: file.bytes } },
      }),
    ]);

    return { deleted: true };
  }

  private async deleteFolderRecursive(folderId: string, nik: string) {
    const children = await this.prisma.dT_FOLDER.findMany({ where: { parentId: folderId } });
    for (const child of children) {
      await this.deleteFolderRecursive(child.id, nik);
    }

    const files = await this.prisma.dT_FILE.findMany({ where: { folderId } });
    for (const file of files) {
      try {
        await this.storage.deleteFile(file.dropboxPath);
      } catch {
        // ignore
      }
      await this.prisma.$transaction([
        this.prisma.dT_SHARE.deleteMany({ where: { itemId: file.id, itemType: 'FILE' } }),
        this.prisma.dT_SHARE_LINK.deleteMany({ where: { itemId: file.id, itemType: 'FILE' } }),
        this.prisma.dT_FILE.delete({ where: { id: file.id } }),
        this.prisma.dT_USER_QUOTA.update({
          where: { nik },
          data: { usedBytes: { decrement: file.bytes } },
        }),
      ]);
    }

    await this.prisma.$transaction([
      this.prisma.dT_SHARE.deleteMany({ where: { itemId: folderId, itemType: 'FOLDER' } }),
      this.prisma.dT_SHARE_LINK.deleteMany({ where: { itemId: folderId, itemType: 'FOLDER' } }),
      this.prisma.dT_FOLDER.delete({ where: { id: folderId } }),
    ]);
  }

  async uploadFile(
    nik: string,
    file: Express.Multer.File,
    folderId?: string,
    localPath?: string,
  ) {
    if (folderId) await this.assertAccess(nik, folderId, 'FOLDER', true);

    const size = BigInt(file.size);
    const quota = await this.userService.ensureQuota(nik);
    if (quota.usedBytes + size > quota.limitBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }

    const safeName = file.originalname.replace(/[^\w.\- ()]/g, '_');
    const dropboxRel = `${nik}/${folderId || 'root'}/${Date.now()}_${safeName}`;

    let uploaded: { url: string; path: string };
    try {
      if (localPath) {
        uploaded = await this.storage.uploadLocalFileWithShareOptions(
          dropboxRel,
          localPath,
          file.size,
          file.mimetype || 'application/octet-stream',
        );
      } else {
        uploaded = await this.storage.uploadFile(
          dropboxRel,
          file.buffer,
          file.mimetype || 'application/octet-stream',
        );
      }
    } finally {
      if (localPath) {
        try {
          await unlink(localPath);
        } catch {
          // ignore
        }
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dT_FILE.create({
        data: {
          name: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          bytes: size,
          dropboxPath: uploaded.path,
          url: uploaded.url,
          folderId: folderId || null,
          ownerNik: nik,
        },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      await tx.dT_USER_QUOTA.update({
        where: { nik },
        data: { usedBytes: { increment: size } },
      });
      return row;
    });

    return this.serializeFile(created);
  }

  async getDownloadUrl(nik: string, fileId: string) {
    await this.assertAccess(nik, fileId, 'FILE', false);
    const file = await this.prisma.dT_FILE.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');
    const url = file.url || (await this.storage.getFileUrl(file.dropboxPath));
    return { url, name: file.name, mimeType: file.mimeType, bytes: file.bytes.toString() };
  }

  /** Bytes for inline Quick View — never force Content-Disposition: attachment. */
  async getPreviewBuffer(nik: string, fileId: string) {
    await this.assertAccess(nik, fileId, 'FILE', false);
    const file = await this.prisma.dT_FILE.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('File not found');
    const buffer = await this.storage.downloadFile(file.dropboxPath);
    return {
      buffer,
      name: file.name,
      mimeType: file.mimeType || 'application/octet-stream',
    };
  }

  async getItem(nik: string, itemId: string, itemType: ItemType) {
    await this.assertAccess(nik, itemId, itemType, false);
    if (itemType === 'FOLDER') {
      const f = await this.prisma.dT_FOLDER.findUnique({
        where: { id: itemId },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      if (!f) throw new NotFoundException('Folder not found');
      const fileAgg = await this.prisma.dT_FILE.aggregate({
        where: { folderId: itemId, trashedAt: null, ownerNik: f.ownerNik },
        _sum: { bytes: true },
      });
      return {
        ...this.serializeFolder(f),
        sizeBytes: (fileAgg._sum.bytes || BigInt(0)).toString(),
      };
    }
    const f = await this.prisma.dT_FILE.findUnique({
      where: { id: itemId },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    if (!f) throw new NotFoundException('File not found');
    return this.serializeFile(f);
  }

  async getQuota(nik: string) {
    const quota = await this.userService.ensureQuota(nik);
    return {
      limitBytes: quota.limitBytes.toString(),
      usedBytes: quota.usedBytes.toString(),
    };
  }

  async copyFileFull(nik: string, fileId: string) {
    await this.assertAccess(nik, fileId, 'FILE', false);
    const source = await this.prisma.dT_FILE.findUnique({ where: { id: fileId } });
    if (!source) throw new NotFoundException('File not found');

    const quota = await this.userService.ensureQuota(nik);
    if (quota.usedBytes + source.bytes > quota.limitBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }

    // Fetch file content via temporary shared URL is unreliable for binary.
    // Create a logical copy sharing Dropbox path but new DB row — NOT ideal for delete.
    // Instead: download via Dropbox getTemporaryLink if available.
    const newName = `Copy of ${source.name}`;
    const dropboxRel = `${nik}/${source.folderId || 'root'}/${Date.now()}_${randomUUID().slice(0, 8)}_${source.name}`;

    // Use storage getFileUrl then axios — skip; for MVP create metadata-only duplicate with same path
    // and still increment quota (simple). Permanent delete of one should not delete Dropbox if shared.
    // Better MVP: re-upload empty thin link. Let's re-upload by downloading from Dropbox shared URL.

    const url = source.url || (await this.storage.getFileUrl(source.dropboxPath));
    const res = await fetch(url);
    if (!res.ok) throw new BadRequestException('Failed to read source file for copy');
    const buf = Buffer.from(await res.arrayBuffer());
    const uploaded = await this.storage.uploadFile(
      dropboxRel,
      buf,
      source.mimeType || 'application/octet-stream',
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.dT_FILE.create({
        data: {
          name: newName,
          mimeType: source.mimeType,
          bytes: source.bytes,
          dropboxPath: uploaded.path,
          url: uploaded.url,
          folderId: source.folderId,
          ownerNik: nik,
        },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      await tx.dT_USER_QUOTA.update({
        where: { nik },
        data: { usedBytes: { increment: source.bytes } },
      });
      return row;
    });

    return this.serializeFile(created);
  }
}
