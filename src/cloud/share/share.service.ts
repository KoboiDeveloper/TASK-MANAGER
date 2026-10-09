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
import { PushService } from '../../notifications/push.service';

@Injectable()
export class ShareService {
  constructor(
    private prisma: CloudPrismaService,
    private driveService: DriveService,
    private storage: DropboxStorageService,
    private pushService: PushService,
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

    // Native / in-app notify for the recipient (Socket.IO + Web Push)
    void this.notifyShareTarget(nik, targetNik, itemId, itemType).catch(() => undefined);

    return {
      id: share.id,
      permission: share.permission,
      createdAt: share.createdAt,
      user: share.target,
    };
  }

  private async notifyShareTarget(
    sharerNik: string,
    targetNik: string,
    itemId: string,
    itemType: 'FILE' | 'FOLDER',
  ): Promise<void> {
    const sharer = await this.prisma.dT_USER.findUnique({
      where: { nik: sharerNik },
      select: { nama: true },
    });
    const sharerName = sharer?.nama?.trim() || sharerNik;

    let itemName = itemType === 'FOLDER' ? 'Folder' : 'File';
    if (itemType === 'FOLDER') {
      const folder = await this.prisma.dT_FOLDER.findUnique({
        where: { id: itemId },
        select: { name: true },
      });
      if (folder?.name) itemName = folder.name;
    } else {
      const file = await this.prisma.dT_FILE.findUnique({
        where: { id: itemId },
        select: { name: true },
      });
      if (file?.name) itemName = file.name;
    }

    this.pushService.notifyUser(targetNik, {
      type: 'cloud.item_shared',
      title: itemType === 'FOLDER' ? 'Folder dibagikan' : 'File dibagikan',
      body: `${sharerName}: ${itemName}`,
      url: '/dashboard/cloud',
      tag: `cloud-share-${itemType}-${itemId}`,
    });
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
