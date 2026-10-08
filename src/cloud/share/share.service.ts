import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CloudPrismaService } from '../prisma/prisma.service';
import { DriveService } from '../drive/drive.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { comparePassword, encodePassword } from '../utils/bcrypt';
import { randomBytes } from 'crypto';

@Injectable()
export class ShareService {
  constructor(
    private prisma: CloudPrismaService,
    private driveService: DriveService,
    private storage: DropboxStorageService,
  ) {}

  async listShares(nik: string, itemId: string, itemType: 'FILE' | 'FOLDER') {
    await this.driveService.assertAccess(nik, itemId, itemType, true);
    const shares = await this.prisma.dT_SHARE.findMany({
      where: { itemId, itemType },
      include: {
        target: { select: { nik: true, nama: true, email: true, photo: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return shares.map((s) => ({
      id: s.id,
      permission: s.permission,
      createdAt: s.createdAt,
      user: s.target,
    }));
  }

  async addShare(
    nik: string,
    itemId: string,
    itemType: 'FILE' | 'FOLDER',
    targetNik: string,
    permission: 'VIEW' | 'EDIT',
  ) {
    await this.driveService.assertAccess(nik, itemId, itemType, true);
    if (targetNik === nik) throw new BadRequestException('Cannot share with yourself');

    const target = await this.prisma.dT_USER.findUnique({ where: { nik: targetNik } });
    if (!target || !target.statusActive) throw new NotFoundException('Target user not found');

    const share = await this.prisma.dT_SHARE.upsert({
      where: {
        itemId_itemType_targetNik: { itemId, itemType, targetNik },
      },
      create: {
        itemId,
        itemType,
        targetNik,
        permission,
        createdBy: nik,
      },
      update: { permission },
      include: {
        target: { select: { nik: true, nama: true, email: true, photo: true } },
      },
    });

    return {
      id: share.id,
      permission: share.permission,
      createdAt: share.createdAt,
      user: share.target,
    };
  }

  async removeShare(nik: string, shareId: string) {
    const share = await this.prisma.dT_SHARE.findUnique({ where: { id: shareId } });
    if (!share) throw new NotFoundException('Share not found');
    await this.driveService.assertAccess(nik, share.itemId, share.itemType as any, true);
    await this.prisma.dT_SHARE.delete({ where: { id: shareId } });
    return { deleted: true };
  }

  async createShareLink(
    nik: string,
    itemId: string,
    itemType: 'FILE' | 'FOLDER',
    opts?: { permission?: 'VIEW' | 'EDIT'; password?: string; expiresAt?: string },
  ) {
    await this.driveService.assertAccess(nik, itemId, itemType, true);

    const token = randomBytes(24).toString('hex');
    const passwordHash = opts?.password ? encodePassword(opts.password) : null;
    const expiresAt = opts?.expiresAt ? new Date(opts.expiresAt) : null;

    const link = await this.prisma.dT_SHARE_LINK.create({
      data: {
        token,
        itemId,
        itemType,
        permission: opts?.permission || 'VIEW',
        passwordHash,
        expiresAt,
        createdBy: nik,
      },
    });

    return {
      id: link.id,
      token: link.token,
      url: `/s/${link.token}`,
      permission: link.permission,
      expiresAt: link.expiresAt,
      hasPassword: Boolean(passwordHash),
    };
  }

  async listShareLinks(nik: string, itemId: string, itemType: 'FILE' | 'FOLDER') {
    await this.driveService.assertAccess(nik, itemId, itemType, true);
    const links = await this.prisma.dT_SHARE_LINK.findMany({
      where: { itemId, itemType, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return links.map((l) => ({
      id: l.id,
      token: l.token,
      url: `/s/${l.token}`,
      permission: l.permission,
      expiresAt: l.expiresAt,
      hasPassword: Boolean(l.passwordHash),
      createdAt: l.createdAt,
    }));
  }

  async revokeShareLink(nik: string, linkId: string) {
    const link = await this.prisma.dT_SHARE_LINK.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Link not found');
    await this.driveService.assertAccess(nik, link.itemId, link.itemType as any, true);
    await this.prisma.dT_SHARE_LINK.update({
      where: { id: linkId },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  async resolvePublicLink(token: string, password?: string) {
    const link = await this.prisma.dT_SHARE_LINK.findUnique({ where: { token } });
    if (!link || link.revokedAt) throw new NotFoundException('Link not found');
    if (link.expiresAt && new Date() > link.expiresAt) {
      throw new ForbiddenException('Link expired');
    }
    if (link.passwordHash) {
      if (!password) throw new UnauthorizedException('Password required');
      const ok = await comparePassword(password, link.passwordHash);
      if (!ok) throw new UnauthorizedException('Invalid password');
    }

    if (link.itemType === 'FOLDER') {
      const folder = await this.prisma.dT_FOLDER.findUnique({
        where: { id: link.itemId },
        include: { owner: { select: { nik: true, nama: true } } },
      });
      if (!folder || folder.trashedAt) throw new NotFoundException('Folder not found');
      return {
        itemType: 'FOLDER' as const,
        permission: link.permission,
        item: {
          id: folder.id,
          name: folder.name,
          description: folder.description,
          owner: folder.owner,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
        },
      };
    }

    const file = await this.prisma.dT_FILE.findUnique({
      where: { id: link.itemId },
      include: { owner: { select: { nik: true, nama: true } } },
    });
    if (!file || file.trashedAt) throw new NotFoundException('File not found');
    const url = file.url || (await this.storage.getFileUrl(file.dropboxPath));
    return {
      itemType: 'FILE' as const,
      permission: link.permission,
      item: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        bytes: file.bytes.toString(),
        url,
        description: file.description,
        owner: file.owner,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      },
    };
  }
}
