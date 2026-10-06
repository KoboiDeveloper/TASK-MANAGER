import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { isOriginAllowed } from '../common/corsOrigins';

interface SocketUser {
  nik: string;
  nama: string;
  roleId?: string;
}

@Injectable()
@WebSocketGateway({
  namespace: '/project',
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6, // 1 MB max buffer
})
export class ProjectGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ProjectGateway.name);

  // Map<projectId, Map<socketId, SocketUser>>
  private readonly activeProjectUsers = new Map<string, Map<string, SocketUser>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) { }

  // =========================================================
  // 🔹 CONNECTION & AUTHENTICATION
  // =========================================================

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

      if (!userInDb || !userInDb.statusActive) return null;

      const user: SocketUser = {
        nik: payload.nik,
        nama: userInDb.nama || payload.nama,
        roleId: payload.roleId,
      };

      client.data.user = user;
      return user;
    } catch {
      return null;
    }
  }

  async handleConnection(client: Socket) {
    try {
      const user = await this.authenticateClient(client);
      if (!user) {
        this.logger.warn(`Connection rejected: Auth failed (${client.id})`);
        client.disconnect(true);
        return;
      }
      this.logger.log(`🟢 WebSocket connected: ${client.id} - ${user.nama} (${user.nik})`);
    } catch (error) {
      this.logger.error(`Connection auth error for ${client.id}: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.removeClientFromAllRooms(client.id);
    this.logger.log(`🔴 WebSocket disconnected: ${client.id}`);
  }

  // =========================================================
  // 🔹 ROOM & PRESENCE MANAGEMENT
  // =========================================================

  @SubscribeMessage('project:join')
  async handleJoinProject(@ConnectedSocket() client: Socket, @MessageBody() rawPayload: any) {
    const projectId =
      typeof rawPayload === 'string' ? rawPayload : rawPayload?.projectId || rawPayload?.id;
    this.logger.log(`📥 [project:join] Request from ${client.id} for project: ${projectId}`);

    if (!projectId) {
      this.logger.warn(`Join rejected: Empty projectId from ${client.id}`);
      return { status: 'error', message: 'Project ID is required' };
    }

    let user = client.data?.user;
    if (!user) {
      user = await this.authenticateClient(client);
    }

    if (!user) {
      this.logger.warn(`Join rejected: Client not authenticated (${client.id})`);
      return { status: 'error', message: 'Unauthenticated' };
    }

    try {
      const isGuid = /^[0-9a-fA-F-]{36}$/.test(projectId);
      const project = await this.prismaService.dT_PROJECT.findFirst({
        where: isGuid ? { id: projectId } : { shortId: projectId.toLowerCase() },
        select: {
          id: true,
          shortId: true,
          createdBy: true,
          members: { select: { nik: true } },
        },
      });

      if (!project) {
        this.logger.warn(`Join rejected: Project not found (${projectId})`);
        return { status: 'error', message: 'Project not found' };
      }

      // Validasi izin akses (Owner, Member, atau Admin/Super)
      const userNik = user.nik;
      const isSuperOrAdmin = user.roleId === 'SUPER' || user.roleId === 'ADMIN';
      const isOwner = project.createdBy === userNik;
      const isMember = project.members.some((m) => m.nik === userNik);

      if (!isSuperOrAdmin && !isOwner && !isMember) {
        this.logger.warn(`Join rejected: User ${userNik} unauthorized for project ${projectId}`);
        return { status: 'error', message: 'Unauthorized' };
      }

      const canonicalId = project.id;
      const shortId = project.shortId;

      // Klien masuk ke room GUID dan shortId agar broadcast ke ID mana pun tetap terkirim
      await client.join(`project:${canonicalId}`);
      if (shortId) {
        await client.join(`project:${shortId}`);
      }

      this.addUserToPresence(canonicalId, client.id, user);
      this.broadcastPresence(canonicalId);
      if (shortId && shortId.toLowerCase() !== canonicalId.toLowerCase()) {
        this.addUserToPresence(shortId, client.id, user);
        this.broadcastPresence(shortId);
      }

      this.logger.log(
        `✅ User ${user.nama} (${user.nik}) joined project:${canonicalId} (${shortId || '-'})`,
      );
      return { status: 'joined', canonicalId, shortId };
    } catch (err) {
      this.logger.error(`Error in handleJoinProject: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('project:leave')
  async handleLeaveProject(@ConnectedSocket() client: Socket, @MessageBody() projectId: string) {
    if (!projectId) return;

    try {
      const isGuid = /^[0-9a-fA-F-]{36}$/.test(projectId);
      const project = await this.prismaService.dT_PROJECT.findFirst({
        where: isGuid ? { id: projectId } : { shortId: projectId.toLowerCase() },
        select: { id: true, shortId: true },
      });

      const canonicalId = project?.id || projectId;
      const shortId = project?.shortId;

      await client.leave(`project:${canonicalId}`);
      this.removeUserFromPresence(canonicalId, client.id);
      this.broadcastPresence(canonicalId);

      if (shortId) {
        await client.leave(`project:${shortId}`);
        this.removeUserFromPresence(shortId, client.id);
        this.broadcastPresence(shortId);
      }

      this.logger.log(`Socket ${client.id} left project:${canonicalId}`);
      return { status: 'left', canonicalId };
    } catch (err) {
      this.logger.error(`Error in handleLeaveProject: ${(err as Error).message}`);
    }
  }

  // =========================================================
  // 🔹 BROADCAST HELPER (DIPANGGIL OLEH PROJECT SERVICE)
  // =========================================================

  // Cache room aliases untuk menghindari query berulang
  private readonly projectRoomAliases = new Map<string, string[]>();

  /**
   * Broadcast event ke seluruh client yang berada di room project tertentu (baik GUID maupun ShortId)
   */
  async broadcastToProject(
    projectId: string,
    event: string,
    payload: any,
    excludeSocketId?: string,
  ) {
    if (!projectId) return;

    let aliases = this.projectRoomAliases.get(projectId);
    if (!aliases) {
      try {
        const isGuid = /^[0-9a-fA-F-]{36}$/.test(projectId);
        const project = await this.prismaService.dT_PROJECT.findFirst({
          where: isGuid ? { id: projectId } : { shortId: projectId.toLowerCase() },
          select: { id: true, shortId: true },
        });

        if (project) {
          const canonicalId = project.id;
          const shortId = project.shortId;
          aliases = [`project:${canonicalId}`];
          if (shortId && shortId.toLowerCase() !== canonicalId.toLowerCase()) {
            aliases.push(`project:${shortId}`);
          }
          this.projectRoomAliases.set(canonicalId, aliases);
          if (shortId) this.projectRoomAliases.set(shortId, aliases);
        } else {
          aliases = [`project:${projectId}`];
        }
      } catch {
        aliases = [`project:${projectId}`];
      }
    }

    this.logger.log(`📢 Broadcasting [${event}] to rooms: ${aliases.join(', ')}`);

    for (const room of aliases) {
      if (excludeSocketId) {
        this.server.to(room).except(excludeSocketId).emit(event, payload);
      } else {
        this.server.to(room).emit(event, payload);
      }
    }
  }

  // =========================================================
  // 🔹 INTERNAL HELPERS
  // =========================================================

  private addUserToPresence(projectId: string, socketId: string, user: SocketUser) {
    if (!this.activeProjectUsers.has(projectId)) {
      this.activeProjectUsers.set(projectId, new Map());
    }
    this.activeProjectUsers.get(projectId)!.set(socketId, user);
  }

  private removeUserFromPresence(projectId: string, socketId: string) {
    const projectMap = this.activeProjectUsers.get(projectId);
    if (projectMap) {
      projectMap.delete(socketId);
      if (projectMap.size === 0) {
        this.activeProjectUsers.delete(projectId);
      }
    }
  }

  private removeClientFromAllRooms(socketId: string) {
    for (const [projectId, usersMap] of this.activeProjectUsers.entries()) {
      if (usersMap.has(socketId)) {
        usersMap.delete(socketId);
        if (usersMap.size === 0) {
          this.activeProjectUsers.delete(projectId);
        }
        this.broadcastPresence(projectId);
      }
    }
  }

  private broadcastPresence(projectId: string) {
    const usersMap = this.activeProjectUsers.get(projectId);
    const users = usersMap ? Array.from(usersMap.values()) : [];

    // Deduplicate user jika user membuka tab ganda
    const uniqueUsers = Array.from(
      new Map(users.map((u) => [u.nik, { nik: u.nik, nama: u.nama }])).values(),
    );

    this.logger.log(
      `👥 Presence for project:${projectId}: ${uniqueUsers.length} user(s) online (${uniqueUsers.map((u) => u.nama).join(', ')})`,
    );
    this.server.to(`project:${projectId}`).emit('project:presence', uniqueUsers);
  }

  private extractToken(client: Socket): string | null {
    // 1. Dari socket auth handshake: io('/project', { auth: { token: '...' } })
    const authToken = client.handshake.auth?.token;
    if (authToken && typeof authToken === 'string') {
      return authToken.startsWith('Bearer ') ? authToken.slice(7).trim() : authToken.trim();
    }

    // 2. Dari Authorization header
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && typeof authHeader === 'string') {
      return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    }

    // 3. Dari cookies: access_token
    const cookieHeader = client.handshake.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    }

    return null;
  }
}
