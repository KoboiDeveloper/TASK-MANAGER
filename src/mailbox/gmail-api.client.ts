import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import type { MessageActionDto, SendMessageDto } from './dto/mailbox.dto';
import type { FolderNode, MessageSummary } from './mailbox.service';

export type GmailAttachmentInput = {
  filename: string;
  contentType: string;
  contentBase64: string;
};

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

/** Nested under Inbox (Gmail tabs). FE localizes display names by id. */
const GMAIL_CATEGORY_ORDER = [
  'CATEGORY_PERSONAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
] as const;

const CATEGORY_DISPLAY_NAMES: Record<(typeof GMAIL_CATEGORY_ORDER)[number], string> = {
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Updates',
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

/** System folder labels removed on move (keep UNREAD / STARRED / IMPORTANT). */
const MOVE_REMOVE_LABELS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH'] as const;

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
      const folder = this.mapLabelToFolder(
        lab,
        SYSTEM_DISPLAY_NAMES[id] || lab.name || id,
      );
      if (id === 'INBOX') {
        folder.children = GMAIL_CATEGORY_ORDER.flatMap((cid) => {
          const cat = byId.get(cid);
          if (!cat) return [];
          return [this.mapLabelToFolder(cat, CATEGORY_DISPLAY_NAMES[cid])];
        });
      }
      systemFolders.push(folder);
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
        const url = `/api/mailbox/attachments/${encodeURIComponent(summary.id)}?part=${encodeURIComponent(att.part)}`;
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

  /**
   * Send via Gmail. Pass resolved attachment bytes as `attachments`
   * (`GmailAttachmentInput[]`). `dto.attachmentAids` / `attachmentParts` are
   * ignored here by design — Task 5 router must resolve them to bytes first.
   */
  async sendMessage(
    accessToken: string,
    dto: SendMessageDto,
    attachments?: GmailAttachmentInput[],
  ): Promise<{ ok: true; id?: string }> {
    if (!(dto.to || '').trim()) {
      throw new BadRequestException('Tambahkan minimal satu penerima');
    }
    const raw = this.encodeRawMime(this.buildRfc822Mime(dto, attachments));
    const res = await this.post<{ id?: string }>(accessToken, '/users/me/messages/send', {
      raw,
    });
    return { ok: true, id: res.id };
  }

  /**
   * Save/update a Gmail draft. Returns the draft **message** id (`draft.message.id`)
   * for FE/Zimbra `draftId` parity — not the Gmail draft resource id.
   *
   * Pass resolved attachment bytes as `attachments` (`GmailAttachmentInput[]`).
   * `dto.attachmentAids` / `attachmentParts` are ignored here by design — Task 5
   * router must resolve them to bytes first.
   */
  async saveDraft(
    accessToken: string,
    dto: SendMessageDto,
    attachments?: GmailAttachmentInput[],
  ): Promise<{ ok: true; id: string | null }> {
    const raw = this.encodeRawMime(this.buildRfc822Mime(dto, attachments));
    if (dto.draftId) {
      const gmailDraftId = await this.resolveGmailDraftResourceId(
        accessToken,
        dto.draftId,
      );
      if (gmailDraftId) {
        try {
          const res = await this.put<{ id?: string; message?: { id?: string } }>(
            accessToken,
            `/users/me/drafts/${encodeURIComponent(gmailDraftId)}`,
            { id: gmailDraftId, message: { raw } },
          );
          return { ok: true, id: res.message?.id || null };
        } catch (e) {
          this.logger.warn(
            `draft update failed for ${gmailDraftId}, creating new: ${(e as Error).message}`,
          );
        }
      }
    }
    const res = await this.post<{ id?: string; message?: { id?: string } }>(
      accessToken,
      '/users/me/drafts',
      { message: { raw } },
    );
    return { ok: true, id: res.message?.id || null };
  }

  async messageAction(
    accessToken: string,
    id: string,
    dto: MessageActionDto,
  ): Promise<{ ok: true }> {
    const op = String(dto.op || '').toLowerCase();
    const encId = encodeURIComponent(id);

    switch (op) {
      case 'read':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          removeLabelIds: ['UNREAD'],
        });
        break;
      case 'unread':
      case '!read':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          addLabelIds: ['UNREAD'],
        });
        break;
      case 'flag':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          addLabelIds: ['STARRED'],
        });
        break;
      case 'unflag':
      case '!flag':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          removeLabelIds: ['STARRED'],
        });
        break;
      case 'trash':
        await this.post(accessToken, `/users/me/messages/${encId}/trash`, {});
        break;
      case 'delete':
        await this.delete(accessToken, `/users/me/messages/${encId}`);
        break;
      case 'spam':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          addLabelIds: ['SPAM'],
          removeLabelIds: ['INBOX'],
        });
        break;
      case 'unspam':
      case '!spam':
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          removeLabelIds: ['SPAM'],
          addLabelIds: ['INBOX'],
        });
        break;
      case 'move': {
        if (!dto.folderId) {
          throw new BadRequestException('folderId wajib untuk operasi move');
        }
        const removeLabelIds = MOVE_REMOVE_LABELS.filter((l) => l !== dto.folderId);
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          addLabelIds: [dto.folderId],
          removeLabelIds,
        });
        break;
      }
      case 'tag': {
        if (!dto.tagName?.trim()) {
          throw new BadRequestException('tagName wajib untuk operasi tag');
        }
        const labelId = await this.resolveUserLabelId(accessToken, dto.tagName.trim(), true);
        await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
          addLabelIds: [labelId],
        });
        break;
      }
      case 'untag':
      case '!tag': {
        if (!dto.tagName?.trim()) {
          throw new BadRequestException('tagName wajib untuk operasi untag');
        }
        const labelId = await this.resolveUserLabelId(accessToken, dto.tagName.trim(), false);
        if (labelId) {
          await this.post(accessToken, `/users/me/messages/${encId}/modify`, {
            removeLabelIds: [labelId],
          });
        }
        break;
      }
      default:
        throw new BadRequestException(`Operasi tidak dikenal: ${dto.op}`);
    }
    return { ok: true };
  }

  /**
   * Resolve MIME partId (`1.2`) → Gmail attachmentId. Bila input sudah attachmentId, pakai apa adanya.
   */
  async resolveAttachmentId(
    accessToken: string,
    messageId: string,
    partOrAttachmentId: string,
  ): Promise<string> {
    const raw = String(partOrAttachmentId || '').trim();
    if (!raw) throw new BadRequestException('Lampiran tidak valid');
    // partId Gmail: "1", "1.2", "2.1.3" — selain itu anggap attachmentId
    if (!/^\d+(\.\d+)*$/.test(raw)) return raw;

    const msg = await this.get<GmailMessage>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}`,
      { format: 'full' },
    );
    let found: string | null = null;
    const walk = (part: GmailPart | undefined) => {
      if (!part || found) return;
      if (String(part.partId || '') === raw && part.body?.attachmentId) {
        found = String(part.body.attachmentId);
        return;
      }
      for (const child of part.parts || []) walk(child);
    };
    walk(msg.payload);
    if (!found) {
      throw new NotFoundException('Lampiran tidak ditemukan di pesan');
    }
    return found;
  }

  async downloadAttachment(
    accessToken: string,
    messageId: string,
    partOrAttachmentId: string,
  ): Promise<{ data: Buffer; size: number }> {
    const attachmentId = await this.resolveAttachmentId(
      accessToken,
      messageId,
      partOrAttachmentId,
    );
    const res = await this.get<{ data?: string; size?: number }>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const data = this.decodeBodyToBuffer(res.data || '');
    return { data, size: Number(res.size ?? data.length) };
  }

  async listTags(
    accessToken: string,
  ): Promise<Array<{ id: string; name: string; color: null }>> {
    const data = await this.get<{ labels?: GmailLabel[] }>(
      accessToken,
      '/users/me/labels',
    );
    return (data.labels || [])
      .filter((l) => l.type === 'user' && l.id && l.name)
      .map((l) => ({ id: String(l.id), name: String(l.name), color: null }));
  }

  async listSignatures(
    accessToken: string,
  ): Promise<{
    signatures: Array<{ id: string; name: string; html: string }>;
    defaultId: string | null;
  }> {
    try {
      const data = await this.get<{
        sendAs?: Array<{
          sendAsEmail?: string;
          displayName?: string;
          signature?: string;
          isDefault?: boolean;
          isPrimary?: boolean;
        }>;
      }>(accessToken, '/users/me/settings/sendAs');
      const rows = data.sendAs || [];
      const signatures = rows.map((s) => ({
        id: String(s.sendAsEmail || ''),
        name: String(s.displayName || s.sendAsEmail || ''),
        html: String(s.signature || ''),
      }));
      const def =
        rows.find((s) => s.isDefault) ||
        rows.find((s) => s.isPrimary) ||
        null;
      return {
        signatures,
        defaultId: def?.sendAsEmail ? String(def.sendAsEmail) : null,
      };
    } catch (e) {
      this.logger.warn(
        `listSignatures failed (best-effort): ${(e as Error).message}`,
      );
      return { signatures: [], defaultId: null };
    }
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
        // Prefer partId (pendek & stabil). attachmentId Gmail bisa >400 char dan
        // berubah antar fetch — jelek untuk URL path + status "saved to Drive".
        const partKey =
          part.partId || part.body?.attachmentId || filename || contentId || 'att';
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
    return this.decodeBodyToBuffer(data).toString('utf8');
  }

  private decodeBodyToBuffer(data: string): Buffer {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
  }

  private encodeRawMime(mime: string): string {
    return Buffer.from(mime, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private buildRfc822Mime(
    dto: SendMessageDto,
    attachments?: GmailAttachmentInput[],
  ): string {
    const to = (dto.to || '').trim();
    const cc = (dto.cc || '').trim();
    const bcc = (dto.bcc || '').trim();
    const subject = dto.subject || '';
    const html = dto.bodyHtml || '';
    const text =
      (dto.bodyText || '').trim() ||
      html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const inReplyTo = (dto.inReplyTo || '').trim();
    const atts = attachments || [];

    const headers: string[] = [];
    if (to) headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(`Subject: ${this.encodeHeaderValue(subject)}`);
    headers.push('MIME-Version: 1.0');
    if (inReplyTo) {
      headers.push(`In-Reply-To: ${inReplyTo}`);
      headers.push(`References: ${inReplyTo}`);
    }

    const altBoundary = `alt_${Date.now().toString(36)}`;
    const mixedBoundary = `mix_${Date.now().toString(36)}`;

    // UTF-8 bodies must not use 7bit CTE — encode as base64.
    const textB64 = Buffer.from(text || '', 'utf8').toString('base64');
    const htmlB64 = Buffer.from(html || '', 'utf8').toString('base64');

    const altBody = [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      this.wrapBase64(textB64),
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      this.wrapBase64(htmlB64),
      `--${altBoundary}--`,
    ].join('\r\n');

    if (!atts.length) {
      headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      return `${headers.join('\r\n')}\r\n\r\n${altBody}\r\n`;
    }

    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    const parts: string[] = [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      altBody,
    ];
    for (const att of atts) {
      const filename = att.filename || 'attachment';
      const ct = att.contentType || 'application/octet-stream';
      const b64 = (att.contentBase64 || '').replace(/\s+/g, '');
      parts.push(
        `--${mixedBoundary}`,
        `Content-Type: ${ct}; name="${filename.replace(/"/g, '')}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename.replace(/"/g, '')}"`,
        '',
        this.wrapBase64(b64),
      );
    }
    parts.push(`--${mixedBoundary}--`);
    return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
  }

  private wrapBase64(b64: string): string {
    const lines: string[] = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    return lines.join('\r\n');
  }

  private encodeHeaderValue(value: string): string {
    if (/^[\x20-\x7E]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
  }

  /**
   * Map FE `draftId` (often a message id for Zimbra parity) to Gmail draft
   * resource id used by PUT `/users/me/drafts/{id}`.
   */
  private async resolveGmailDraftResourceId(
    accessToken: string,
    draftOrMessageId: string,
  ): Promise<string | null> {
    const list = await this.get<{
      drafts?: Array<{ id?: string; message?: { id?: string } }>;
    }>(accessToken, '/users/me/drafts', { maxResults: 100 });
    const drafts = list.drafts || [];
    const byDraftId = drafts.find((d) => d.id === draftOrMessageId);
    if (byDraftId?.id) return byDraftId.id;
    const byMessageId = drafts.find((d) => d.message?.id === draftOrMessageId);
    if (byMessageId?.id) return byMessageId.id;
    return null;
  }

  private async resolveUserLabelId(
    accessToken: string,
    name: string,
    createIfMissing: true,
  ): Promise<string>;
  private async resolveUserLabelId(
    accessToken: string,
    name: string,
    createIfMissing: false,
  ): Promise<string | null>;
  private async resolveUserLabelId(
    accessToken: string,
    name: string,
    createIfMissing: boolean,
  ): Promise<string | null> {
    const data = await this.get<{ labels?: GmailLabel[] }>(
      accessToken,
      '/users/me/labels',
    );
    const found = (data.labels || []).find(
      (l) => l.type === 'user' && l.name === name && l.id,
    );
    if (found?.id) return found.id;
    if (!createIfMissing) return null;
    const created = await this.post<{ id?: string }>(accessToken, '/users/me/labels', {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    if (!created.id) throw new BadRequestException('Gagal membuat label Gmail');
    return created.id;
  }

  private header(headers: GmailHeader[], name: string): string {
    const want = name.toLowerCase();
    const h = headers.find((x) => String(x.name || '').toLowerCase() === want);
    return (h?.value || '').trim();
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private authHeaders(accessToken: string) {
    return { Authorization: `Bearer ${accessToken}` };
  }

  private async get<T>(
    accessToken: string,
    path: string,
    params?: Record<string, string | number | string[]>,
  ): Promise<T> {
    try {
      const { data } = await axios.get<T>(`${GMAIL_API}${path}`, {
        headers: this.authHeaders(accessToken),
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

  private async post<T>(
    accessToken: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const { data } = await axios.post<T>(`${GMAIL_API}${path}`, body ?? {}, {
        headers: {
          ...this.authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      });
      return data;
    } catch (e) {
      throw this.wrapError(e, path);
    }
  }

  private async put<T>(
    accessToken: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const { data } = await axios.put<T>(`${GMAIL_API}${path}`, body ?? {}, {
        headers: {
          ...this.authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      });
      return data;
    } catch (e) {
      throw this.wrapError(e, path);
    }
  }

  private async patch<T>(
    accessToken: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const { data } = await axios.patch<T>(`${GMAIL_API}${path}`, body ?? {}, {
        headers: {
          ...this.authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      });
      return data;
    } catch (e) {
      throw this.wrapError(e, path);
    }
  }

  private async delete<T = unknown>(
    accessToken: string,
    path: string,
  ): Promise<T> {
    try {
      const { data } = await axios.delete<T>(`${GMAIL_API}${path}`, {
        headers: this.authHeaders(accessToken),
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
