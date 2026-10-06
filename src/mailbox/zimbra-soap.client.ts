import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type SoapBody = Record<string, unknown>;

type SoapResponse = {
  Header?: { context?: { authToken?: unknown; session?: unknown } };
  Body?: SoapBody & { Fault?: { Reason?: { Text?: string }; Detail?: unknown } };
};

@Injectable()
export class ZimbraSoapClient {
  private readonly logger = new Logger(ZimbraSoapClient.name);
  private readonly soapUrl: string;
  private readonly mailUrl: string;

  constructor(private readonly config: ConfigService) {
    this.soapUrl =
      this.config.get<string>('ZIMBRA_SOAP_URL')?.trim() ||
      'https://mail.amscorp.co.id/service/soap';
    this.mailUrl =
      this.config.get<string>('ZIMBRA_MAIL_URL')?.trim() || 'https://mail.amscorp.co.id';
  }

  getMailBaseUrl(): string {
    return this.mailUrl.replace(/\/$/, '');
  }

  async auth(email: string, password: string): Promise<{ authToken: string; lifetimeMs: number }> {
    const res = await this.request({
      AuthRequest: {
        _jsns: 'urn:zimbraAccount',
        account: { _content: email, by: 'name' },
        password: password,
        attrs: '',
      },
    });
    const auth = res.Body?.AuthResponse as
      | { authToken?: Array<{ _content?: string }> | string; lifetime?: number | string }
      | undefined;
    const token = this.extractContent(auth?.authToken);
    if (!token) {
      throw new BadRequestException('Login Zimbra gagal: token tidak diterima');
    }
    const lifetimeMs = Number(auth?.lifetime || 12 * 60 * 60 * 1000);
    return { authToken: token, lifetimeMs: Number.isFinite(lifetimeMs) ? lifetimeMs : 12 * 60 * 60 * 1000 };
  }

  async call<T = SoapBody>(
    authToken: string,
    body: SoapBody,
  ): Promise<T> {
    const res = await this.request(body, authToken);
    if (res.Body?.Fault) {
      const text = res.Body.Fault.Reason?.Text || 'Zimbra SOAP fault';
      const err = new Error(text) as Error & { zimbraFault?: boolean; code?: string };
      err.zimbraFault = true;
      throw err;
    }
    return res.Body as T;
  }

  async uploadAttachment(
    authToken: string,
    file: Express.Multer.File,
  ): Promise<{ aid: string }> {
    const url = `${this.getMailBaseUrl()}/service/upload?fmt=raw`;
    const form = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'application/octet-stream' });
    form.append('file', blob, file.originalname || 'file');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: `ZM_AUTH_TOKEN=${authToken}`,
      },
      body: form,
    });
    const text = await resp.text();
    if (!resp.ok) {
      this.logger.warn(`Zimbra upload failed: ${resp.status} ${text.slice(0, 200)}`);
      throw new BadRequestException('Gagal upload lampiran ke Zimbra');
    }
    // Response raw: "200,'null','aid','filename','ctype'"
    const match = text.match(/'([0-9a-fA-F-]{8,})'/);
    const aid =
      match?.[1] ||
      text
        .split(',')
        .map((s) => s.replace(/['"]/g, '').trim())
        .find((s) => /^[0-9a-fA-F-]{8,}$/i.test(s));
    if (!aid) {
      throw new BadRequestException('Upload Zimbra tidak mengembalikan aid');
    }
    return { aid };
  }

  async downloadContent(
    authToken: string,
    pathQuery: string,
  ): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
    const url = pathQuery.startsWith('http')
      ? pathQuery
      : `${this.getMailBaseUrl()}${pathQuery.startsWith('/') ? '' : '/'}${pathQuery}`;
    const resp = await fetch(url, {
      headers: { Cookie: `ZM_AUTH_TOKEN=${authToken}` },
    });
    if (!resp.ok) {
      throw new BadRequestException(`Gagal unduh konten (${resp.status})`);
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const cd = resp.headers.get('content-disposition') || '';
    const filenameMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
    const ab = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(ab),
      contentType,
      filename: filenameMatch?.[1],
    };
  }

  private async request(body: SoapBody, authToken?: string): Promise<SoapResponse> {
    const payload = {
      Header: {
        context: {
          _jsns: 'urn:zimbra',
          ...(authToken ? { authToken } : {}),
        },
      },
      Body: body,
    };

    let resp: Response;
    try {
      resp = await fetch(this.soapUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Cookie: `ZM_AUTH_TOKEN=${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      this.logger.error(`Zimbra SOAP network error: ${(e as Error).message}`);
      throw new BadRequestException('Tidak dapat terhubung ke server Zimbra');
    }

    const json = (await resp.json().catch(() => null)) as SoapResponse | null;
    if (!json) {
      throw new BadRequestException(`Respons Zimbra tidak valid (${resp.status})`);
    }
    if (json.Body?.Fault && !authToken) {
      const text = json.Body.Fault.Reason?.Text || 'Autentikasi Zimbra gagal';
      throw new BadRequestException(text);
    }
    return json;
  }

  private extractContent(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && '_content' in first) {
        return String((first as { _content?: string })._content || '') || null;
      }
    }
    if (typeof value === 'object' && value && '_content' in value) {
      return String((value as { _content?: string })._content || '') || null;
    }
    return null;
  }
}
