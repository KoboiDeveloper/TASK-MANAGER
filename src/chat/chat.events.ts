import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

/**
 * Thin emit helper shared by ChatService and ChatGateway
 * to avoid circular DI between them.
 */
@Injectable()
export class ChatEvents {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  emitToRoom(roomId: string, event: string, payload: unknown) {
    this.server?.to(`chat:${roomId}`).emit(event, payload);
  }

  emitToUser(nik: string, event: string, payload: unknown) {
    this.server?.to(`user:${nik}`).emit(event, payload);
  }
}
