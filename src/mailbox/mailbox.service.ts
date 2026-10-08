import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailboxCryptoService } from './mailbox-crypto.service';
import { ZimbraSoapClient } from './zimbra-soap.client';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { ConnectMailboxDto, MessageActionDto, SendMessageDto } from './dto/mailbox.dto';
import { DROPBOX_GLYPH_CID, DROPBOX_GLYPH_PNG } from './dropbox-glyph';
import {
  normalizeMailboxEmail,
  pickActiveAfterDisconnect,
} from './mailbox-active.util';

export type FolderNode = {
  id: string;
  name: string;
  path: string;
  absFolderPath?: string;
  u?: number;
  n?: number;
  view?: string;
  /** Zimbra palette index 0–127 (client biasanya 0–9) */
  color?: number | null;
  /** Zimbra RGB `#rrggbb` bila di-set custom */
  rgb?: string | null;
  children: FolderNode[];
};

export type CalendarEvent = {
  id: string;
  appointmentId: string;
  title: string;
  location: string | null;
  start: number;
  end: number;
  allDay: boolean;
  folderId?: string;
  fragment?: string;
};

export type MessageSummary = {
  id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: number;
  fragment: string;
  size: number;
  flags: string;
  isUnread: boolean;
  isFlagged: boolean;
  hasAttachment: boolean;
  folderId?: string;
  tags?: string[];
};

@Injectable()
export class MailboxService {
  private readonly logger = new Logger(MailboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailboxCryptoService,
    private readonly zimbra: ZimbraSoapClient,
    private readonly dropbox: DropboxStorageService,
  ) {}

  async getStatus(nik: string) {
    const rows = await this.prisma.dT_MAILBOX_CREDENTIAL.findMany({
      where: { nik },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        zimbraEmail: true,
        displayName: true,
        createdAt: true,
        updatedAt: true,
        authToken: true,
        authTokenExpiresAt: true,
      },
    });

