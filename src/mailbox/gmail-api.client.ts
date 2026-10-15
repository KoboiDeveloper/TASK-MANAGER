import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import type { FolderNode, MessageSummary } from './mailbox.service';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

const SYSTEM_FOLDER_ORDER = [
  'INBOX',
  'STARRED',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
] as const;

const SYSTEM_DISPLAY_NAMES: Record<string, string> = {
  INBOX: 'Inbox',
  STARRED: 'Starred',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  SPAM: 'Spam',
  TRASH: 'Trash',
};

const META_LABELS = new Set([
  'UNREAD',
  'IMPORTANT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);

type GmailLabel = {
  id?: string;
  name?: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
};

type GmailHeader = { name?: string; value?: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
};

export type GmailMessageDetail = MessageSummary & {
  html: string;
  text: string;
  attachments: Array<{
    part: string;
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
  }>;
  messageId: string | null;
  conversationId: string | null;
  inReplyTo: string | null;
};

@Injectable()
export class GmailApiClient {
  private readonly logger = new Logger(GmailApiClient.name);

  async listFolders(accessToken: string): Promise<FolderNode[]> {
    const data = await this.get<{ labels?: GmailLabel[] }>(
      accessToken,
      '/users/me/labels',
    );
    const labels = data.labels || [];
    const byId = new Map(labels.filter((l) => l.id).map((l) => [l.id!, l]));

    const systemFolders: FolderNode[] = [];
    for (const id of SYSTEM_FOLDER_ORDER) {
      const lab = byId.get(id);
      if (!lab) continue;
      systemFolders.push(this.mapLabelToFolder(lab, SYSTEM_DISPLAY_NAMES[id] || lab.name || id));
    }

    const userLabels = labels.filter(
      (l) => l.type === 'user' && l.id && l.name && !META_LABELS.has(l.id),
    );
    const userTree = this.buildUserLabelTree(userLabels);

    return [...systemFolders, ...userTree];
  }

  async listMessages(
    accessToken: string,
    opts: {
      labelIds?: string[];
      q?: string;
      pageToken?: string;
      maxResults?: number;
    } = {},
  ): Promise<{
    messages: MessageSummary[];
    more: boolean;
    nextPageToken?: string;
    offset: number;
  }> {
    const maxResults = Math.min(Math.max(opts.maxResults ?? 50, 1), 100);
    const params: Record<string, string | number | string[]> = { maxResults };
    if (opts.labelIds?.length) params.labelIds = opts.labelIds;
    if (opts.q?.trim()) params.q = opts.q.trim();
    if (opts.pageToken) params.pageToken = opts.pageToken;

    const list = await this.get<{
      messages?: Array<{ id?: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(accessToken, '/users/me/messages', params);

    const ids = (list.messages || []).map((m) => m.id).filter(Boolean) as string[];
    const messages = await this.batchGetMetadata(accessToken, ids);

    return {
      messages,
      more: Boolean(list.nextPageToken),
      nextPageToken: list.nextPageToken,
      offset: 0,
    };
  }

  async getMessage(accessToken: string, id: string): Promise<GmailMessageDetail> {
    let raw: GmailMessage;
    try {
      raw = await this.get<GmailMessage>(
        accessToken,
        `/users/me/messages/${encodeURIComponent(id)}`,
        { format: 'full' },
      );
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw e;
    }
    if (!raw?.id) throw new NotFoundException('Pesan tidak ditemukan');

    const summary = this.mapMessageSummary(raw);
    let { html, text, attachments } = this.extractParts(raw.payload);

    if (html && summary.id) {
      for (const att of attachments) {
        const url = `/api/mailbox/attachments/${encodeURIComponent(summary.id)}/${encodeURIComponent(att.part)}`;
        if (att.contentId) {
          const safeCid = this.escapeRegex(att.contentId);
          html = html.replace(new RegExp(`cid:${safeCid}`, 'gi'), url);
        }
        if (att.filename) {
          const safeFn = this.escapeRegex(att.filename);
          html = html.replace(new RegExp(`cid:${safeFn}`, 'gi'), url);
        }
        const safePart = this.escapeRegex(att.part);
        html = html.replace(new RegExp(`cid:${safePart}`, 'gi'), url);
      }
    }

    const headers = raw.payload?.headers || [];
    return {
      ...summary,
      html,
      text,
      attachments,
      messageId: this.header(headers, 'Message-ID') || this.header(headers, 'Message-Id') || null,
      conversationId: raw.threadId || null,
      inReplyTo: this.header(headers, 'In-Reply-To') || null,
    };
  }

  private async batchGetMetadata(
    accessToken: string,
    ids: string[],
  ): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    const chunkSize = 10;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const rows = await Promise.all(
        chunk.map((id) =>
          this.get<GmailMessage>(
            accessToken,
            `/users/me/messages/${encodeURIComponent(id)}`,
            {
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'],
            },
          ).catch((e) => {
            this.logger.warn(`metadata get ${id} failed: ${(e as Error).message}`);
            return null;
          }),
        ),
      );
      for (const row of rows) {
        if (row?.id) out.push(this.mapMessageSummary(row));
      }
    }
    return out;
  }

  private mapLabelToFolder(lab: GmailLabel, displayName?: string): FolderNode {
    const id = String(lab.id || '');
    const name = displayName || String(lab.name || id);
    const pathName = lab.name || name;
    return {
      id,
      name,
      path: pathName.startsWith('/') ? pathName : `/${pathName}`,
      u: Number(lab.messagesUnread ?? 0),
      n: Number(lab.messagesTotal ?? 0),
      view: 'message',
      color: null,
      rgb: null,
      children: [],
    };
  }

  private buildUserLabelTree(labels: GmailLabel[]): FolderNode[] {
    type Mutable = FolderNode;
    const byFullName = new Map<string, Mutable>();
    const roots: Mutable[] = [];

    const sorted = [...labels].sort((a, b) => {
      const da = String(a.name || '').split('/').length;
      const db = String(b.name || '').split('/').length;
      return da - db || String(a.name).localeCompare(String(b.name));
    });

    for (const lab of sorted) {
      const fullName = String(lab.name || '');
      const parts = fullName.split('/');
      const node = this.mapLabelToFolder(lab, parts[parts.length - 1]);
      byFullName.set(fullName, node);

      if (parts.length === 1) {
        roots.push(node);
        continue;
      }
      const parentName = parts.slice(0, -1).join('/');
      const parent = byFullName.get(parentName);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private mapMessageSummary(raw: GmailMessage): MessageSummary {
    const headers = raw.payload?.headers || [];
    const labelIds = raw.labelIds || [];
    const isUnread = labelIds.includes('UNREAD');
    const isFlagged = labelIds.includes('STARRED');
    const hasAttachment = this.payloadHasAttachment(raw.payload);
    const flags = `${isUnread ? 'u' : ''}${isFlagged ? 'f' : ''}${hasAttachment ? 'a' : ''}`;

    const folderId =
      labelIds.find(
        (l) =>
          !META_LABELS.has(l) &&
          l !== 'UNREAD' &&
          l !== 'STARRED' &&
          (SYSTEM_FOLDER_ORDER as readonly string[]).includes(l),
      ) ||
      labelIds.find((l) => !META_LABELS.has(l) && l !== 'UNREAD' && l !== 'STARRED') ||
      undefined;

    const tags = labelIds.filter(
      (l) =>
        l.startsWith('Label_') ||
        (!META_LABELS.has(l) &&
          !(SYSTEM_FOLDER_ORDER as readonly string[]).includes(l) &&
          l !== 'UNREAD' &&
          l !== 'STARRED'),
    );

    const dateHeader = this.header(headers, 'Date');
    let date = Number(raw.internalDate || 0);
    if (!date && dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (Number.isFinite(parsed)) date = parsed;
    }

    return {
      id: String(raw.id || ''),
      subject: this.header(headers, 'Subject') || '(tanpa subjek)',
      from: this.header(headers, 'From') || '',
      to: this.header(headers, 'To') || '',
      cc: this.header(headers, 'Cc') || '',
      bcc: this.header(headers, 'Bcc') || '',
      date,
      fragment: String(raw.snippet || ''),
      size: Number(raw.sizeEstimate || 0),
      flags,
      isUnread,
      isFlagged,
      hasAttachment,
      folderId,
      tags,
    };
  }

  private extractParts(payload: GmailPart | undefined): {
    html: string;
    text: string;
    attachments: GmailMessageDetail['attachments'];
  } {
    let html = '';
    let text = '';
    const attachments: GmailMessageDetail['attachments'] = [];

    const walk = (part: GmailPart | undefined) => {
      if (!part) return;
      const ct = String(part.mimeType || '').toLowerCase();
      const filename = String(part.filename || '');
      const headers = part.headers || [];
      const contentIdRaw =
        this.header(headers, 'Content-ID') || this.header(headers, 'Content-Id');
      const contentId = contentIdRaw
        ? contentIdRaw.replace(/^<|>$/g, '').trim()
        : undefined;
      const disposition = (
        this.header(headers, 'Content-Disposition') || ''
      ).toLowerCase();

      if (ct.includes('text/html') && part.body?.data && !filename) {
        html = this.decodeBody(part.body.data);
      } else if (ct.includes('text/plain') && part.body?.data && !filename && !text) {
        text = this.decodeBody(part.body.data);
      }

      const isImage = ct.startsWith('image/');
      const isAttachment =
        Boolean(filename) ||
        disposition.includes('attachment') ||
        (disposition.includes('inline') && Boolean(contentId)) ||
        Boolean(part.body?.attachmentId) ||
        (isImage && Boolean(part.body?.attachmentId || contentId));

      if (
        isAttachment &&
        !ct.includes('text/html') &&
        !ct.includes('text/plain') &&
        (part.body?.attachmentId || filename || contentId)
      ) {
        const partKey =
          part.body?.attachmentId || part.partId || filename || contentId || 'att';
        attachments.push({
          part: String(partKey),
          filename:
            filename ||
            (contentId
              ? contentId
              : `image-${part.partId || 'att'}.${ct.split('/')[1] || 'bin'}`),
          contentType: part.mimeType || 'application/octet-stream',
          size: Number(part.body?.size || 0),
          contentId,
        });
      }

      for (const child of part.parts || []) walk(child);
    };

    walk(payload);
    return { html, text, attachments };
  }

  private payloadHasAttachment(payload: GmailPart | undefined): boolean {
    if (!payload) return false;
    let found = false;
    const walk = (part: GmailPart) => {
      if (found) return;
      if (part.filename) {
        found = true;
        return;
      }
      if (part.body?.attachmentId && part.mimeType && !part.mimeType.startsWith('text/')) {
        found = true;
        return;
      }
      for (const child of part.parts || []) walk(child);
    };
    walk(payload);
    return found;
  }

  private decodeBody(data: string): string {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  private header(headers: GmailHeader[], name: string): string {
    const want = name.toLowerCase();
    const h = headers.find((x) => String(x.name || '').toLowerCase() === want);
    return (h?.value || '').trim();
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async get<T>(
    accessToken: string,
    path: string,
    params?: Record<string, string | number | string[]>,
  ): Promise<T> {
    try {
      const { data } = await axios.get<T>(`${GMAIL_API}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params,
        paramsSerializer: {
          serialize: (p) => {
            const sp = new URLSearchParams();
            for (const [k, v] of Object.entries(p)) {
              if (v === undefined || v === null) continue;
              if (Array.isArray(v)) {
                for (const item of v) sp.append(k, String(item));
              } else {
                sp.append(k, String(v));
              }
            }
            return sp.toString();
          },
        },
        timeout: 30_000,
      });
      return data;
    } catch (e) {
      throw this.wrapError(e, path);
    }
  }

  private wrapError(e: unknown, path: string): Error {
    const ax = e as AxiosError<{ error?: { message?: string; code?: number } }>;
    const status = ax.response?.status;
    const msg =
      ax.response?.data?.error?.message ||
      ax.message ||
      'Gmail API request failed';
    this.logger.warn(`Gmail ${path} failed (${status ?? '?'}): ${msg}`);
    if (status === 404) return new NotFoundException('Pesan tidak ditemukan');
    if (status === 401 || status === 403) {
      return new BadRequestException('Sesi Gmail kedaluwarsa atau tanpa izin — hubungkan ulang');
    }
    return new BadRequestException(`Gmail API error: ${msg}`);
  }
}
