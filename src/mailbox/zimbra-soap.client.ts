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


  /** Display name dari GetInfo (`attrs._attrs.displayName` / identity From display). */
  async getAccountDisplayName(authToken: string): Promise<string | null> {
    try {
      const body = await this.call<{
        GetInfoResponse?: {
          name?: string;
          attrs?: unknown;
          identities?: {
            identity?:
              | Array<{ name?: string; _attrs?: Record<string, string | string[] | undefined> }>
              | { name?: string; _attrs?: Record<string, string | string[] | undefined> };
          };
        };
      }>(authToken, {
        GetInfoRequest: {
          _jsns: 'urn:zimbraAccount',
          sections: 'mbox,attrs,idents',
        },
      });
      const info = body.GetInfoResponse;
      const flat = this.flattenZimbraAttrs(info?.attrs);
      const pick = (...keys: string[]) => {
        for (const key of keys) {
          const raw = flat[key] ?? flat[key.toLowerCase()];
          const v = (Array.isArray(raw) ? raw[0] : raw || '').toString().trim();
          if (v) return v;
        }
        return '';
      };

      const idents = info?.identities?.identity;
      const identList = Array.isArray(idents) ? idents : idents ? [idents] : [];
      const defaultIdent =
        identList.find((i) => (i.name || '').toUpperCase() === 'DEFAULT') || identList[0];
      const fromDisplay = (
        Array.isArray(defaultIdent?._attrs?.zimbraPrefFromDisplay)
          ? defaultIdent?._attrs?.zimbraPrefFromDisplay[0]
          : defaultIdent?._attrs?.zimbraPrefFromDisplay || ''
      )
        .toString()
        .trim();

      const name =
        pick('displayName', 'cn', 'fullName') ||
        fromDisplay ||
        [pick('givenName'), pick('sn')].filter(Boolean).join(' ').trim();
      return name || null;
    } catch (e) {
      this.logger.warn(`GetInfo displayName failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Zimbra JSON sering nest attrs sebagai `{ _attrs: { displayName } }` atau array `a`. */
  private flattenZimbraAttrs(attrs: unknown): Record<string, string | string[] | undefined> {
    if (!attrs) return {};
    if (Array.isArray(attrs)) {
      const out: Record<string, string | string[] | undefined> = {};
      for (const item of attrs) {
        const a = item as { _name?: string; n?: string; _content?: string };
        const key = (a._name || a.n || '').trim();
        const val = (a._content || '').trim();
        if (key && val) out[key] = val;
      }
      return out;
    }
    if (typeof attrs !== 'object') return {};
    const obj = attrs as Record<string, unknown>;
    if (obj._attrs && typeof obj._attrs === 'object' && !Array.isArray(obj._attrs)) {
      return obj._attrs as Record<string, string | string[] | undefined>;
    }
    return obj as Record<string, string | string[] | undefined>;
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
    // auth=qp: Node fetch sering membuang header Cookie (forbidden header).
    const url =
      `${this.getMailBaseUrl()}/service/upload?fmt=raw` +
      `&auth=qp&zauthtoken=${encodeURIComponent(authToken)}`;
    const form = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], {
      type: file.mimetype || 'application/octet-stream',
    });
    const filename = file.originalname || 'file';
    form.append('file', blob, filename);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: `ZM_AUTH_TOKEN=${authToken}`,
      },
      body: form,
      redirect: 'manual',
    });
    const text = await resp.text();
    // 302/303 biasanya redirect ke login → auth token tidak diterima
    if (resp.status >= 300 && resp.status < 400) {
      this.logger.warn(`Zimbra upload redirected (${resp.status}) — kemungkinan auth gagal`);
      throw new BadRequestException('Gagal upload lampiran ke Zimbra (auth)');
    }
    if (!resp.ok) {
      this.logger.warn(`Zimbra upload failed: ${resp.status} ${text.slice(0, 300)}`);
      throw new BadRequestException('Gagal upload lampiran ke Zimbra');
    }
    const aid = this.parseUploadAid(text);
    if (!aid) {
      this.logger.warn(`Zimbra upload no aid: status=${resp.status} body=${text.slice(0, 300)}`);
      throw new BadRequestException('Upload Zimbra tidak mengembalikan aid');
    }
    return { aid };
  }

  /** Parse raw upload body: `200,'null','aid','filename','ctype'` */
  private parseUploadAid(raw: string): string | null {
    const text = (raw || '').replace(/^\uFEFF/, '').trim();
    if (!text || /<\s*html/i.test(text)) return null;

    // Prefer quoted 3rd CSV field (aid)
    const quoted = text.match(
      /^\s*\d{3}\s*,\s*(?:'[^']*'|"[^"]*"|[^,]*)\s*,\s*(?:'([^']+)'|"([^"]+)"|([^,\r\n]+))/,
    );
    const fromQuoted = (quoted?.[1] || quoted?.[2] || quoted?.[3] || '').trim();
    if (fromQuoted && !/^null$/i.test(fromQuoted)) return fromQuoted;

    const parts = this.splitCsvFields(text);
    if (parts.length >= 3) {
      const status = parts[0];
      const aid = parts[2];
      if (/^\d{3}$/.test(status) && aid && !/^null$/i.test(aid)) return aid;
    }

    // Last resort: first UUID-ish / long hex token that isn't the filename
    const tokens = parts.length ? parts : text.split(',').map((s) => s.replace(/^['"]|['"]$/g, '').trim());
    const filenameHint = tokens[3] || '';
    return (
      tokens.find(
        (s, i) =>
          i >= 2 &&
          s &&
          !/^null$/i.test(s) &&
          s !== filenameHint &&
          !/\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|zip)$/i.test(s) &&
          /^[0-9a-zA-Z_.:-]{6,}$/.test(s),
      ) || null
    );
  }

  private splitCsvFields(input: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          cur += ch;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === ',') {
        out.push(cur.trim());
        cur = '';
        continue;
      }
      if (ch === '\n' || ch === '\r') break;
      cur += ch;
    }
    if (cur.length || out.length) out.push(cur.trim());
    return out;
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
