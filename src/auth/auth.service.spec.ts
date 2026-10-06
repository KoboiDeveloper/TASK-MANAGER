import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../utils/mail/mail.service';
import { PushService } from '../notifications/push.service';

describe('AuthService.issueWsTicket', () => {
  let service: AuthService;
  let jwtService: { signAsync: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    jwtService = { signAsync: jest.fn().mockResolvedValue('ws.ticket.jwt') };
    configService = {
      get: jest.fn((key: string) => {
        const map: Record<string, string> = {
          SECRET_KEY: 'test-secret',
          ISSUER_STAMP: 'test-issuer',
          WS_TICKET_EXPIRES: '5m',
        };
        return map[key];
      }),
    };

    service = new AuthService(
      {} as PrismaService,
      jwtService as unknown as JwtService,
      {} as MailService,
      configService as unknown as ConfigService,
      {} as PushService,
    );
  });

  it('signs a short-lived JWT with ws type for socket handshake', async () => {
    const token = await service.issueWsTicket({
      nik: '123',
      nama: 'Test User',
      roleId: 'role-1',
    });

    expect(token).toBe('ws.ticket.jwt');
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      {
        nik: '123',
        nama: 'Test User',
        roleId: 'role-1',
        type: 'ws',
      },
      {
        secret: 'test-secret',
        expiresIn: '5m',
        issuer: 'test-issuer',
      },
    );
  });
});