    // Backfill nama dari Zimbra jika connect sebelumnya gagal parse attrs._attrs
    for (const r of rows) {
      if (r.displayName?.trim()) continue;
      const tokenOk =
        !!r.authToken &&
        !!r.authTokenExpiresAt &&
        r.authTokenExpiresAt.getTime() > Date.now() + 30_000;
      if (!tokenOk) continue;
      try {
        const name = await this.zimbra.getAccountDisplayName(r.authToken!);
        if (name) {
          await this.prisma.dT_MAILBOX_CREDENTIAL.update({
            where: { id: r.id },
            data: { displayName: name },
          });
          r.displayName = name;
        }
      } catch {
        /* optional */
      }
    }

    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { activeZimbraEmail: true },
    });
    const accounts = rows.map((r) => ({
      email: r.zimbraEmail,
      name: (r.displayName || '').trim() || null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    let activeEmail = user?.activeZimbraEmail ?? null;
    if (activeEmail && !accounts.some((a) => a.email === activeEmail)) {
      activeEmail = pickActiveAfterDisconnect(
        rows.map((r) => ({ zimbraEmail: r.zimbraEmail, createdAt: r.createdAt })),
      );
      await this.prisma.dT_USER.update({
        where: { nik },
        data: { activeZimbraEmail: activeEmail },
      });
    }
    if (!activeEmail && accounts.length) {
      activeEmail = accounts[0].email; // newest (query desc)
      await this.prisma.dT_USER.update({
        where: { nik },
        data: { activeZimbraEmail: activeEmail },
      });
    }
    return {
      connected: accounts.length > 0,
      activeEmail,
      email: activeEmail, // compat
      accounts,
      updatedAt: accounts[0]?.updatedAt ?? null,
    };
  }

  async connect(nik: string, dto: ConnectMailboxDto) {
    const email = normalizeMailboxEmail(dto.email);
    const { authToken, lifetimeMs } = await this.zimbra.auth(email, dto.password);
    const displayName = (await this.zimbra.getAccountDisplayName(authToken)) || null;
    const enc = this.crypto.encrypt(dto.password);
    const expires = new Date(Date.now() + Math.max(lifetimeMs - 60_000, 5 * 60_000));

    await this.prisma.dT_MAILBOX_CREDENTIAL.upsert({
      where: { nik_zimbraEmail: { nik, zimbraEmail: email } },
      create: {
        id: randomUUID(),
        nik,
        zimbraEmail: email,
        displayName,
        passwordCipher: enc.cipher,
        passwordIv: enc.iv,
        passwordTag: enc.tag,
        authToken,
        authTokenExpiresAt: expires,
      },
      update: {
        ...(displayName ? { displayName } : {}),
        passwordCipher: enc.cipher,
        passwordIv: enc.iv,
        passwordTag: enc.tag,
        authToken,
        authTokenExpiresAt: expires,
      },
    });

    await this.prisma.dT_USER.update({
      where: { nik },
      data: { activeZimbraEmail: email },
    });

    return { connected: true, email, activeEmail: email, name: displayName };
  }

  async disconnect(nik: string, email: string) {
    const normalized = normalizeMailboxEmail(email);
    const deleted = await this.prisma.dT_MAILBOX_CREDENTIAL.deleteMany({
      where: { nik, zimbraEmail: normalized },
    });
    if (deleted.count === 0) {
      throw new BadRequestException('Akun tidak ditemukan');
    }

    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { activeZimbraEmail: true },
    });
    const active = user?.activeZimbraEmail ?? null;
    if (!active || normalizeMailboxEmail(active) === normalized) {
      const remaining = await this.prisma.dT_MAILBOX_CREDENTIAL.findMany({
        where: { nik },
        select: { zimbraEmail: true, createdAt: true },
      });
      const nextActive = pickActiveAfterDisconnect(remaining);
      await this.prisma.dT_USER.update({
        where: { nik },
        data: { activeZimbraEmail: nextActive },
      });
    }

    return this.getStatus(nik);
  }

  async setActive(nik: string, email: string) {
    const normalized = normalizeMailboxEmail(email);
    const cred = await this.prisma.dT_MAILBOX_CREDENTIAL.findUnique({
      where: { nik_zimbraEmail: { nik, zimbraEmail: normalized } },
    });
    if (!cred) {
      throw new BadRequestException('Akun tidak ditemukan');
    }
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { activeZimbraEmail: normalized },
    });
    return this.getStatus(nik);
  }

  async getFolders(nik: string): Promise<FolderNode[]> {
    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        GetFolderRequest: {
          _jsns: 'urn:zimbraMail',
        },
      }),
    );
    const root = (body as { GetFolderResponse?: { folder?: unknown } }).GetFolderResponse?.folder;
    const folders = this.asArray(root).map((f) => this.mapFolder(f));
    return this.mailFoldersOnly(folders);
  }

  async getCalendars(nik: string): Promise<FolderNode[]> {
    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        GetFolderRequest: {
          _jsns: 'urn:zimbraMail',
        },
      }),
    );
    const root = (body as { GetFolderResponse?: { folder?: unknown } }).GetFolderResponse?.folder;
    const folders = this.asArray(root).map((f) => this.mapFolder(f));
    return this.calendarFoldersOnly(folders);
  }


  async createEvent(
    nik: string,
    input: {
      title: string;
      location?: string;
      description?: string;
      start: number;
      end: number;
      allDay?: boolean;
      kind?: string;
      guests?: string;
      timeZone?: string;
      email?: string;
      folderId?: string;
    },
  ): Promise<CalendarEvent> {
    const title = (input.title || '').trim();
    if (!title) throw new BadRequestException('Judul wajib');
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) {
      throw new BadRequestException('Range waktu tidak valid');
    }

    const cred = await this.resolveCredential(nik, input.email);
    const zimbraEmail = cred.zimbraEmail;
    const tz = (input.timeZone || '').trim() || 'Asia/Jakarta';
    const allDay = !!input.allDay;
    const folderId = (input.folderId || '10').trim() || '10';
    const kind = (input.kind || 'event').trim().toLowerCase();
    const guests = (input.guests || '')
      .split(/[,;\s]+/)
      .map((g) => g.trim().toLowerCase())
      .filter((g) => g.includes('@'));

    const fmtZimbra = (ms: number, dayOnly: boolean) => {
      const d = new Date(ms);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      if (dayOnly) return `${y}${m}${day}`;
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${y}${m}${day}T${hh}${mm}${ss}`;
    };

    const startStr = fmtZimbra(input.start, allDay);
    const endStr = fmtZimbra(input.end, allDay);
    const desc = (input.description || '').trim();
    const loc = (input.location || '').trim();

    const attendees = guests.map((a) => ({
      a,
      d: a.split('@')[0],
      role: 'REQ',
      ptst: 'NE',
      rsvp: '1',
    }));

    const comp: Record<string, unknown> = {
      name: title,
      allDay: allDay ? '1' : '0',
      status: 'CONF',
      fb: 'B',
      class: 'PUB',
      draft: 0,
      s: allDay ? { d: startStr } : { d: startStr, tz },
      e: allDay ? { d: endStr } : { d: endStr, tz },
      or: { a: zimbraEmail, d: (cred.displayName || zimbraEmail.split('@')[0]).trim() },
    };
    if (loc) comp.loc = loc;
    if (attendees.length) comp.at = attendees;
    // Appointment schedule gets invite semantics when guests present
    if (kind === 'appointment' || kind === 'appointment_schedule') {
      comp.method = 'REQUEST';
    }

    const mpChildren: Array<Record<string, unknown>> = [
      {
        ct: 'text/plain',
        content: desc || title,
      },
    ];
    if (desc) {
      mpChildren.push({
        ct: 'text/html',
        content: `<div>${desc.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</div>`,
      });
    }

    const msg: Record<string, unknown> = {
      l: folderId,
      su: title,
      inv: { comp: [comp] },
      mp: {
        ct: 'multipart/alternative',
        mp: mpChildren,
      },
    };
    if (guests.length) {
      msg.e = guests.map((a) => ({ a, t: 't' }));
    }

    const body = await this.withAuth(
      nik,
      (token) =>
        this.zimbra.call(token, {
          CreateAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            m: msg,
          },
        }),
      zimbraEmail,
    );

    const res = (body as { CreateAppointmentResponse?: { calItemId?: string; invId?: string; apptId?: string } })
      .CreateAppointmentResponse;
    const appointmentId = String(res?.calItemId || res?.apptId || res?.invId || '');
    return {
      id: `${appointmentId || 'new'}-${input.start}`,
      appointmentId: appointmentId || `new-${input.start}`,
      title,
      location: loc || null,
      start: input.start,
      end: input.end,
      allDay,
      folderId,
      fragment: desc || undefined,
    };
  }

  /** Zimbra GetApptSummaries max span ≈ 200 days. */
  private static readonly EVENTS_CHUNK_MS = 180 * 86_400_000; // under Zimbra 200-day max

  async getEvents(
    nik: string,
    opts: { start: number; end: number; folderId?: string; email?: string },
  ): Promise<CalendarEvent[]> {
    const start = Number(opts.start);
    const end = Number(opts.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new BadRequestException('Query start/end (ms) wajib dan end > start');
    }
    // Hard cap ~2 years of chunked fetches
    if (end - start > 800 * 86_400_000) {
      throw new BadRequestException('Rentang events maksimal 800 hari');
    }

    const chunks: CalendarEvent[] = [];
    let cursor = start;
    while (cursor < end) {
      const chunkEnd = Math.min(cursor + MailboxService.EVENTS_CHUNK_MS, end);
      const part = await this.fetchApptSummaries(
        nik,
        cursor,
        chunkEnd,
        opts.folderId,
        opts.email,
      );
      chunks.push(...part);
      cursor = chunkEnd;
    }

    const seen = new Set<string>();
    const out: CalendarEvent[] = [];
    for (const e of chunks) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }

  private async fetchApptSummaries(
    nik: string,
    start: number,
    end: number,
    folderId?: string,
    accountEmail?: string,
  ): Promise<CalendarEvent[]> {
    const body = await this.withAuth(
      nik,
      (token) =>
        this.zimbra.call(token, {
          GetApptSummariesRequest: {
            _jsns: 'urn:zimbraMail',
            s: start,
            e: end,
            ...(folderId ? { l: folderId } : {}),
          },
        }),
      accountEmail,
    );
    const appts = this.asArray(
      (body as { GetApptSummariesResponse?: { appt?: unknown } }).GetApptSummariesResponse?.appt,
    );
    return appts.flatMap((a) => this.mapApptEvents(a));
  }

  async searchMessages(
    nik: string,
    opts: { folderId?: string; query?: string; offset?: number; limit?: number },
  ): Promise<{ messages: MessageSummary[]; more: boolean; offset: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const parts: string[] = [];
    if (opts.folderId) parts.push(`inid:${opts.folderId}`);
    if (opts.query?.trim()) parts.push(opts.query.trim());
    const query = parts.length ? parts.join(' ') : 'in:inbox';

    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        SearchRequest: {
          _jsns: 'urn:zimbraMail',
          types: 'message',
          sortBy: 'dateDesc',
          limit,
          offset,
          query,
          fetch: 'none',
        },
      }),
    );

    const resp = (body as { SearchResponse?: { m?: unknown; more?: boolean | string } })
      .SearchResponse;
    const messages = this.asArray(resp?.m).map((m) => this.mapMessageSummary(m));
    return {
      messages,
      more: resp?.more === true || resp?.more === '1',
      offset,
    };
  }

  async getMessage(nik: string, id: string) {
    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        GetMsgRequest: {
          _jsns: 'urn:zimbraMail',
          m: { id, html: 1, needExp: 1, max: 250000 },
        },
      }),
    );
    const msg = this.asArray(
      (body as { GetMsgResponse?: { m?: unknown } }).GetMsgResponse?.m,
    )[0];
    if (!msg) throw new NotFoundException('Pesan tidak ditemukan');
    return this.mapMessageDetail(msg);
  }

  async sendMessage(nik: string, dto: SendMessageDto) {
    if (!this.splitAddrs(dto.to || '').length) {
      throw new BadRequestException('Tambahkan minimal satu penerima');
    }
    const body = await this.withAuth(nik, async (token) => {
      const prepared = await this.attachDropboxGlyph(token, dto);
      const e = this.buildMimeEmail(prepared.dto);
      return this.zimbra.call(token, {
        SendMsgRequest: {
          _jsns: 'urn:zimbraMail',
          m: {
            ...(prepared.dto.draftId ? { id: prepared.dto.draftId } : {}),
            ...(prepared.dto.inReplyTo ? { origid: prepared.dto.inReplyTo, rt: 'r' } : {}),
            e,
            su: { _content: prepared.dto.subject || '' },
            mp: this.buildBodyParts(prepared.dto, prepared.glyphAid),
            ...this.buildAttachBlock(prepared.dto),
          },
        },
      });
    });
    return { ok: true, raw: (body as { SendMsgResponse?: unknown }).SendMsgResponse };
  }

  async saveDraft(nik: string, dto: SendMessageDto) {
    const body = await this.withAuth(nik, async (token) => {
      const prepared = await this.attachDropboxGlyph(token, dto);
      const e = this.buildMimeEmail(prepared.dto);
      return this.zimbra.call(token, {
        SaveDraftRequest: {
          _jsns: 'urn:zimbraMail',
          m: {
            ...(prepared.dto.draftId ? { id: prepared.dto.draftId } : {}),
            e,
            su: { _content: prepared.dto.subject || '' },
            mp: this.buildBodyParts(prepared.dto, prepared.glyphAid),
            ...this.buildAttachBlock(prepared.dto),
          },
        },
      });
    });
    const draft = this.asArray(
      (body as { SaveDraftResponse?: { m?: unknown } }).SaveDraftResponse?.m,
    )[0] as { id?: string } | undefined;
    return { ok: true, id: draft?.id || null };
  }

  /**
   * Logo kartu Dropbox sebagai part inline (cid).
   * Gmail membuang `data:` URI, jadi glyph harus jadi MIME, bukan src data.
   */
  private async attachDropboxGlyph(
    token: string,
    dto: SendMessageDto,
  ): Promise<{ dto: SendMessageDto; glyphAid?: string }> {
    const html = dto.bodyHtml || '';
    const cid = `cid:${DROPBOX_GLYPH_CID}`;
    if (!html.includes(cid)) return { dto };
    try {
      const { aid } = await this.zimbra.uploadAttachment(token, {
        buffer: DROPBOX_GLYPH_PNG,
        mimetype: 'image/png',
        originalname: 'dropbox-glyph.png',
        size: DROPBOX_GLYPH_PNG.length,
      } as Express.Multer.File);
      return { dto, glyphAid: aid };
    } catch (e) {
      this.logger.warn(`Logo Dropbox tidak terlampir: ${(e as Error).message}`);
      return {
        dto: {
          ...dto,
          bodyHtml: html.replace(
            /<img\b[^>]*\bsrc=(["'])cid:dropbox-glyph@taskmanager\1[^>]*>/gi,
            '',
          ),
        },
      };
    }
  }

  /** Gabungkan aid baru + part lampiran yang sudah ada di draf. */
  private buildAttachBlock(
    dto: SendMessageDto,
  ): { attach: Record<string, unknown> } | Record<string, never> {
    const aids = (dto.attachmentAids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parts = (dto.attachmentParts || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const attach: Record<string, unknown> = {};
    if (aids.length) attach.aid = aids.join(',');
    // attach.mp = MimePartAttachSpec → wajib mid+part (pesan lama), bukan upload aid
    if (parts.length && dto.draftId) {
      attach.mp = parts.map((part) => ({ mid: dto.draftId, part }));
    }
    if (!Object.keys(attach).length) return {};
    return { attach };
  }

  async messageAction(nik: string, id: string, dto: MessageActionDto) {
    const OPS: Record<string, string> = {
      read: 'read',
      unread: '!read',
      '!read': '!read',
      flag: 'flag',
      unflag: '!flag',
      '!flag': '!flag',
      trash: 'trash',
      spam: 'spam',
      unspam: '!spam',
      move: 'move',
      delete: 'delete',
      tag: 'tag',
      untag: '!tag',
      '!tag': '!tag',
    };
    const op = OPS[dto.op];
    if (!op) throw new BadRequestException(`Operasi tidak dikenal: ${dto.op}`);
    const action: Record<string, unknown> = { id, op };
    if (dto.folderId) action.l = dto.folderId;
    if (dto.tagName) action.tn = dto.tagName;

    await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        MsgActionRequest: {
          _jsns: 'urn:zimbraMail',
          action,
        },
      }),
    );
    return { ok: true };
  }

  async getTags(nik: string) {
    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        GetTagRequest: { _jsns: 'urn:zimbraMail' },
      }),
    );
    const tags = this.asArray(
      (body as { GetTagResponse?: { tag?: unknown } }).GetTagResponse?.tag,
    );
    return tags.map((t) => {
      const o = t as { id?: string; name?: string; color?: string | number };
      return { id: String(o.id || ''), name: String(o.name || ''), color: o.color ?? null };
    });
  }

  /**
   * Signature Zimbra akun (default + list).
   * Dipakai compose: Zimbra dulu; FE boleh fallback custom lokal jika kosong.
   */
  async getSignatures(nik: string) {
    const { signatures, defaultId } = await this.withAuth(nik, async (token) => {
      const [sigBody, prefsBody] = await Promise.all([
        this.zimbra.call(token, {
          GetSignaturesRequest: { _jsns: 'urn:zimbraAccount' },
        }),
        this.zimbra.call(token, {
          GetPrefsRequest: {
            _jsns: 'urn:zimbraAccount',
            pref: { name: 'zimbraPrefDefaultSignatureId' },
          },
        }),
      ]);

      const raw = this.asArray(
        (sigBody as { GetSignaturesResponse?: { signature?: unknown } }).GetSignaturesResponse
          ?.signature,
      );
      const signatures = raw.map((s) => this.mapSignature(s));

      const prefs = this.asArray(
        (prefsBody as { GetPrefsResponse?: { pref?: unknown } }).GetPrefsResponse?.pref,
      );
      let defaultId: string | null = null;
      for (const p of prefs) {
        const o = p as { name?: string; _content?: string };
        if (o.name === 'zimbraPrefDefaultSignatureId' && o._content) {
          defaultId = String(o._content);
          break;
        }
      }
      return { signatures, defaultId };
    });

    const defaultSig =
      signatures.find((s) => s.id && s.id === defaultId) ||
      signatures.find((s) => s.html.trim()) ||
      signatures[0] ||
      null;

    return {
      defaultId: defaultSig?.id || defaultId,
      defaultHtml: defaultSig?.html || '',
      signatures,
    };
  }

  /** Buat / ubah signature HTML di Zimbra; set sebagai default bila baru. */
  async saveSignature(
    nik: string,
    dto: { id?: string; name?: string; html: string },
  ) {
    const html = (dto.html || '').trim();
    const name = (dto.name || 'Signature').trim() || 'Signature';

    return this.withAuth(nik, async (token) => {
      if (dto.id) {
        await this.zimbra.call(token, {
          ModifySignatureRequest: {
            _jsns: 'urn:zimbraAccount',
            signature: {
              id: dto.id,
              name,
              content: [
                { type: 'text/html', _content: html },
                { type: 'text/plain', _content: this.stripHtml(html) },
              ],
            },
          },
        });
        return { ok: true, id: dto.id };
      }

      const created = await this.zimbra.call(token, {
        CreateSignatureRequest: {
          _jsns: 'urn:zimbraAccount',
          signature: {
            name,
            content: [
              { type: 'text/html', _content: html },
              { type: 'text/plain', _content: this.stripHtml(html) },
            ],
          },
        },
      });
      const sig = this.asArray(
        (created as { CreateSignatureResponse?: { signature?: unknown } }).CreateSignatureResponse
          ?.signature,
      )[0] as { id?: string } | undefined;
      const id = sig?.id ? String(sig.id) : null;
      if (id) {
        try {
          await this.zimbra.call(token, {
            ModifyPrefsRequest: {
              _jsns: 'urn:zimbraAccount',
              pref: [{ name: 'zimbraPrefDefaultSignatureId', _content: id }],
            },
          });
        } catch {
          /* default pref optional */
        }
      }
      return { ok: true, id };
    });
  }

  private mapSignature(raw: unknown): {
    id: string;
    name: string;
    html: string;
    text: string;
  } {
    const s = raw as {
      id?: string;
      name?: string;
      content?: unknown;
    };
    const contents = this.asArray(s.content) as Array<{
      type?: string;
      _content?: string;
    }>;
    const html =
      contents.find((c) => String(c.type || '').includes('html'))?._content ||
      contents.find((c) => c._content)?._content ||
      '';
    const text =
      contents.find((c) => String(c.type || '').includes('plain'))?._content ||
      this.stripHtml(html);
    return {
      id: String(s.id || ''),
      name: String(s.name || 'Signature'),
      html: String(html || ''),
      text: String(text || ''),
    };
  }

  async autocomplete(nik: string, q: string) {
    const name = (q || '').trim();
    if (name.length < 1) return [];
    const seen = new Set<string>();
    const out: Array<{ email: string; name: string; type: string }> = [];

    const pushMatch = (emailRaw: string, display: string, type: string) => {
      const parsed = this.parseAddress(emailRaw);
      const email = parsed.email;
      if (!email || !email.includes('@')) return;
      const key = email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        email,
        name: display || parsed.name || email.split('@')[0],
        type: type || 'contact',
      });
    };

    const body = await this.withAuth(nik, (token) =>
      this.zimbra.call(token, {
        AutoCompleteRequest: {
          _jsns: 'urn:zimbraMail',
          name,
          includeGal: '1',
          needExp: '1',
        },
      }),
    );
    const matches = this.asArray(
      (body as { AutoCompleteResponse?: { match?: unknown } }).AutoCompleteResponse?.match,
    );
    for (const raw of matches) {
      const m = raw as {
        email?: string;
        full?: string;
        first?: string;
        last?: string;
        display?: string;
        type?: string;
      };
      pushMatch(
        m.email || '',
        m.full || m.display || [m.first, m.last].filter(Boolean).join(' '),
        m.type || 'contact',
      );
    }

    if (out.length < 5) {
      try {
        const gal = await this.withAuth(nik, (token) =>
          this.zimbra.call(token, {
            SearchGalRequest: {
              _jsns: 'urn:zimbraAccount',
              name,
              type: 'account',
              limit: 8,
            },
          }),
        );
        const cns = this.asArray(
          (gal as { SearchGalResponse?: { cn?: unknown } }).SearchGalResponse?.cn,
        );
        for (const raw of cns) {
          const cn = raw as {
            _attrs?: {
              email?: string;
              email2?: string;
              fullName?: string;
              firstName?: string;
              lastName?: string;
              displayName?: string;
            };
          };
          const a = cn._attrs || {};
          const addr = a.email || a.email2 || '';
          const display =
            a.fullName || a.displayName || [a.firstName, a.lastName].filter(Boolean).join(' ');
          pushMatch(addr, display, 'gal');
        }
      } catch {
        /* GAL optional */
      }
    }

    return out.slice(0, 12);
  }

  private parseAddress(raw: string): { name: string; email: string } {
    const angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (angle) return { name: angle[1].trim(), email: angle[2].trim() };
    return { name: '', email: raw.trim() };
  }

  /** Di atas threshold → Dropbox shared link (bukan attachment Zimbra). */
  static readonly DROPBOX_THRESHOLD_BYTES = 5 * 1024 * 1024;
  /** Max via Dropbox (Zimbra tetap hanya file ≤ threshold). */
  static readonly MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

  async uploadAttachment(
    nik: string,
    file: Express.Multer.File,
    options?: { expiresAt?: string; password?: string; signal?: AbortSignal },
  ) {
    if (!file) throw new BadRequestException('File wajib');
    if (file.size > MailboxService.MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Lampiran maksimal 2GB');
    }
    this.throwIfUploadAborted(options?.signal);

    const filename = file.originalname || 'file';

    try {
      if (file.size > MailboxService.DROPBOX_THRESHOLD_BYTES) {
        const password = options?.password?.trim() || undefined;
        if (password && password.length < 4) {
          throw new BadRequestException('Password file minimal 4 karakter');
        }

        let expiresAt: Date | undefined;
        if (options?.expiresAt) {
          const d = new Date(options.expiresAt);
          if (Number.isNaN(d.getTime())) {
            throw new BadRequestException('Tanggal kadaluarsa tidak valid');
          }
          if (d.getTime() <= Date.now() + 5 * 60_000) {
            throw new BadRequestException('Kadaluarsa harus lebih dari 5 menit dari sekarang');
          }
          const max = Date.now() + 366 * 24 * 60 * 60_000;
          if (d.getTime() > max) {
            throw new BadRequestException('Kadaluarsa maksimal 1 tahun');
          }
          expiresAt = d;
        }

        this.throwIfUploadAborted(options?.signal);

        const safeName = filename.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
        const path = `mailbox/${nik.trim()}/${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
        const mime = file.mimetype || 'application/octet-stream';

        const uploaded = file.path
          ? await this.dropbox.uploadLocalFileWithShareOptions(
              path,
              file.path,
              file.size,
              mime,
              { expiresAt, password, signal: options?.signal },
            )
          : await this.dropbox.uploadFileWithShareOptions(
              path,
              await this.readUploadBuffer(file),
              mime,
              { expiresAt, password, signal: options?.signal },
            );

        this.throwIfUploadAborted(options?.signal);

        const url = uploaded.passwordProtected
          ? uploaded.url
          : this.toDropboxDownloadUrl(uploaded.url);

        return {
          via: 'dropbox' as const,
          url,
          filename,
          size: file.size,
          expiresAt: uploaded.expiresAt ?? expiresAt?.toISOString() ?? null,
          passwordProtected: uploaded.passwordProtected,
        };
      }

      this.throwIfUploadAborted(options?.signal);

      // Zimbra upload expects Multer file with buffer
      const buffer = await this.readUploadBuffer(file);
      const zimbraFile = { ...file, buffer };
      const zimbra = await this.withAuth(nik, (token) =>
        this.zimbra.uploadAttachment(token, zimbraFile as Express.Multer.File),
      );
      return {
        via: 'zimbra' as const,
        aid: zimbra.aid,
        filename,
        size: file.size,
        expiresAt: null,
        passwordProtected: false,
      };
    } finally {
      await this.cleanupUploadTemp(file);
    }
  }

  private throwIfUploadAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new BadRequestException('Upload dibatalkan');
    }
  }

  private async readUploadBuffer(file: Express.Multer.File): Promise<Buffer> {
    if (file.buffer?.length) return file.buffer;
    if (file.path) {
      const { readFile } = await import('fs/promises');
      return readFile(file.path);
    }
    throw new BadRequestException('File upload kosong');
  }

  private async cleanupUploadTemp(file: Express.Multer.File): Promise<void> {
    if (!file.path) return;
    try {
      const { unlink } = await import('fs/promises');
      await unlink(file.path);
    } catch {
      // ignore
    }
  }

  private toDropboxDownloadUrl(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.delete('raw');
      u.searchParams.set('dl', '1');
      return u.toString();
    } catch {
      return url.includes('dl=') ? url.replace(/dl=0/, 'dl=1') : `${url}${url.includes('?') ? '&' : '?'}dl=1`;
    }
  }

  async downloadAttachment(nik: string, messageId: string, part: string) {
    const path = `/service/home/~/?auth=co&id=${encodeURIComponent(messageId)}&part=${encodeURIComponent(part)}`;
    return this.withAuth(nik, (token) => this.zimbra.downloadContent(token, path));
  }

  private async resolveCredential(nik: string, accountEmail?: string) {
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { activeZimbraEmail: true },
    });
    const email =
      normalizeMailboxEmail(accountEmail || user?.activeZimbraEmail || '') || null;
    if (!email) {
      throw new BadRequestException('Mailbox belum terhubung. Hubungkan akun Zimbra dulu.');
    }
    const cred = await this.prisma.dT_MAILBOX_CREDENTIAL.findUnique({
      where: { nik_zimbraEmail: { nik, zimbraEmail: email } },
    });
    if (!cred) {
      throw new BadRequestException('Mailbox belum terhubung. Hubungkan akun Zimbra dulu.');
    }
    return cred;
  }

  private async withAuth<T>(
    nik: string,
    fn: (token: string) => Promise<T>,
    accountEmail?: string,
  ): Promise<T> {
    const cred = await this.resolveCredential(nik, accountEmail);

    let token = cred.authToken;
    const expired =
      !token ||
      !cred.authTokenExpiresAt ||
      cred.authTokenExpiresAt.getTime() < Date.now() + 30_000;

    if (expired) {
      token = await this.refreshAuth(cred);
    }

    if (!cred.displayName?.trim() && token) {
      try {
        const name = await this.zimbra.getAccountDisplayName(token);
        if (name) {
          await this.prisma.dT_MAILBOX_CREDENTIAL.update({
            where: { id: cred.id },
            data: { displayName: name },
          });
          (cred as { displayName?: string | null }).displayName = name;
        }
      } catch {
        /* optional backfill */
      }
    }

    try {
      return await fn(token!);
    } catch (e) {
      const msg = (e as Error).message || '';
      const authish =
        /auth|expired|session|not authenticated|no such|invalid/i.test(msg) ||
        (e as { zimbraFault?: boolean }).zimbraFault;
      if (!authish) throw e;
      this.logger.debug(`Re-auth after fault for ${nik}: ${msg}`);
      token = await this.refreshAuth(cred);
      return fn(token);
    }
  }

  private async refreshAuth(cred: {
    id: string;
    nik: string;
    zimbraEmail: string;
    displayName?: string | null;
    passwordCipher: string;
    passwordIv: string;
    passwordTag: string;
  }): Promise<string> {
    const password = this.crypto.decrypt({
      cipher: cred.passwordCipher,
      iv: cred.passwordIv,
      tag: cred.passwordTag,
    });
    const { authToken, lifetimeMs } = await this.zimbra.auth(cred.zimbraEmail, password);
    const expires = new Date(Date.now() + Math.max(lifetimeMs - 60_000, 5 * 60_000));
    const data: {
      authToken: string;
      authTokenExpiresAt: Date;
      displayName?: string;
    } = { authToken, authTokenExpiresAt: expires };
    if (!cred.displayName?.trim()) {
      const name = await this.zimbra.getAccountDisplayName(authToken);
      if (name) data.displayName = name;
    }
    await this.prisma.dT_MAILBOX_CREDENTIAL.update({
      where: { id: cred.id },
      data,
    });
    return authToken;
  }

  private buildMimeEmail(dto: SendMessageDto) {
    const e: Array<{ t: string; a: string; p?: string }> = [];
    const push = (t: string, raw: string) => {
      const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      if (m) e.push({ t, a: m[2].trim(), ...(m[1].trim() ? { p: m[1].trim() } : {}) });
      else e.push({ t, a: raw });
    };
    for (const addr of this.splitAddrs(dto.to || '')) push('t', addr);
    for (const addr of this.splitAddrs(dto.cc || '')) push('c', addr);
    for (const addr of this.splitAddrs(dto.bcc || '')) push('b', addr);
    return e;
  }

  private buildBodyParts(dto: SendMessageDto, glyphAid?: string) {
    const html = dto.bodyHtml?.trim();
    const text = dto.bodyText?.trim() || this.stripHtml(html || '');
    if (!html) {
      return { ct: 'text/plain', content: { _content: text } };
    }

    const alternative = {
      ct: 'multipart/alternative',
      mp: [
        { ct: 'text/plain', content: { _content: text } },
        { ct: 'text/html', content: { _content: html } },
      ],
    };

    // Logo kartu Dropbox: multipart/related + cid (bukan attach.mp — itu butuh mid)
    if (glyphAid) {
      return {
        ct: 'multipart/related',
        mp: [
          alternative,
          {
            ct: 'image/png',
            ci: DROPBOX_GLYPH_CID,
            cd: 'inline',
            filename: 'dropbox-glyph.png',
            attach: { aid: glyphAid },
          },
        ],
      };
    }

    return alternative;
  }

  private splitAddrs(raw: string): string[] {
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private asArray(v: unknown): unknown[] {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  private mailFoldersOnly(nodes: FolderNode[]): FolderNode[] {
    const top: FolderNode[] = [];
    for (const n of nodes) {
      if (n.id === '1' || n.name === 'USER_ROOT') top.push(...(n.children || []));
      else top.push(n);
    }
    const filter = (list: FolderNode[]): FolderNode[] =>
      list
        .filter((f) => this.isMailFolder(f))
        .map((f) => ({ ...f, children: filter(f.children || []) }));
    return filter(top);
  }

  private isMailFolder(f: FolderNode): boolean {
    const nonMailIds = new Set(['1', '7', '10', '13', '14', '15', '16']);
    const nonMailViews = new Set([
      'contact',
      'appointment',
      'task',
      'document',
      'wiki',
      'comment',
      'chat',
    ]);
    const nonMailNames = new Set([
      'user_root',
      'calendar',
      'contacts',
      'emailed contacts',
      'chats',
      'tasks',
      'briefcase',
      'comments',
    ]);
    if (nonMailIds.has(f.id)) return false;
    if (f.view && nonMailViews.has(f.view)) return false;
    if (nonMailNames.has(f.name.toLowerCase())) return false;
    return true;
  }


  private calendarFoldersOnly(nodes: FolderNode[]): FolderNode[] {
    const top: FolderNode[] = [];
    for (const n of nodes) {
      if (n.id === '1' || n.name === 'USER_ROOT') top.push(...(n.children || []));
      else top.push(n);
    }
    const walk = (list: FolderNode[]): FolderNode[] => {
      const out: FolderNode[] = [];
      for (const f of list) {
        const kids = walk(f.children || []);
        if (this.isCalendarFolder(f)) {
          out.push({ ...f, children: kids });
        } else {
          out.push(...kids);
        }
      }
      return out;
    };
    return walk(top);
  }

  private isCalendarFolder(f: FolderNode): boolean {
    if (f.id === '10') return true;
    if (f.view === 'appointment') return true;
    const n = (f.name || '').toLowerCase();
    return n === 'calendar' || n === 'kalender';
  }

  private mapApptEvents(raw: unknown): CalendarEvent[] {
    const a = raw as {
      id?: string;
      uid?: string;
      name?: string;
      loc?: string;
      dur?: number | string;
      allDay?: boolean | string;
      l?: string;
      fr?: string;
      inst?: unknown;
      s?: number | string;
    };
    const dur = Number(a.dur || 0);
    const allDay = a.allDay === true || a.allDay === '1';
    const folderId = a.l ? String(a.l) : undefined;
    const title = String(a.name || '(tanpa judul)');
    const location = a.loc ? String(a.loc) : null;
    const fragment = a.fr ? String(a.fr) : undefined;
    const appointmentId = String(a.id || a.uid || '');

    const push = (startMs: number, rid?: string): CalendarEvent | null => {
      if (!Number.isFinite(startMs) || startMs <= 0) return null;
      const endMs = startMs + (Number.isFinite(dur) && dur > 0 ? dur : allDay ? 86_400_000 : 3_600_000);
      return {
        id: `${appointmentId}-${startMs}${rid ? `-${rid}` : ''}`,
        appointmentId,
        title,
        location,
        start: startMs,
        end: endMs,
        allDay,
        folderId,
        fragment,
      };
    };

    const events: CalendarEvent[] = [];
    const insts = this.asArray(a.inst);
    if (insts.length) {
      for (const inst of insts) {
        const i = inst as { s?: number | string; ridZ?: string; recurId?: string };
        const ev = push(Number(i.s || 0), i.ridZ || i.recurId);
        if (ev) events.push(ev);
      }
    } else {
      const ev = push(Number(a.s || 0));
      if (ev) events.push(ev);
    }
    return events;
  }

  private mapFolder(raw: unknown): FolderNode {
    const f = raw as {
      id?: string;
      name?: string;
      absFolderPath?: string;
      path?: string;
      u?: number | string;
      /** IMAP unread — fallback bila `u` kosong di beberapa setup Zimbra */
      i4u?: number | string;
      n?: number | string;
      i4n?: number | string;
      view?: string;
      color?: number | string;
      rgb?: string;
      folder?: unknown;
    };

    let color: number | null = null;
    if (f.color != null && f.color !== '') {
      const n = Number(f.color);
      color = Number.isFinite(n) ? n : null;
    }

    const rgb =
      typeof f.rgb === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(f.rgb.trim())
        ? f.rgb.trim()
        : null;

    const unread = Number(f.u ?? f.i4u ?? 0);
    const total = Number(f.n ?? f.i4n ?? 0);

    return {
      id: String(f.id || ''),
      name: String(f.name || ''),
      path: String(f.absFolderPath || f.path || f.name || ''),
      absFolderPath: f.absFolderPath,
      u: Number.isFinite(unread) ? unread : 0,
      n: Number.isFinite(total) ? total : 0,
      view: f.view,
      color,
      rgb,
      children: this.asArray(f.folder).map((c) => this.mapFolder(c)),
    };
  }

  private mapMessageSummary(raw: unknown): MessageSummary {
    const m = raw as {
      id?: string;
      su?: string;
      fr?: string;
      d?: number | string;
      s?: number | string;
      f?: string;
      l?: string;
      e?: unknown;
      tn?: string;
    };
    const emails = this.asArray(m.e) as Array<{ t?: string; a?: string; p?: string; d?: string }>;
    const from = emails.find((e) => e.t === 'f');
    const fmt = (e: { a?: string; p?: string; d?: string }) =>
      e.p || e.d ? `${(e.p || e.d || '').replace(/[,<>"]/g, ' ').trim()} <${e.a || ''}>` : e.a || '';
    const to = emails.filter((e) => e.t === 't');
    const cc = emails.filter((e) => e.t === 'c');
    const bcc = emails.filter((e) => e.t === 'b');
    const flags = String(m.f || '');
    return {
      id: String(m.id || ''),
      subject: String(m.su || '(tanpa subjek)'),
      from: from ? `${from.p || from.d || ''} <${from.a || ''}>`.trim() : '',
      to: to.map(fmt).join(', '),
      cc: cc.map(fmt).join(', '),
      bcc: bcc.map(fmt).join(', '),
      date: Number(m.d || 0),
      fragment: String(m.fr || ''),
      size: Number(m.s || 0),
      flags,
      isUnread: flags.includes('u'),
      isFlagged: flags.includes('f'),
      hasAttachment: flags.includes('a'),
      folderId: m.l ? String(m.l) : undefined,
      tags: m.tn ? String(m.tn).split(',').filter(Boolean) : [],
    };
  }

  private mapMessageDetail(raw: unknown) {
    const summary = this.mapMessageSummary(raw);
    const m = raw as {
      mp?: unknown;
      mid?: string;
      cid?: string;
      irt?: string;
    };
    let { html, text, attachments } = this.extractParts(m.mp);

    if (html && summary.id) {
      for (const att of attachments) {
        const url = `/api/mailbox/attachments/${encodeURIComponent(summary.id)}/${encodeURIComponent(att.part)}`;
        if (att.contentId) {
          const safeCid = att.contentId.replace(new RegExp("[.*+?^()|\[\]\\]", "g"), "\$&");
          html = html.replace(new RegExp(`cid:${safeCid}`, 'gi'), url);
        }
        if (att.filename) {
          const safeFn = att.filename.replace(new RegExp("[.*+?^()|\[\]\\]", "g"), "\$&");
          html = html.replace(new RegExp(`cid:${safeFn}`, 'gi'), url);
        }
        const safePart = att.part.replace(new RegExp("[.*+?^()|\[\]\\]", "g"), "\$&");
        html = html.replace(new RegExp(`cid:${safePart}`, 'gi'), url);
      }

      html = html.replace(
        /(?:https?:\/\/[^"'\s>]+)?\/service\/home\/~?\/\?[^"'\s>]*part=([^&"'\s>]+)[^"'\s>]*/gi,
        (_match, part) => {
          return `/api/mailbox/attachments/${encodeURIComponent(summary.id)}/${encodeURIComponent(part)}`;
        },
      );
    }

    const visibleAttachments = attachments.filter(
      (a) => a.contentId !== DROPBOX_GLYPH_CID,
    );

    return {
      ...summary,
      html,
      text,
      attachments: visibleAttachments,
      messageId: m.mid || null,
      conversationId: m.cid || null,
      inReplyTo: m.irt || null,
    };
  }

  private extractParts(mp: unknown): {
    html: string;
    text: string;
    attachments: Array<{
      part: string;
      filename: string;
      contentType: string;
      size: number;
      contentId?: string;
    }>;
  } {
    let html = '';
    let text = '';
    const attachments: Array<{
      part: string;
      filename: string;
      contentType: string;
      size: number;
      contentId?: string;
    }> = [];

    const walk = (node: unknown) => {
      if (!node) return;
      for (const part of this.asArray(node)) {
        const p = part as {
          ct?: string;
          part?: string;
          filename?: string;
          s?: number | string;
          body?: boolean | string;
          content?: { _content?: string } | string;
          mp?: unknown;
          cd?: string;
          ci?: string;
        };
        const ct = String(p.ct || '').toLowerCase();
        const content =
          typeof p.content === 'string'
            ? p.content
            : String((p.content as { _content?: string })?._content || '');
        if (ct.includes('text/html') && content) html = content;
        else if (ct.includes('text/plain') && content && !text) text = content;

        const isImage = ct.startsWith('image/');
        const isAttachment =
          Boolean(p.filename) ||
          p.cd === 'attachment' ||
          p.cd === 'inline' ||
          Boolean(p.ci) ||
          isImage;

        if (isAttachment && p.part && !ct.includes('text/html') && !ct.includes('text/plain')) {
          const cleanCi = p.ci ? String(p.ci).replace(/^<|>$/g, '').trim() : undefined;
          attachments.push({
            part: String(p.part || ''),
            filename: String(
              p.filename || (cleanCi ? cleanCi : `image-${p.part}.${ct.split('/')[1] || 'png'}`),
            ),
            contentType: String(p.ct || 'application/octet-stream'),
            size: Number(p.s || 0),
            contentId: cleanCi,
          });
        }
        if (p.mp) walk(p.mp);
      }
    };
    walk(mp);
    return { html, text, attachments };
  }
}
