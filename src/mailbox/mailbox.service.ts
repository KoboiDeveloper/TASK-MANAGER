import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { mkdir, rename, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import type { GmailAttachmentInput } from './gmail-api.client';
import {
  GoogleOAuthClient,
  hasDriveScope,
  hasGmailScope,
} from '../google-calendar/google-oauth.client';
import { MailboxCryptoService } from './mailbox-crypto.service';
import { ZimbraSoapClient } from './zimbra-soap.client';
import { GmailApiClient } from './gmail-api.client';
import { GmailDriveClient, type DriveShareMode } from './gmail-drive.client';
import { DropboxStorageService } from '../storage/dropbox.storage.service';
import { DriveService } from '../cloud/drive/drive.service';
import { CloudPrismaService } from '../cloud/prisma/prisma.service';
import { ConnectMailboxDto, MessageActionDto, SendMessageDto } from './dto/mailbox.dto';
import { DROPBOX_GLYPH_CID, DROPBOX_GLYPH_PNG } from './dropbox-glyph';
import {
  normalizeMailboxEmail,
  pickActiveAfterDisconnect,
  type MailboxProvider,
} from './mailbox-active.util';

/** DT_USER.activeZimbraEmail stores the active mailbox email for ANY provider (zimbra|gmail). */
type MergedMailboxAccount = {
  email: string;
  name: string | null;
  photoUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
  provider: MailboxProvider;
};

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

  /** Staged Gmail uploads (aid → disk path). Cleared after send. */
  private readonly gmailStaged = new Map<
    string,
    {
      nik: string;
      path: string;
      filename: string;
      contentType: string;
      size: number;
    }
  >();

  static readonly GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailboxCryptoService,
    private readonly zimbra: ZimbraSoapClient,
    private readonly gmail: GmailApiClient,
    private readonly gmailDrive: GmailDriveClient,
    private readonly oauth: GoogleOAuthClient,
    private readonly dropbox: DropboxStorageService,
    private readonly amsDrive: DriveService,
    private readonly cloudPrisma: CloudPrismaService,
  ) {}

  async getStatus(nik: string) {
    const merged = await this.listMergedAccounts(nik);
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      // activeZimbraEmail = active mailbox email (zimbra or gmail)
      select: { activeZimbraEmail: true },
    });
    const accounts = merged.map((r) => ({
      email: r.email,
      name: r.name,
      photoUrl: r.photoUrl ?? null,
      provider: r.provider,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    let activeEmail = user?.activeZimbraEmail ?? null;
    if (activeEmail && !accounts.some((a) => a.email === activeEmail)) {
      activeEmail = pickActiveAfterDisconnect(
        merged.map((r) => ({
          email: r.email,
          createdAt: r.createdAt,
          provider: r.provider,
        })),
      );
      await this.prisma.dT_USER.update({
        where: { nik },
        data: { activeZimbraEmail: activeEmail },
      });
    }
    if (!activeEmail && accounts.length) {
      activeEmail = accounts[0].email; // newest (merged sorted desc)
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

  /**
   * Active mailbox ownership → provider + email.
   * Throws if no Zimbra/Gmail mailbox is connected.
   */
  async resolveMailboxContext(
    nik: string,
  ): Promise<{ provider: MailboxProvider; email: string }> {
    const merged = await this.listMergedAccounts(nik);
    if (!merged.length) {
      throw new BadRequestException(
        'Mailbox belum terhubung. Hubungkan akun Zimbra atau Google (Gmail) dulu.',
      );
    }
    const user = await this.prisma.dT_USER.findUnique({
      where: { nik },
      select: { activeZimbraEmail: true },
    });
    let activeEmail = user?.activeZimbraEmail ?? null;
    if (!activeEmail || !merged.some((a) => a.email === activeEmail)) {
      activeEmail = pickActiveAfterDisconnect(
        merged.map((r) => ({
          email: r.email,
          createdAt: r.createdAt,
          provider: r.provider,
        })),
      );
      if (activeEmail) {
        await this.prisma.dT_USER.update({
          where: { nik },
          data: { activeZimbraEmail: activeEmail },
        });
      }
    }
    const acc = merged.find((a) => a.email === activeEmail);
    if (!acc || !activeEmail) {
      throw new BadRequestException(
        'Mailbox belum terhubung. Hubungkan akun Zimbra atau Google (Gmail) dulu.',
      );
    }
    return { provider: acc.provider, email: acc.email };
  }

  private async listMergedAccounts(nik: string): Promise<MergedMailboxAccount[]> {
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

    const zimbraAccounts: MergedMailboxAccount[] = rows.map((r) => ({
      email: r.zimbraEmail,
      name: (r.displayName || '').trim() || null,
      photoUrl: null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      provider: 'zimbra' as const,
    }));

    const googleRows = await this.prisma.dT_GOOGLE_CREDENTIAL.findMany({
      where: { nik },
      orderBy: { createdAt: 'desc' },
      select: {
        googleEmail: true,
        displayName: true,
        photoUrl: true,
        createdAt: true,
        updatedAt: true,
        scope: true,
      },
    });

    const gmailAccounts: MergedMailboxAccount[] = [];
    for (const r of googleRows) {
      if (!hasGmailScope(r.scope)) continue;
      let photoUrl = (r.photoUrl || '').trim() || null;
      // Backfill foto Google sekali jika belum tersimpan (reconnect lama)
      if (!photoUrl) {
        try {
          const token = await this.getGoogleAccessToken(nik, r.googleEmail);
          const info = await this.oauth.getUserInfo(token);
          photoUrl = (info.picture || '').trim() || null;
          if (photoUrl) {
            await this.prisma.dT_GOOGLE_CREDENTIAL.update({
              where: {
                nik_googleEmail: { nik, googleEmail: r.googleEmail },
              },
              data: { photoUrl },
            });
          }
        } catch {
          /* best-effort */
        }
      }
      gmailAccounts.push({
        email: r.googleEmail,
        name: (r.displayName || '').trim() || null,
        photoUrl,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        provider: 'gmail' as const,
      });
    }

    return [...zimbraAccounts, ...gmailAccounts].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
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
    const merged = await this.listMergedAccounts(nik);
    const target = merged.find((a) => a.email === normalized);
    if (!target) {
      throw new BadRequestException('Akun tidak ditemukan');
    }
    if (target.provider === 'gmail') {
      throw new BadRequestException(
        'Lepas akun Google dari Pengaturan → Google (Calendar & Gmail)',
      );
    }

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
      const remaining = await this.listMergedAccounts(nik);
      const nextActive = pickActiveAfterDisconnect(
        remaining.map((r) => ({
          email: r.email,
          createdAt: r.createdAt,
          provider: r.provider,
        })),
      );
      await this.prisma.dT_USER.update({
        where: { nik },
        data: { activeZimbraEmail: nextActive },
      });
    }

    return this.getStatus(nik);
  }

  async setActive(nik: string, email: string) {
    const normalized = normalizeMailboxEmail(email);
    const merged = await this.listMergedAccounts(nik);
    const found = merged.find((a) => a.email === normalized);
    if (!found) {
      throw new BadRequestException('Akun tidak ditemukan');
    }
    await this.prisma.dT_USER.update({
      where: { nik },
      data: { activeZimbraEmail: normalized },
    });
    return this.getStatus(nik);
  }

  async getFolders(nik: string): Promise<FolderNode[]> {
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      return this.gmail.listFolders(token);
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    // Mailbox calendars are Zimbra-only; Google calendars live in GoogleCalendarService
    if (ctx.provider === 'gmail') return [];
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

    if (!input.email) {
      const ctx = await this.resolveMailboxContext(nik);
      if (ctx.provider === 'gmail') {
        throw new BadRequestException(
          'Buat event Google lewat Kalender Google, bukan mailbox Zimbra',
        );
      }
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

    if (!opts.email) {
      const ctx = await this.resolveMailboxContext(nik);
      if (ctx.provider === 'gmail') return [];
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
    opts: {
      folderId?: string;
      query?: string;
      offset?: number;
      limit?: number;
      pageToken?: string;
    },
  ): Promise<{
    messages: MessageSummary[];
    more: boolean;
    offset: number;
    nextPageToken?: string;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      const res = await this.gmail.listMessages(token, {
        labelIds: opts.folderId ? [opts.folderId] : undefined,
        q: opts.query?.trim() || undefined,
        maxResults: limit,
        pageToken: opts.pageToken,
      });
      return {
        messages: res.messages,
        more: res.more,
        offset,
        nextPageToken: res.nextPageToken,
      };
    }

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
    const ctx = await this.resolveMailboxContext(nik);
    let detail: any;
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      detail = await this.gmail.getMessage(token, id);
    } else {
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
      detail = this.mapMessageDetail(msg);
    }
    const savedAttachments = this.remapSavedAttachmentParts(
      detail?.attachments,
      await this.listSavedAttachments(nik, ctx.email, id),
    );
    return { ...detail, savedAttachments };
  }

  /** Gmail attachmentId bisa >> 64 char — simpan hash, FE tetap dapat part asli. */
  private partStorageKey(part: string): string {
    const p = String(part || '');
    if (p.length <= 64) return p;
    return createHash('sha256').update(p).digest('hex');
  }

  private clipStr(value: string | null | undefined, max: number): string | null {
    if (value == null) return null;
    const s = String(value);
    return s.length <= max ? s : s.slice(0, max);
  }

  /** Jangan pakai Gmail attachmentId sebagai nama file di Drive. */
  private safeCloudFilename(
    raw: string | null | undefined,
    part: string,
    mime?: string | null,
  ): string {
    let name = String(raw || '').trim();
    if (name === 'undefined') name = '';
    // attachmentId / content-id-ish: panjang & hampir tanpa spasi/dot bermakna
    const looksLikeId =
      !name ||
      name.length > 120 ||
      (name.length > 64 && !/\.[A-Za-z0-9]{1,8}$/.test(name) && !/\s/.test(name));
    if (looksLikeId) {
      const short = createHash('sha256').update(String(part)).digest('hex').slice(0, 8);
      const extFromMime = (() => {
        const m = String(mime || '').toLowerCase();
        if (m.includes('png')) return '.png';
        if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
        if (m.includes('gif')) return '.gif';
        if (m.includes('webp')) return '.webp';
        if (m.includes('pdf')) return '.pdf';
        if (m.includes('zip')) return '.zip';
        if (m.includes('msword') || m.includes('wordprocessingml')) return '.docx';
        if (m.includes('sheet') || m.includes('excel')) return '.xlsx';
        return '';
      })();
      name = `attachment-${short}${extFromMime}`;
    }
    const safe = name.replace(/[^\w.\- ()[\]]+/g, '_').replace(/_+/g, '_').trim() || 'attachment';
    if (safe.length <= 180) return safe;
    const dot = safe.lastIndexOf('.');
    const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : '';
    return `${safe.slice(0, 180 - ext.length)}${ext}`;
  }

  private remapSavedAttachmentParts(
    attachments:
      | Array<{ part?: string; filename?: string }>
      | undefined,
    saved: Array<{
      part: string;
      via: 'gdrive' | 'amsdrive';
      url: string;
      fileId: string | null;
      filename: string | null;
    }>,
  ) {
    const list = attachments || [];
    const keyToOriginal = new Map<string, string>();
    const filenameToPart = new Map<string, string>();
    for (const a of list) {
      const original = String(a.part || '');
      if (!original) continue;
      keyToOriginal.set(this.partStorageKey(original), original);
      keyToOriginal.set(original, original);
      const fn = String(a.filename || '')
        .trim()
        .toLowerCase();
      if (fn) filenameToPart.set(fn, original);
    }
    return saved.map((row) => {
      let part = keyToOriginal.get(row.part) || '';
      if (!part && row.filename) {
        part = filenameToPart.get(String(row.filename).trim().toLowerCase()) || '';
      }
      // attachmentId Gmail bisa beda tiap fetch / terpotong di URL — 1 lampiran → ikat langsung
      if (!part && list.length === 1 && list[0]?.part) {
        part = String(list[0].part);
      }
      return { ...row, part: part || row.part };
    });
  }

  /** Samakan part request dengan part yang diekspos getMessage (partId / filename / sole). */
  private canonicalAttachmentPart(
    attachments: Array<{ part?: string; filename?: string }> | undefined,
    requestedPart: string,
    filename?: string | null,
  ): string {
    const list = attachments || [];
    const req = String(requestedPart || '');
    if (list.some((a) => String(a.part) === req)) return req;
    const fn = String(filename || '')
      .trim()
      .toLowerCase();
    if (fn) {
      const byName = list.find(
        (a) =>
          String(a.filename || '')
            .trim()
            .toLowerCase() === fn,
      );
      if (byName?.part) return String(byName.part);
    }
    if (list.length === 1 && list[0]?.part) return String(list[0].part);
    return req;
  }

  private async listSavedAttachments(
    nik: string,
    mailboxEmail: string,
    messageId: string,
  ) {
    const rows = await this.prisma.dT_MAILBOX_SAVED_ATTACHMENT.findMany({
      where: {
        nik: nik.trim(),
        mailboxEmail: (this.clipStr(mailboxEmail.trim().toLowerCase(), 255) || '').trim(),
        messageId: this.clipStr(String(messageId), 255) || String(messageId),
      },
      select: {
        part: true,
        via: true,
        url: true,
        fileId: true,
        filename: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      part: r.part,
      via: r.via as 'gdrive' | 'amsdrive',
      url: r.url,
      fileId: r.fileId,
      filename: r.filename,
    }));
  }

  private async recordSavedAttachment(input: {
    nik: string;
    mailboxEmail: string;
    messageId: string;
    part: string;
    via: 'gdrive' | 'amsdrive';
    url: string;
    fileId?: string | null;
    filename?: string | null;
  }) {
    const nik = input.nik.trim();
    const mailboxEmail = (this.clipStr(input.mailboxEmail.trim().toLowerCase(), 255) || '').trim();
    const messageId = this.clipStr(String(input.messageId), 255) || '';
    const part = this.partStorageKey(input.part);
    const via = input.via;
    const url = this.clipStr(input.url, 1000) || '';
    const fileId = this.clipStr(input.fileId || null, 255);
    const filename = this.clipStr(input.filename || null, 500);
    if (!mailboxEmail || !messageId || !part || !url) {
      throw new BadRequestException('Gagal menyimpan status lampiran cloud');
    }
    await this.prisma.dT_MAILBOX_SAVED_ATTACHMENT.upsert({
      where: {
        nik_mailboxEmail_messageId_part_via: {
          nik,
          mailboxEmail,
          messageId,
          part,
          via,
        },
      },
      create: {
        id: randomUUID(),
        nik,
        mailboxEmail,
        messageId,
        part,
        via,
        url,
        fileId,
        filename,
      },
      update: {
        url,
        fileId,
        filename,
      },
    });
  }

  async sendMessage(nik: string, dto: SendMessageDto) {
    if (!this.splitAddrs(dto.to || '').length) {
      throw new BadRequestException('Tambahkan minimal satu penerima');
    }
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      const attachments = await this.resolveGmailAttachments(nik, token, dto);
      await this.grantGdriveRecipients(token, dto);
      const result = await this.gmail.sendMessage(token, dto, attachments);
      this.releaseGmailStagedAids(dto.attachmentAids);
      return result;
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      const attachments = await this.resolveGmailAttachments(nik, token, dto);
      return this.gmail.saveDraft(token, dto, attachments);
    }
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

  private async resolveGmailAttachments(
    nik: string,
    accessToken: string,
    dto: SendMessageDto,
  ): Promise<GmailAttachmentInput[]> {
    const out: GmailAttachmentInput[] = [];
    const aids = (dto.attachmentAids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const aid of aids) {
      const staged = this.gmailStaged.get(aid);
      if (!staged || staged.nik !== nik.trim()) {
        throw new BadRequestException(`Lampiran Gmail tidak ditemukan: ${aid}`);
      }
      const buf = await readFile(staged.path);
      out.push({
        filename: staged.filename,
        contentType: staged.contentType,
        contentBase64: buf.toString('base64'),
      });
    }

    const parts = (dto.attachmentParts || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const sourceId = (dto.draftId || dto.inReplyTo || '').trim();
    if (parts.length && !sourceId) {
      throw new BadRequestException(
        'Lampiran draf Gmail membutuhkan draftId atau inReplyTo',
      );
    }
    for (const part of parts) {
      const file = await this.gmail.downloadAttachment(accessToken, sourceId, part);
      out.push({
        filename: this.safeCloudFilename(undefined, part, 'application/octet-stream'),
        contentType: 'application/octet-stream',
        contentBase64: file.data.toString('base64'),
      });
    }

    const total = out.reduce(
      (n, a) => n + Buffer.from(a.contentBase64, 'base64').length,
      0,
    );
    if (total > MailboxService.GMAIL_MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        'Total lampiran Gmail maksimal 25 MB (batas pesan Gmail)',
      );
    }
    return out;
  }

  private async grantGdriveRecipients(accessToken: string, dto: SendMessageDto) {
    const raw = (dto.gdriveShares || '').trim();
    if (!raw) return;
    let shares: Array<{ fileId?: string; shareMode?: string }> = [];
    try {
      shares = JSON.parse(raw);
    } catch {
      throw new BadRequestException('gdriveShares JSON tidak valid');
    }
    if (!Array.isArray(shares) || !shares.length) return;
    const emails = [
      ...this.splitAddrs(dto.to || ''),
      ...this.splitAddrs(dto.cc || ''),
      ...this.splitAddrs(dto.bcc || ''),
    ];
    for (const s of shares) {
      if (!s?.fileId) continue;
      if (String(s.shareMode || '') !== 'restricted') continue;
      await this.gmailDrive.grantReaders(accessToken, String(s.fileId), emails);
    }
  }

  private releaseGmailStagedAids(attachmentAids?: string) {
    const aids = (attachmentAids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const aid of aids) {
      const staged = this.gmailStaged.get(aid);
      if (!staged) continue;
      this.gmailStaged.delete(aid);
      void unlink(staged.path).catch(() => undefined);
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      return this.gmail.messageAction(token, id, dto);
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      return this.gmail.listTags(token);
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      const res = await this.gmail.listSignatures(token);
      const defaultSig =
        res.signatures.find((s) => s.id && s.id === res.defaultId) ||
        res.signatures.find((s) => s.html.trim()) ||
        res.signatures[0] ||
        null;
      return {
        defaultId: defaultSig?.id || res.defaultId,
        defaultHtml: defaultSig?.html || '',
        signatures: res.signatures.map((s) => ({
          id: s.id,
          name: s.name,
          html: s.html,
          text: this.stripHtml(s.html),
        })),
      };
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      throw new BadRequestException(
        'Ubah signature Gmail di pengaturan Gmail / Google Account',
      );
    }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') return [];

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
  static readonly AMS_DRIVE_THRESHOLD_BYTES = 3 * 1024 * 1024;
  /** @deprecated alias — pakai AMS_DRIVE_THRESHOLD_BYTES */
  static readonly DROPBOX_THRESHOLD_BYTES = 3 * 1024 * 1024;
  /** Max via Dropbox (Zimbra tetap hanya file ≤ threshold). */
  static readonly MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

  async uploadAttachment(
    nik: string,
    file: Express.Multer.File,
    options?: {
      expiresAt?: string;
      password?: string;
      shareMode?: DriveShareMode;
      signal?: AbortSignal;
    },
  ) {
    if (!file) throw new BadRequestException('File wajib');
    this.throwIfUploadAborted(options?.signal);

    const filename = file.originalname || 'file';
    const ctx = await this.resolveMailboxContext(nik);

    // Gmail: ≤25MB inline; >25MB → Drive (never Dropbox)
    if (ctx.provider === 'gmail') {
      if (file.size > MailboxService.MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException('Lampiran maksimal 2GB');
      }
      const mime = file.mimetype || 'application/octet-stream';

      if (file.size > MailboxService.GMAIL_MAX_ATTACHMENT_BYTES) {
        const shareMode: DriveShareMode =
          options?.shareMode === 'restricted' ? 'restricted' : 'anyone';
        try {
          this.throwIfUploadAborted(options?.signal);
          const token = await this.getGoogleAccessToken(nik, ctx.email);
          const uploaded = await this.gmailDrive.uploadAndShare(token, {
            filename,
            mimeType: mime,
            size: file.size,
            path: file.path,
            buffer: file.path ? undefined : await this.readUploadBuffer(file),
            shareMode,
            signal: options?.signal,
          });
          return {
            via: 'gdrive' as const,
            url: uploaded.url,
            fileId: uploaded.fileId,
            shareMode: uploaded.shareMode,
            filename,
            size: file.size,
            expiresAt: null,
            passwordProtected: false,
          };
        } finally {
          await this.cleanupUploadTemp(file);
        }
      }

      try {
        this.throwIfUploadAborted(options?.signal);
        const aid = `gma-${randomUUID()}`;
        const dir = join(tmpdir(), 'mailbox-gmail-att', nik.trim());
        await mkdir(dir, { recursive: true });
        const dest = join(dir, aid);
        if (file.path) {
          await rename(file.path, dest);
          (file as { path?: string }).path = undefined;
        } else {
          await writeFile(dest, await this.readUploadBuffer(file));
        }
        this.gmailStaged.set(aid, {
          nik: nik.trim(),
          path: dest,
          filename,
          contentType: mime,
          size: file.size,
        });
        return {
          via: 'gmail' as const,
          aid,
          filename,
          size: file.size,
          expiresAt: null,
          passwordProtected: false,
        };
      } finally {
        await this.cleanupUploadTemp(file);
      }
    }

    if (file.size > MailboxService.MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Lampiran maksimal 2GB');
    }

    try {
      if (file.size > MailboxService.AMS_DRIVE_THRESHOLD_BYTES) {
        const cloudUser = await this.cloudPrisma.dT_USER.findUnique({
          where: { nik: nik.trim() },
          select: { nik: true, statusActive: true },
        });
        if (!cloudUser?.statusActive) {
          throw new BadRequestException(
            'Hubungkan AMS Drive dulu (menu Cloud) untuk mengirim lampiran besar',
          );
        }

        this.throwIfUploadAborted(options?.signal);

        try {
          const uploaded = await this.amsDrive.uploadFile(
            nik,
            file,
            undefined,
            file.path || undefined,
          );
          // DriveService sudah unlink localPath
          if (file.path) (file as { path?: string }).path = undefined;

          this.throwIfUploadAborted(options?.signal);

          const url = (uploaded.url as string) || '';
          if (!url) {
            throw new BadRequestException('Gagal membuat tautan AMS Drive');
          }

          return {
            via: 'amsdrive' as const,
            url,
            fileId: uploaded.id as string,
            filename: (uploaded.name as string) || filename,
            size: file.size,
            expiresAt: null,
            passwordProtected: false,
          };
        } catch (err: any) {
          const msg = String(err?.message || err || '');
          if (
            err instanceof BadRequestException ||
            /Hubungkan AMS Drive/i.test(msg)
          ) {
            throw err;
          }
          if (
            /Foreign key|P2003|ownerNik|User not found|Record to create/i.test(msg) ||
            err?.code === 'P2003'
          ) {
            throw new BadRequestException(
              'Hubungkan AMS Drive dulu (menu Cloud) untuk mengirim lampiran besar',
            );
          }
          if (/quota exceeded/i.test(msg)) {
            throw new BadRequestException('Kuota AMS Drive penuh');
          }
          throw err;
        }
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
    const ctx = await this.resolveMailboxContext(nik);
    if (ctx.provider === 'gmail') {
      const token = await this.getGoogleAccessToken(nik, ctx.email);
      // Gmail: `part` is the attachmentId from message detail
      const file = await this.gmail.downloadAttachment(token, messageId, part);
      return {
        buffer: file.data,
        contentType: 'application/octet-stream',
        filename: undefined as string | undefined,
      };
    }
    const path = `/service/home/~/?auth=co&id=${encodeURIComponent(messageId)}&part=${encodeURIComponent(part)}`;
    return this.withAuth(nik, (token) => this.zimbra.downloadContent(token, path));
  }

  /**
   * Config + short-lived access token for Google Picker (compose attach).
   * Prefer active Gmail mailbox; else any Google credential with drive.file.
   */
  async getGooglePickerConfig(nik: string) {
    const { googleEmail, accessToken } =
      await this.resolveDriveAccess(nik);
    const clientId =
      process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const apiKey = process.env.GOOGLE_PICKER_API_KEY;
    if (!clientId || !apiKey) {
      throw new BadRequestException(
        'Google Picker belum dikonfigurasi di server',
      );
    }
    return { clientId, apiKey, accessToken, googleEmail };
  }

  /**
   * Import an existing Google Drive file into compose: MIME stage (small) or share link (large).
   */
  async importGdriveAttachment(nik: string, fileId: string) {
    if (!fileId?.trim()) {
      throw new BadRequestException('fileId wajib');
    }
    const ctx = await this.resolveMailboxContext(nik);
    const { accessToken } = await this.resolveDriveAccess(nik);
    const meta = await this.gmailDrive.getFileMeta(accessToken, fileId.trim());

    if (
      String(meta.mimeType || '').startsWith('application/vnd.google-apps.')
    ) {
      throw new BadRequestException(
        'File Google Docs/Sheets tidak bisa dilampirkan langsung — export dulu ke PDF/DOCX',
      );
    }

    const size = Number(meta.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new BadRequestException('Ukuran file Drive tidak diketahui');
    }
    const threshold =
      ctx.provider === 'gmail'
        ? MailboxService.GMAIL_MAX_ATTACHMENT_BYTES
        : MailboxService.AMS_DRIVE_THRESHOLD_BYTES;
    const trimmedId = fileId.trim();

    if (size > MailboxService.MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Lampiran maksimal 2GB');
    }

    if (size > threshold) {
      const url = await this.gmailDrive.ensureAnyoneReader(
        accessToken,
        trimmedId,
      );
      return {
        via: 'gdrive' as const,
        url,
        fileId: meta.id || trimmedId,
        filename: meta.name,
        size,
        shareMode: 'anyone' as const,
      };
    }

    const buffer = await this.gmailDrive.downloadFile(accessToken, trimmedId);
    const actual = buffer.length;
    if (actual > MailboxService.MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Lampiran maksimal 2GB');
    }
    if (actual > threshold) {
      const url = await this.gmailDrive.ensureAnyoneReader(
        accessToken,
        trimmedId,
      );
      return {
        via: 'gdrive' as const,
        url,
        fileId: meta.id || trimmedId,
        filename: meta.name,
        size: actual,
        shareMode: 'anyone' as const,
      };
    }
    return this.stageImportedBuffer(nik, ctx, {
      filename: meta.name,
      mimeType: meta.mimeType || 'application/octet-stream',
      buffer,
    });
  }

  /**
   * Prefer active Gmail email only if it has drive.file; else any credential with Drive scope.
   */
  private async resolveDriveAccess(nik: string): Promise<{
    googleEmail: string;
    accessToken: string;
  }> {
    const ctx = await this.resolveMailboxContext(nik);
    const rows = await this.prisma.dT_GOOGLE_CREDENTIAL.findMany({
      where: { nik },
      select: { googleEmail: true, scope: true },
      orderBy: { updatedAt: 'desc' },
    });
    let email: string | null = null;
    if (ctx.provider === 'gmail') {
      const active = rows.find((r) => r.googleEmail === ctx.email);
      if (active && hasDriveScope(active.scope)) {
        email = active.googleEmail;
      }
    }
    if (!email) {
      email = rows.find((r) => hasDriveScope(r.scope))?.googleEmail ?? null;
    }
    if (!email) {
      throw new BadRequestException(
        'Hubungkan Google + Drive dulu di Pengaturan',
      );
    }
    const accessToken = await this.getGoogleAccessToken(nik, email);
    return { googleEmail: email, accessToken };
  }

  /** Stage/upload a buffer as a small MIME attachment (gmail disk stage or zimbra upload). */
  private async stageImportedBuffer(
    nik: string,
    ctx: { provider: MailboxProvider; email: string },
    input: { filename: string; mimeType: string; buffer: Buffer },
  ) {
    const filename = input.filename || 'file';
    const mime = input.mimeType || 'application/octet-stream';
    const size = input.buffer?.length ?? 0;
    if (!size) {
      throw new BadRequestException('File Drive kosong');
    }

    if (ctx.provider === 'gmail') {
      const aid = `gma-${randomUUID()}`;
      const dir = join(tmpdir(), 'mailbox-gmail-att', nik.trim());
      await mkdir(dir, { recursive: true });
      const dest = join(dir, aid);
      await writeFile(dest, input.buffer);
      this.gmailStaged.set(aid, {
        nik: nik.trim(),
        path: dest,
        filename,
        contentType: mime,
        size,
      });
      return {
        via: 'gmail' as const,
        aid,
        filename,
        size,
        expiresAt: null,
        passwordProtected: false,
      };
    }

    const zimbraFile = {
      buffer: input.buffer,
      originalname: filename,
      mimetype: mime,
      size,
    };
    const zimbra = await this.withAuth(nik, (token) =>
      this.zimbra.uploadAttachment(
        token,
        zimbraFile as Express.Multer.File,
      ),
    );
    return {
      via: 'zimbra' as const,
      aid: zimbra.aid,
      filename,
      size,
      expiresAt: null,
      passwordProtected: false,
    };
  }

  /**
   * Salin lampiran pesan ke Google Drive milik user (My Drive).
   * Butuh credential Google dengan scope drive.file.
   */
  async saveAttachmentToDrive(nik: string, messageId: string, part: string) {
    const file = await this.downloadAttachment(nik, messageId, part);
    const buffer = file.buffer;
    if (!buffer?.length) {
      throw new BadRequestException('Lampiran kosong');
    }

    // Prefer active Gmail mailbox token; else any Google account with Drive scope
    const ctx = await this.resolveMailboxContext(nik);
    let googleEmail = ctx.provider === 'gmail' ? ctx.email : null;
    if (!googleEmail) {
      const rows = await this.prisma.dT_GOOGLE_CREDENTIAL.findMany({
        where: { nik },
        select: { googleEmail: true, scope: true },
        orderBy: { updatedAt: 'desc' },
      });
      const withDrive = rows.find((r) => hasDriveScope(r.scope));
      googleEmail = withDrive?.googleEmail ?? null;
    }
    if (!googleEmail) {
      throw new BadRequestException(
        'Hubungkan Google (Calendar + Gmail + Drive) di Pengaturan untuk menyimpan ke Drive',
      );
    }

    const token = await this.getGoogleAccessToken(nik, googleEmail);
    // Ambil nama file + part kanonik dari detail pesan (partId stabil, bukan attachmentId).
    let filename = (file.filename || '').trim();
    let mime = file.contentType || 'application/octet-stream';
    let recordPart = part;
    try {
      const detail = await this.getMessage(nik, messageId);
      const atts = (detail.attachments || []) as Array<{
        part?: string;
        filename?: string;
        contentType?: string;
      }>;
      let att = atts.find((a) => String(a.part) === String(part));
      if (!att && atts.length === 1) att = atts[0];
      if (att?.filename) filename = String(att.filename);
      if (att?.contentType) mime = String(att.contentType);
      recordPart = this.canonicalAttachmentPart(atts, part, filename);
    } catch {
      /* keep defaults */
    }
    filename = this.safeCloudFilename(filename, recordPart, mime);

    const uploaded = await this.gmailDrive.uploadAndShare(token, {
      filename,
      mimeType: mime,
      size: buffer.length,
      buffer,
      shareMode: 'restricted',
    });

    await this.recordSavedAttachment({
      nik,
      mailboxEmail: ctx.email,
      messageId,
      part: recordPart,
      via: 'gdrive',
      url: uploaded.url,
      fileId: uploaded.fileId,
      filename: uploaded.filename,
    });

    return {
      via: 'gdrive' as const,
      fileId: uploaded.fileId,
      url: uploaded.url,
      filename: uploaded.filename,
      size: uploaded.size,
    };
  }

  /**
   * Salin lampiran pesan ke AMS Drive (My Drive user).
   * Storage backend tetap Dropbox org, tapi file masuk kuota + DT_FILE milik NIK.
   */
  async saveAttachmentToAmsDrive(nik: string, messageId: string, part: string) {
    const file = await this.downloadAttachment(nik, messageId, part);
    const buffer = file.buffer;
    if (!buffer?.length) {
      throw new BadRequestException('Lampiran kosong');
    }

    let filename = (file.filename || '').trim();
    let mime = file.contentType || 'application/octet-stream';
    let recordPart = part;
    try {
      const detail = await this.getMessage(nik, messageId);
      const atts = (detail.attachments || []) as Array<{
        part?: string;
        filename?: string;
        contentType?: string;
      }>;
      let att = atts.find((a) => String(a.part) === String(part));
      if (!att && atts.length === 1) att = atts[0];
      if (att?.filename) filename = String(att.filename);
      if (att?.contentType) mime = String(att.contentType);
      recordPart = this.canonicalAttachmentPart(atts, part, filename);
    } catch {
      /* keep defaults */
    }
    filename = this.safeCloudFilename(filename, recordPart, mime);

    const multerFile = {
      fieldname: 'file',
      originalname: filename,
      encoding: '7bit',
      mimetype: mime,
      size: buffer.length,
      buffer,
      destination: '',
      filename: '',
      path: '',
      stream: undefined as any,
    } as Express.Multer.File;

    try {
      const created = await this.amsDrive.uploadFile(nik, multerFile);
      const url = (created.url as string) || '/dashboard/cloud';
      const fileId = created.id as string;
      const outName = (created.name as string) || filename;
      const ctx = await this.resolveMailboxContext(nik);
      await this.recordSavedAttachment({
        nik,
        mailboxEmail: ctx.email,
        messageId,
        part: recordPart,
        via: 'amsdrive',
        url,
        fileId,
        filename: outName,
      });
      return {
        via: 'amsdrive' as const,
        fileId,
        url,
        filename: outName,
        size: buffer.length,
      };
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (
        /Foreign key|P2003|ownerNik|User not found|Record to create/i.test(msg) ||
        err?.code === 'P2003'
      ) {
        throw new BadRequestException(
          'Aktifkan AMS Drive dulu (menu Cloud) sebelum menyimpan lampiran',
        );
      }
      throw err;
    }
  }

  /** @deprecated Gunakan saveAttachmentToAmsDrive — Dropbox org bukan drive personal. */
  async saveAttachmentToDropbox(nik: string, messageId: string, part: string) {
    return this.saveAttachmentToAmsDrive(nik, messageId, part);
  }


  /**
   * Refresh Google access token for mailbox Gmail ops.
   * Mirrors GoogleCalendarService.getValidAccessToken — kept here to avoid
   * circular DI (GoogleCalendarService already imports MailboxService).
   */
  private async getGoogleAccessToken(nik: string, email: string): Promise<string> {
    const row = await this.prisma.dT_GOOGLE_CREDENTIAL.findUnique({
      where: { nik_googleEmail: { nik, googleEmail: email } },
    });
    if (!row || !hasGmailScope(row.scope)) {
      throw new BadRequestException(
        'Akun Gmail tidak ditemukan atau scope hilang — hubungkan ulang di Pengaturan',
      );
    }

    const stillValid =
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt.getTime() > Date.now() + 30_000;
    if (stillValid) {
      return this.crypto.decrypt({
        cipher: row.accessTokenCipher,
        iv: row.accessTokenIv,
        tag: row.accessTokenTag,
      });
    }

    const refreshToken = this.crypto.decrypt({
      cipher: row.refreshTokenCipher,
      iv: row.refreshTokenIv,
      tag: row.refreshTokenTag,
    });
    const tokens = await this.oauth.refreshAccessToken(refreshToken);
    const accessEnc = this.crypto.encrypt(tokens.access_token);
    const expiresAt = new Date(
      Date.now() + Math.max((tokens.expires_in || 3600) - 60, 60) * 1000,
    );
    const refreshEnc = tokens.refresh_token
      ? this.crypto.encrypt(tokens.refresh_token)
      : null;

    await this.prisma.dT_GOOGLE_CREDENTIAL.update({
      where: { id: row.id },
      data: {
        accessTokenCipher: accessEnc.cipher,
        accessTokenIv: accessEnc.iv,
        accessTokenTag: accessEnc.tag,
        accessTokenExpiresAt: expiresAt,
        ...(refreshEnc
          ? {
              refreshTokenCipher: refreshEnc.cipher,
              refreshTokenIv: refreshEnc.iv,
              refreshTokenTag: refreshEnc.tag,
            }
          : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });

    return tokens.access_token;
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
        const url = `/api/mailbox/attachments/${encodeURIComponent(summary.id)}?part=${encodeURIComponent(att.part)}`;
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
          return `/api/mailbox/attachments/${encodeURIComponent(summary.id)}?part=${encodeURIComponent(part)}`;
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
