import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatEvents } from './chat.events';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { PushService } from '../notifications/push.service';
import {
  AddMembersDto,
  CreateRoomDto,
  MarkReadDto,
  SendMessageDto,
  ToggleReactionDto,
  UpdateRoomDto,
} from './dto/chat.dto';
import { randomUUID } from 'crypto';

type TaskRef = {
  taskId: string;
  projectId: string;
  projectName: string;
  projectColor?: string | null;
  name: string;
  status: boolean;
  dueDate?: string | null;
  assignees?: { nik: string; nama?: string }[];
};

type ChatReaction = { emoji: string; niks: string[] };

type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string | null;
};

type ChatMessageDto = {
  id: string;
  roomId: string;
  senderNik: string;
  type: string;
  content: string;
  taskRef: TaskRef | null;
  attachments: ChatAttachment[];
  replyToId: string | null;
  reactions: ChatReaction[];
  readBy: string[];
  status: 'sent' | 'delivered' | 'read';
  createdAt: string;
  editedAt: string | null;
  clientId?: string;
};

type ChatRoomDto = {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  emoji: string | null;
  color: string | null;
  members: { nik: string; role: 'owner' | 'member'; joinedAt: string }[];
  createdBy: string;
  createdAt: string;
  isPinned: boolean;
  isMuted: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  pinnedTasks: TaskRef[];
  showTaskPanel: boolean;
  lastMessage?: ChatMessageDto | null;
};

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatEvents,
    private readonly storage: DropboxStorageService,
    private readonly push: PushService,
  ) {}

  private async resolveTask(taskId: string) {
    const raw = (taskId || '').trim();
    if (!raw) return null;
    const isGuid = /^[0-9a-fA-F-]{36}$/.test(raw);
    return this.prisma.dT_TASK.findFirst({
      where: isGuid ? { id: raw } : { shortId: raw.toLowerCase() },
      include: {
        project: { select: { id: true, name: true, color: true } },
        assignees: { include: { user: { select: { nik: true, nama: true } } } },
      },
    });
  }

  private parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private iso(d?: Date | null): string | null {
    return d ? d.toISOString() : null;
  }

  private dmKey(a: string, b: string): string {
    return [a.trim(), b.trim()].sort().join('|');
  }

  private mapMessage(
    m: {
      id: string;
      roomId: string;
      senderNik: string;
      type: string;
      content: string;
      taskRefJson: string | null;
      attachmentsJson?: string | null;
      replyToId: string | null;
      reactionsJson: string | null;
      readByJson: string | null;
      createdAt: Date;
      editedAt: Date | null;
      deletedAt?: Date | null;
    },
    viewerNik?: string,
  ): ChatMessageDto | null {
    if (m.deletedAt) return null;
    const readBy = this.parseJson<string[]>(m.readByJson, []);
    let status: ChatMessageDto['status'] = 'sent';
    if (viewerNik && m.senderNik === viewerNik) {
      const othersRead = readBy.filter((n) => n !== viewerNik);
      status = othersRead.length > 0 ? 'read' : 'delivered';
    } else {
      status = 'delivered';
    }
    return {
      id: m.id,
      roomId: m.roomId,
      senderNik: m.senderNik.trim(),
      type: m.type,
      content: m.content,
      taskRef: this.parseJson<TaskRef | null>(m.taskRefJson, null),
      attachments: this.parseJson<ChatAttachment[]>(m.attachmentsJson, []),
      replyToId: m.replyToId,
      reactions: this.parseJson<ChatReaction[]>(m.reactionsJson, []),
      readBy,
      status,
      createdAt: m.createdAt.toISOString(),
      editedAt: this.iso(m.editedAt),
    };
  }

  private mapPinned(p: {
    taskId: string;
    projectId: string;
    projectName: string;
    projectColor: string | null;
    name: string;
    status: boolean;
    dueDate: Date | null;
  }): TaskRef {
    return {
      taskId: p.taskId,
      projectId: p.projectId,
      projectName: p.projectName,
      projectColor: p.projectColor,
      name: p.name,
      status: p.status,
      dueDate: this.iso(p.dueDate),
    };
  }

  private mapRoom(
    room: {
      id: string;
      type: string;
      name: string | null;
      emoji: string | null;
      color: string | null;
      createdBy: string;
      createdAt: Date;
      lastMessageAt: Date | null;
      members: {
        nik: string;
        role: string;
        joinedAt: Date;
        isPinned: boolean;
        isMuted: boolean;
        showTaskPanel: boolean;
        unreadCount: number;
      }[];
      pinnedTasks: {
        taskId: string;
        projectId: string;
        projectName: string;
        projectColor: string | null;
        name: string;
        status: boolean;
        dueDate: Date | null;
      }[];
      messages?: {
        id: string;
        roomId: string;
        senderNik: string;
        type: string;
        content: string;
        taskRefJson: string | null;
        replyToId: string | null;
        reactionsJson: string | null;
        readByJson: string | null;
        createdAt: Date;
        editedAt: Date | null;
        deletedAt: Date | null;
      }[];
    },
    viewerNik: string,
  ): ChatRoomDto {
    const me = room.members.find((m) => m.nik.trim() === viewerNik.trim());
    const last = room.messages?.[0] ? this.mapMessage(room.messages[0], viewerNik) : null;
    return {
      id: room.id,
      type: room.type as 'dm' | 'group',
      name: room.name,
      emoji: room.emoji,
      color: room.color,
      members: room.members.map((m) => ({
        nik: m.nik.trim(),
        role: (m.role === 'owner' ? 'owner' : 'member') as 'owner' | 'member',
        joinedAt: m.joinedAt.toISOString(),
      })),
      createdBy: room.createdBy.trim(),
      createdAt: room.createdAt.toISOString(),
      isPinned: me?.isPinned ?? false,
      isMuted: me?.isMuted ?? false,
      unreadCount: me?.unreadCount ?? 0,
      lastMessageAt: this.iso(room.lastMessageAt),
      pinnedTasks: room.pinnedTasks.map((p) => this.mapPinned(p)),
      showTaskPanel: me?.showTaskPanel ?? false,
      lastMessage: last,
    };
  }

  private roomInclude(viewerNik?: string) {
    return {
      members: true,
      pinnedTasks: { orderBy: { pinnedAt: 'desc' as const } },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
      },
    };
  }

  private async assertMember(roomId: string, nik: string) {
    const m = await this.prisma.dT_CHAT_MEMBER.findUnique({
      where: { roomId_nik: { roomId, nik } },
    });
    if (!m) throw new ForbiddenException('Not a member of this room');
    return m;
  }

  async getRooms(nik: string): Promise<ChatRoomDto[]> {
    const memberships = await this.prisma.dT_CHAT_MEMBER.findMany({
      where: { nik },
      select: { roomId: true },
    });
    if (!memberships.length) return [];
    const rooms = await this.prisma.dT_CHAT_ROOM.findMany({
      where: { id: { in: memberships.map((m) => m.roomId) } },
      include: this.roomInclude(nik),
    });
    const mapped = rooms.map((r) => this.mapRoom(r, nik));
    return mapped.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return tb - ta;
    });
  }

  async createRoom(nik: string, dto: CreateRoomDto): Promise<ChatRoomDto> {
    const others = Array.from(new Set(dto.memberNiks.map((n) => n.trim()).filter(Boolean)));
    const allNiks = Array.from(new Set([nik, ...others]));

    if (dto.type === 'dm') {
      if (others.length !== 1) throw new BadRequestException('DM requires exactly 1 other member');
      const key = this.dmKey(nik, others[0]);
      const existing = await this.prisma.dT_CHAT_ROOM.findUnique({
        where: { dmKey: key },
        include: this.roomInclude(nik),
      });
      if (existing) {
        const stillMember = existing.members.some((m) => m.nik.trim() === nik);
        if (stillMember) return this.mapRoom(existing, nik);
      }

      const users = await this.prisma.dT_USER.findMany({
        where: { nik: { in: allNiks }, statusActive: true },
        select: { nik: true },
      });
      if (users.length !== allNiks.length) throw new BadRequestException('User not found');

      const room = await this.prisma.dT_CHAT_ROOM.create({
        data: {
          type: 'dm',
          createdBy: nik,
          dmKey: key,
          lastMessageAt: new Date(),
          members: {
            create: allNiks.map((n) => ({
              nik: n,
              role: n === nik ? 'owner' : 'member',
              showTaskPanel: false,
            })),
          },
        },
        include: this.roomInclude(nik),
      });
      const mapped = this.mapRoom(room, nik);
      for (const n of allNiks) {
        this.gateway.emitToUser(n, 'room:created', this.mapRoom(room, n));
      }
      const partner = others[0];
      if (partner) {
        const sender = await this.prisma.dT_USER.findUnique({
          where: { nik },
          select: { nama: true },
        });
        this.push.notifyUser(partner, {
          type: 'chat.new_dm',
          title: 'Chat baru',
          body: `${sender?.nama ?? nik} mulai chat denganmu`,
          url: `/dashboard/chat?room=${room.id}`,
          tag: `chat-dm-${room.id}`,
          data: { roomId: room.id },
        });
      }
      return mapped;
    }

    // group
    if (!dto.name?.trim()) throw new BadRequestException('Group name is required');
    const users = await this.prisma.dT_USER.findMany({
      where: { nik: { in: allNiks }, statusActive: true },
      select: { nik: true },
    });
    if (users.length !== allNiks.length) throw new BadRequestException('User not found');

    const room = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dT_CHAT_ROOM.create({
        data: {
          type: 'group',
          name: dto.name!.trim(),
          emoji: dto.emoji ?? '💬',
          color: dto.color ?? 'ocean',
          createdBy: nik,
          lastMessageAt: new Date(),
          members: {
            create: allNiks.map((n) => ({
              nik: n,
              role: n === nik ? 'owner' : 'member',
              showTaskPanel: true,
            })),
          },
        },
      });
      await tx.dT_CHAT_MESSAGE.create({
        data: {
          roomId: created.id,
          senderNik: 'system',
          type: 'system',
          content: `Grup ${created.name} dibuat`,
          reactionsJson: '[]',
          readByJson: '[]',
        },
      });
      return tx.dT_CHAT_ROOM.findUniqueOrThrow({
        where: { id: created.id },
        include: this.roomInclude(nik),
      });
    });

    const mapped = this.mapRoom(room, nik);
    for (const n of allNiks) {
      this.gateway.emitToUser(n, 'room:created', this.mapRoom(room, n));
    }
    const creator = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { nama: true },
    });
    this.push.notifyUsers(
      others,
      {
        type: 'chat.added_to_group',
        title: 'Ditambahkan ke grup',
        body: `${creator?.nama ?? nik} menambahkanmu ke ${room.name ?? 'grup'}`,
        url: `/dashboard/chat?room=${room.id}`,
        tag: `chat-group-${room.id}`,
        data: { roomId: room.id },
      },
      nik,
    );
    return mapped;
  }

  async updateRoom(nik: string, roomId: string, dto: UpdateRoomDto): Promise<ChatRoomDto> {
    await this.assertMember(roomId, nik);
    const room = await this.prisma.dT_CHAT_ROOM.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    if (dto.name !== undefined || dto.emoji !== undefined || dto.color !== undefined) {
      if (room.type !== 'group') throw new BadRequestException('Only groups can be renamed');
      await this.prisma.dT_CHAT_ROOM.update({
        where: { id: roomId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.emoji !== undefined ? { emoji: dto.emoji } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
        },
      });
    }

    if (
      dto.isPinned !== undefined ||
      dto.isMuted !== undefined ||
      dto.showTaskPanel !== undefined
    ) {
      await this.prisma.dT_CHAT_MEMBER.update({
        where: { roomId_nik: { roomId, nik } },
        data: {
          ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
          ...(dto.isMuted !== undefined ? { isMuted: dto.isMuted } : {}),
          ...(dto.showTaskPanel !== undefined ? { showTaskPanel: dto.showTaskPanel } : {}),
        },
      });
    }

    const full = await this.prisma.dT_CHAT_ROOM.findUniqueOrThrow({
      where: { id: roomId },
      include: this.roomInclude(nik),
    });
    const mapped = this.mapRoom(full, nik);

    // broadcast public room fields; prefs are per-user so emit to each member their view
    for (const m of full.members) {
      this.gateway.emitToUser(m.nik.trim(), 'room:updated', this.mapRoom(full, m.nik.trim()));
    }
    this.gateway.emitToRoom(roomId, 'room:updated', {
      id: roomId,
      name: mapped.name,
      emoji: mapped.emoji,
      color: mapped.color,
    });
    return mapped;
  }

  async addMembers(nik: string, roomId: string, dto: AddMembersDto): Promise<ChatRoomDto> {
    const me = await this.assertMember(roomId, nik);
    const room = await this.prisma.dT_CHAT_ROOM.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');
    if (room.type !== 'group') throw new BadRequestException('Cannot add members to DM');

    const existing = await this.prisma.dT_CHAT_MEMBER.findMany({
      where: { roomId },
      select: { nik: true },
    });
    const existingSet = new Set(existing.map((e) => e.nik.trim()));
    const fresh = Array.from(new Set(dto.niks.map((n) => n.trim()))).filter(
      (n) => n && !existingSet.has(n),
    );
    if (!fresh.length) {
      const full = await this.prisma.dT_CHAT_ROOM.findUniqueOrThrow({
        where: { id: roomId },
        include: this.roomInclude(nik),
      });
      return this.mapRoom(full, nik);
    }

    const users = await this.prisma.dT_USER.findMany({
      where: { nik: { in: fresh }, statusActive: true },
      select: { nik: true, nama: true },
    });
    if (users.length !== fresh.length) throw new BadRequestException('User not found');

    const adder = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { nama: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.dT_CHAT_MEMBER.createMany({
        data: fresh.map((n) => ({
          roomId,
          nik: n,
          role: 'member',
          showTaskPanel: true,
        })),
      });
      await tx.dT_CHAT_MESSAGE.create({
        data: {
          roomId,
          senderNik: 'system',
          type: 'system',
          content: `${adder?.nama ?? nik} menambahkan ${users.map((u) => u.nama).join(', ')}`,
          reactionsJson: '[]',
          readByJson: '[]',
        },
      });
      await tx.dT_CHAT_ROOM.update({
        where: { id: roomId },
        data: { lastMessageAt: new Date() },
      });
    });

    const full = await this.prisma.dT_CHAT_ROOM.findUniqueOrThrow({
      where: { id: roomId },
      include: this.roomInclude(nik),
    });
    this.gateway.emitToRoom(roomId, 'room:member-added', { roomId, niks: fresh });
    for (const n of fresh) {
      this.gateway.emitToUser(n, 'room:created', this.mapRoom(full, n));
    }
    for (const m of full.members) {
      this.gateway.emitToUser(m.nik.trim(), 'room:updated', this.mapRoom(full, m.nik.trim()));
    }
    this.push.notifyUsers(
      fresh,
      {
        type: 'chat.added_to_group',
        title: 'Ditambahkan ke grup',
        body: `${adder?.nama ?? nik} menambahkanmu ke ${room.name ?? 'grup'}`,
        url: `/dashboard/chat?room=${roomId}`,
        tag: `chat-group-${roomId}`,
        data: { roomId },
      },
      nik,
    );
    void me;
    return this.mapRoom(full, nik);
  }

  async leaveRoom(nik: string, roomId: string): Promise<void> {
    await this.assertMember(roomId, nik);
    const room = await this.prisma.dT_CHAT_ROOM.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    await this.prisma.dT_CHAT_MEMBER.delete({
      where: { roomId_nik: { roomId, nik } },
    });

    if (room.type === 'group') {
      const user = await this.prisma.dT_USER.findUnique({
        where: { nik },
        select: { nama: true },
      });
      await this.prisma.dT_CHAT_MESSAGE.create({
        data: {
          roomId,
          senderNik: 'system',
          type: 'system',
          content: `${user?.nama ?? nik} meninggalkan grup`,
          reactionsJson: '[]',
          readByJson: '[]',
        },
      });
    }

    this.gateway.emitToRoom(roomId, 'room:member-left', { roomId, nik });
  }

  async getMessages(
    nik: string,
    roomId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ data: ChatMessageDto[]; nextCursor: string | null }> {
    await this.assertMember(roomId, nik);
    const take = Math.min(Math.max(limit, 1), 100);

    let cursorCreatedAt: Date | undefined;
    if (cursor) {
      const cursorMsg = await this.prisma.dT_CHAT_MESSAGE.findUnique({
        where: { id: cursor },
        select: { createdAt: true, roomId: true },
      });
      if (!cursorMsg || cursorMsg.roomId !== roomId) {
        throw new BadRequestException('Invalid cursor');
      }
      cursorCreatedAt = cursorMsg.createdAt;
    }

    const rows = await this.prisma.dT_CHAT_MESSAGE.findMany({
      where: {
        roomId,
        deletedAt: null,
        ...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    const chronological = slice.reverse();
    const data = chronological
      .map((m) => this.mapMessage(m, nik))
      .filter((m): m is ChatMessageDto => Boolean(m));
    // cursor = oldest message id in this page (for loading older messages)
    return { data, nextCursor: hasMore ? data[0]?.id ?? null : null };
  }

  async sendMessage(
    nik: string,
    roomId: string,
    dto: SendMessageDto,
  ): Promise<ChatMessageDto & { clientId?: string }> {
    await this.assertMember(roomId, nik);
    const type =
      dto.type ??
      (dto.taskRef ? 'task' : dto.attachments?.length ? 'file' : 'text');
    if (type === 'system') throw new BadRequestException('Cannot send system messages');

    let taskRefJson: string | null = null;
    let attachmentsJson: string | null = null;
    if (dto.attachments?.length) {
      attachmentsJson = JSON.stringify(dto.attachments);
    }
    if (type === 'task') {
      if (!dto.taskRef || typeof dto.taskRef !== 'object') {
        throw new BadRequestException('taskRef required for task messages');
      }
      const taskId = String((dto.taskRef as TaskRef).taskId || '');
      if (taskId) {
        const task = await this.resolveTask(taskId);
        if (task) {
          const ref: TaskRef = {
            taskId: task.id,
            projectId: task.project.id,
            projectName: task.project.name,
            projectColor: task.project.color,
            name: task.name,
            status: task.status,
            dueDate: this.iso(task.dueDate),
            assignees: task.assignees.map((a) => ({
              nik: a.nik.trim(),
              nama: a.user.nama,
            })),
          };
          taskRefJson = JSON.stringify(ref);
        } else {
          taskRefJson = JSON.stringify(dto.taskRef);
        }
      } else {
        taskRefJson = JSON.stringify(dto.taskRef);
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.dT_CHAT_MESSAGE.create({
        data: {
          roomId,
          senderNik: nik,
          type,
          content: dto.content ?? '',
          taskRefJson,
          attachmentsJson,
          replyToId: dto.replyToId || null,
          reactionsJson: '[]',
          readByJson: JSON.stringify([nik]),
        },
      });
      await tx.dT_CHAT_ROOM.update({
        where: { id: roomId },
        data: { lastMessageAt: msg.createdAt },
      });
      await tx.dT_CHAT_MEMBER.updateMany({
        where: { roomId, nik: { not: nik } },
        data: { unreadCount: { increment: 1 } },
      });
      return msg;
    });

    const mapped = this.mapMessage(created, nik)!;
    const payload = { ...mapped, clientId: dto.clientId };
    this.gateway.emitToRoom(roomId, 'message:new', payload);

    // notify members of room list update (unread)
    const members = await this.prisma.dT_CHAT_MEMBER.findMany({ where: { roomId } });
    for (const m of members) {
      if (m.nik.trim() === nik) continue;
      this.gateway.emitToUser(m.nik.trim(), 'room:updated', {
        id: roomId,
        lastMessageAt: mapped.createdAt,
        unreadCount: m.unreadCount + 1,
        lastMessage: mapped,
      });
    }

    const roomMeta = await this.prisma.dT_CHAT_ROOM.findUnique({
      where: { id: roomId },
      select: { type: true, name: true },
    });
    const sender = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { nama: true },
    });
    const senderName = sender?.nama ?? nik;
    const preview =
      type === 'task'
        ? `membagikan task`
        : (dto.content || '').trim().slice(0, 120) ||
          (dto.attachments?.length ? 'mengirim lampiran' : 'pesan baru');
    const recipientNiks = members.map((m) => m.nik.trim()).filter((n) => n !== nik);
    const chatUrl = `/dashboard/chat?room=${roomId}`;

    if (dto.replyToId) {
      const parent = await this.prisma.dT_CHAT_MESSAGE.findUnique({
        where: { id: dto.replyToId },
        select: { senderNik: true },
      });
      const replyTarget = parent?.senderNik?.trim();
      if (replyTarget && replyTarget !== nik && replyTarget !== 'system') {
        this.push.notifyUser(replyTarget, {
          type: 'chat.reply',
          title: 'Balasan pesan',
          body: `${senderName}: ${preview}`,
          url: chatUrl,
          tag: `chat-reply-${dto.replyToId}`,
          data: { roomId, messageId: mapped.id },
        });
      }
    }

    if (type === 'task') {
      this.push.notifyUsers(
        recipientNiks,
        {
          type: 'chat.task_shared',
          title: 'Task dibagikan di chat',
          body: `${senderName} membagikan task di ${roomMeta?.type === 'group' ? roomMeta.name || 'grup' : 'DM'}`,
          url: chatUrl,
          tag: `chat-task-${mapped.id}`,
          data: { roomId, messageId: mapped.id },
        },
        nik,
      );
    } else {
      const isDm = roomMeta?.type === 'dm';
      this.push.notifyUsers(
        recipientNiks.filter((n) => {
          const mem = members.find((m) => m.nik.trim() === n);
          return !mem?.isMuted;
        }),
        {
          type: isDm ? 'chat.dm_message' : 'chat.group_message',
          title: isDm ? 'Pesan baru' : `Pesan di ${roomMeta?.name || 'grup'}`,
          body: `${senderName}: ${preview}`,
          url: chatUrl,
          tag: `chat-msg-${roomId}`,
          data: { roomId, messageId: mapped.id },
        },
        nik,
      );
    }

    return payload;
  }

  async deleteMessage(nik: string, messageId: string): Promise<void> {
    const msg = await this.prisma.dT_CHAT_MESSAGE.findUnique({ where: { id: messageId } });
    if (!msg || msg.deletedAt) throw new NotFoundException('Message not found');
    await this.assertMember(msg.roomId, nik);
    if (msg.senderNik.trim() !== nik && msg.senderNik.trim() !== 'system') {
      // only sender can delete (system stays)
      if (msg.senderNik.trim() !== nik) {
        throw new ForbiddenException('Cannot delete this message');
      }
    }
    if (msg.senderNik.trim() === 'system') {
      throw new ForbiddenException('Cannot delete system message');
    }
    await this.prisma.dT_CHAT_MESSAGE.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
    this.gateway.emitToRoom(msg.roomId, 'message:deleted', {
      id: messageId,
      roomId: msg.roomId,
    });
  }

  async markRead(nik: string, roomId: string, dto: MarkReadDto): Promise<void> {
    await this.assertMember(roomId, nik);
    const msg = await this.prisma.dT_CHAT_MESSAGE.findUnique({
      where: { id: dto.lastMessageId },
    });
    if (!msg || msg.roomId !== roomId) throw new BadRequestException('Invalid lastMessageId');

    await this.prisma.dT_CHAT_MEMBER.update({
      where: { roomId_nik: { roomId, nik } },
      data: { unreadCount: 0, lastReadMessageId: dto.lastMessageId },
    });

    // update readBy on messages from others up to lastMessageId time
    const unreadMsgs = await this.prisma.dT_CHAT_MESSAGE.findMany({
      where: {
        roomId,
        deletedAt: null,
        senderNik: { not: nik },
        createdAt: { lte: msg.createdAt },
      },
      select: { id: true, readByJson: true },
    });
    for (const m of unreadMsgs) {
      const readBy = this.parseJson<string[]>(m.readByJson, []);
      if (!readBy.includes(nik)) {
        readBy.push(nik);
        await this.prisma.dT_CHAT_MESSAGE.update({
          where: { id: m.id },
          data: { readByJson: JSON.stringify(readBy) },
        });
      }
    }

    this.gateway.emitToRoom(roomId, 'message:read', {
      roomId,
      nik,
      lastMessageId: dto.lastMessageId,
    });
  }

  async toggleReaction(
    nik: string,
    messageId: string,
    dto: ToggleReactionDto,
  ): Promise<ChatReaction[]> {
    const msg = await this.prisma.dT_CHAT_MESSAGE.findUnique({ where: { id: messageId } });
    if (!msg || msg.deletedAt) throw new NotFoundException('Message not found');
    await this.assertMember(msg.roomId, nik);

    let reactions = this.parseJson<ChatReaction[]>(msg.reactionsJson, []);
    const existing = reactions.find((r) => r.emoji === dto.emoji);
    if (!existing) {
      reactions = [...reactions, { emoji: dto.emoji, niks: [nik] }];
    } else if (existing.niks.includes(nik)) {
      reactions = reactions
        .map((r) =>
          r.emoji === dto.emoji ? { ...r, niks: r.niks.filter((n) => n !== nik) } : r,
        )
        .filter((r) => r.niks.length > 0);
    } else {
      reactions = reactions.map((r) =>
        r.emoji === dto.emoji ? { ...r, niks: [...r.niks, nik] } : r,
      );
    }

    await this.prisma.dT_CHAT_MESSAGE.update({
      where: { id: messageId },
      data: { reactionsJson: JSON.stringify(reactions) },
    });

    this.gateway.emitToRoom(msg.roomId, 'message:reaction', {
      roomId: msg.roomId,
      messageId,
      reactions,
    });

    const added = !existing || !existing.niks.includes(nik);
    const stillHas = reactions.some((r) => r.emoji === dto.emoji && r.niks.includes(nik));
    if (added && stillHas) {
      const ownerNik = msg.senderNik.trim();
      if (ownerNik && ownerNik !== nik && ownerNik !== 'system') {
        const reactor = await this.prisma.dT_USER.findUnique({
          where: { nik },
          select: { nama: true },
        });
        this.push.notifyUser(ownerNik, {
          type: 'chat.reaction',
          title: 'Reaksi pesan',
          body: `${reactor?.nama ?? nik} bereaksi ${dto.emoji} ke pesanmu`,
          url: `/dashboard/chat?room=${msg.roomId}`,
          tag: `chat-react-${messageId}`,
          data: { roomId: msg.roomId, messageId },
        });
      }
    }

    return reactions;
  }

  async pinTask(nik: string, roomId: string, taskId: string): Promise<TaskRef[]> {
    await this.assertMember(roomId, nik);
    const task = await this.resolveTask(taskId);
    if (!task) throw new NotFoundException('Task not found');

    const ref: TaskRef = {
      taskId: task.id,
      projectId: task.project.id,
      projectName: task.project.name,
      projectColor: task.project.color,
      name: task.name,
      status: task.status,
      dueDate: this.iso(task.dueDate),
      assignees: task.assignees.map((a) => ({ nik: a.nik.trim(), nama: a.user.nama })),
    };

    await this.prisma.dT_CHAT_PINNED_TASK.upsert({
      where: { roomId_taskId: { roomId, taskId: task.id } },
      create: {
        roomId,
        taskId: task.id,
        projectId: ref.projectId,
        projectName: ref.projectName,
        projectColor: ref.projectColor ?? null,
        name: ref.name,
        status: ref.status,
        dueDate: task.dueDate,
        pinnedBy: nik,
      },
      update: {
        projectName: ref.projectName,
        projectColor: ref.projectColor ?? null,
        name: ref.name,
        status: ref.status,
        dueDate: task.dueDate,
      },
    });

    await this.prisma.dT_CHAT_MEMBER.update({
      where: { roomId_nik: { roomId, nik } },
      data: { showTaskPanel: true },
    });

    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { nama: true },
    });
    const sys = await this.prisma.dT_CHAT_MESSAGE.create({
      data: {
        roomId,
        senderNik: 'system',
        type: 'system',
        content: `${user?.nama ?? nik} menyematkan task "${ref.name}"`,
        reactionsJson: '[]',
        readByJson: '[]',
      },
    });
    await this.prisma.dT_CHAT_ROOM.update({
      where: { id: roomId },
      data: { lastMessageAt: sys.createdAt },
    });

    this.gateway.emitToRoom(roomId, 'task:pinned', { roomId, task: ref });
    this.gateway.emitToRoom(roomId, 'message:new', this.mapMessage(sys, nik));

    const pinned = await this.prisma.dT_CHAT_PINNED_TASK.findMany({
      where: { roomId },
      orderBy: { pinnedAt: 'desc' },
    });
    return pinned.map((p) => this.mapPinned(p));
  }

  async unpinTask(nik: string, roomId: string, taskId: string): Promise<TaskRef[]> {
    await this.assertMember(roomId, nik);
    const task = await this.resolveTask(taskId);
    const resolvedId = task?.id || taskId;
    await this.prisma.dT_CHAT_PINNED_TASK.deleteMany({ where: { roomId, taskId: resolvedId } });
    this.gateway.emitToRoom(roomId, 'task:unpinned', { roomId, taskId: resolvedId });
    const pinned = await this.prisma.dT_CHAT_PINNED_TASK.findMany({
      where: { roomId },
      orderBy: { pinnedAt: 'desc' },
    });
    return pinned.map((p) => this.mapPinned(p));
  }

  async uploadAttachment(
    nik: string,
    roomId: string,
    file: Express.Multer.File,
  ): Promise<ChatAttachment> {
    await this.assertMember(roomId, nik);
    if (!file?.buffer?.length) throw new BadRequestException('File wajib diunggah');
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Maksimum ukuran file 5MB');
    }

    const originalName = file.originalname || 'file';
    const safe = originalName.replace(/[^\w.-]+/g, '_');
    const key = `chat/${roomId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;
    const uploaded = await this.storage.uploadFile(key, file.buffer, file.mimetype || 'application/octet-stream');

    return {
      id: randomUUID(),
      name: originalName.slice(0, 120),
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      url: uploaded.url,
    };
  }
}
