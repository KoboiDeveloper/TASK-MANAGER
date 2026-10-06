import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { isOriginAllowed } from '../common/corsOrigins';
import { ChatEvents } from './chat.events';
import { SendMessageDto } from './dto/chat.dto';
import { listOnlineNiks, trackOffline, trackOnline } from './chat.presence';

interface SocketUser {
  nik: string;
  nama: string;
  roleId?: string;
}

@Injectable()
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);
  /** nik → active socket ids (multi-tab safe) */
  private readonly onlineByNik = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly chatEvents: ChatEvents,
    private readonly moduleRef: ModuleRef,
  ) {}

  afterInit(server: Server) {
    this.chatEvents.setServer(server);
  }

  private extractToken(client: Socket): string | null {
    const authToken = client.handshake.auth?.token;
    if (authToken && typeof authToken === 'string') {
      return authToken.startsWith('Bearer ') ? authToken.slice(7).trim() : authToken.trim();
    }
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    }
    const cookieHeader = client.handshake.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    return null;
  }

  private async authenticateClient(client: Socket): Promise<SocketUser | null> {
    if (client.data?.user) return client.data.user;
    const token = this.extractToken(client);
    if (!token) return null;
    try {
      const secret = this.configService.get<string>('SECRET_KEY');
      const issuer = this.configService.get<string>('ISSUER_STAMP');
      const payload = await this.jwtService.verifyAsync<SocketUser>(token, {
        secret,
        issuer: issuer || undefined,
      });
      if (!payload?.nik) return null;
      const userInDb = await this.prismaService.dT_USER.findUnique({
        where: { nik: payload.nik },
        select: { statusActive: true, nama: true },
      });
      if (!userInDb?.statusActive) return null;
      const user: SocketUser = {
        nik: String(payload.nik).trim(),
        nama: userInDb.nama || payload.nama,
        roleId: payload.roleId,
      };
      client.data.user = user;
      return user;
    } catch {
      return null;
    }
  }

  private async getChatService() {
    // Lazy resolve to avoid circular import at module load
    const { ChatService } = await import('./chat.service');
    return this.moduleRef.get(ChatService, { strict: false });
  }

  async handleConnection(client: Socket) {
    try {
      const user = await this.authenticateClient(client);
      if (!user) {
        this.logger.warn(`Chat WS rejected: Auth failed (${client.id})`);
        client.disconnect(true);
        return;
      }
      await client.join(`user:${user.nik}`);
      this.logger.log(`Chat WS connected: ${client.id} - ${user.nama} (${user.nik})`);

      // Snapshot: tell the new client who is already online
      const now = new Date().toISOString();
      for (const nik of listOnlineNiks(this.onlineByNik)) {
        if (nik === user.nik) continue;
        client.emit('presence:update', { nik, isOnline: true, lastSeenAt: now });
      }

      const { becameOnline } = trackOnline(this.onlineByNik, user.nik, client.id);
      if (becameOnline) {
        this.server.emit('presence:update', {
          nik: user.nik,
          isOnline: true,
          lastSeenAt: now,
        });
      }
    } catch (error) {
      this.logger.error(`Chat WS auth error: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const user = client.data?.user as SocketUser | undefined;
    if (user?.nik) {
      const { becameOffline } = trackOffline(this.onlineByNik, user.nik, client.id);
      if (becameOffline) {
        this.server.emit('presence:update', {
          nik: user.nik,
          isOnline: false,
          lastSeenAt: new Date().toISOString(),
        });
      }
    }
    this.logger.log(`Chat WS disconnected: ${client.id}`);
  }

  @SubscribeMessage('chat:join')
  async handleJoin(@ConnectedSocket() client: Socket, @MessageBody() roomId: string) {
    const user = (await this.authenticateClient(client)) || client.data?.user;
    if (!user || !roomId) return { ok: false };
    const member = await this.prismaService.dT_CHAT_MEMBER.findUnique({
      where: { roomId_nik: { roomId, nik: user.nik } },
    });
    if (!member) return { ok: false };
    await client.join(`chat:${roomId}`);
    return { ok: true };
  }

  @SubscribeMessage('chat:leave')
  async handleLeave(@ConnectedSocket() client: Socket, @MessageBody() roomId: string) {
    if (!roomId) return;
    await client.leave(`chat:${roomId}`);
  }

  @SubscribeMessage('message:send')
  async handleSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SendMessageDto & { roomId: string },
  ) {
    const user = (await this.authenticateClient(client)) || client.data?.user;
    if (!user || !body?.roomId) return { error: 'Unauthenticated' };
    try {
      const chatService = await this.getChatService();
      return await chatService.sendMessage(user.nik, body.roomId, body);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @SubscribeMessage('message:read')
  async handleRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string; lastMessageId: string },
  ) {
    const user = (await this.authenticateClient(client)) || client.data?.user;
    if (!user || !body?.roomId || !body?.lastMessageId) return;
    try {
      const chatService = await this.getChatService();
      await chatService.markRead(user.nik, body.roomId, {
        lastMessageId: body.lastMessageId,
      });
    } catch (e) {
      this.logger.warn(`message:read failed: ${(e as Error).message}`);
    }
  }

  @SubscribeMessage('typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ) {
    const user = (await this.authenticateClient(client)) || client.data?.user;
    if (!user || !body?.roomId) return;
    client.to(`chat:${body.roomId}`).emit('typing', {
      roomId: body.roomId,
      nik: user.nik,
      isTyping: true,
    });
  }

  @SubscribeMessage('typing:stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ) {
    const user = (await this.authenticateClient(client)) || client.data?.user;
    if (!user || !body?.roomId) return;
    client.to(`chat:${body.roomId}`).emit('typing', {
      roomId: body.roomId,
      nik: user.nik,
      isTyping: false,
    });
  }
}
