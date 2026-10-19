import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { createReadStream } from 'fs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export type DriveShareMode = 'anyone' | 'restricted';

export type DriveUploadResult = {
  fileId: string;
  url: string;
  filename: string;
  size: number;
  shareMode: DriveShareMode;
};

@Injectable()
export class GmailDriveClient {
  private readonly logger = new Logger(GmailDriveClient.name);

  async uploadAndShare(
    accessToken: string,
    input: {
      filename: string;
      mimeType: string;
      size: number;
      path?: string;
      buffer?: Buffer;
      shareMode: DriveShareMode;
      signal?: AbortSignal;
    },
  ): Promise<DriveUploadResult> {
    const mime = input.mimeType || 'application/octet-stream';
    const meta = { name: input.filename, mimeType: mime };

    const init = await axios.post(DRIVE_UPLOAD, meta, {
      params: { uploadType: 'resumable', fields: 'id,name,webViewLink,size' },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(input.size),
      },
      timeout: 60_000,
      signal: input.signal,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const uploadUrl = String(init.headers.location || init.headers.Location || '');
    if (!uploadUrl) {
      throw new BadRequestException('Google Drive tidak mengembalikan upload URL');
    }

    let body: NodeJS.ReadableStream | Buffer;
    if (input.path) {
      body = createReadStream(input.path);
    } else if (input.buffer?.length) {
      body = input.buffer;
    } else {
      throw new BadRequestException('File Drive kosong');
    }

    let uploaded: { id?: string; name?: string; webViewLink?: string; size?: string };
    try {
      const res = await axios.put(uploadUrl, body, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(input.size),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30 * 60_000,
        signal: input.signal,
      });
      uploaded = res.data || {};
    } catch (e) {
      this.rethrowDrive(e, 'Upload Drive gagal');
    }

    const fileId = String(uploaded!.id || '');
    if (!fileId) {
      throw new BadRequestException('Upload Drive gagal: file id kosong');
    }

    if (input.shareMode === 'anyone') {
      try {
        await axios.post(
          `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`,
          { role: 'reader', type: 'anyone' },
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { supportsAllDrives: true },
            timeout: 30_000,
            signal: input.signal,
          },
        );
      } catch (e) {
        this.rethrowDrive(e, 'Gagal set permission Anyone with link');
      }
    }

    // Refresh link after permission change
    let url = String(uploaded!.webViewLink || '');
    if (!url) {
      try {
        const metaRes = await axios.get(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'webViewLink,webContentLink' },
          timeout: 20_000,
        });
        url = String(metaRes.data?.webViewLink || metaRes.data?.webContentLink || '');
      } catch {
        /* best-effort */
      }
    }
    if (!url) {
      url = `https://drive.google.com/file/d/${fileId}/view`;
    }

    return {
      fileId,
      url,
      filename: input.filename,
      size: input.size,
      shareMode: input.shareMode,
    };
  }

  /**
   * List Drive folder / views. Needs drive.readonly (or full drive) for complete My Drive.
   * With drive.file alone, only app-opened/created files appear.
   */
  async listFiles(
    accessToken: string,
    input: {
      mode?: 'my' | 'shared' | 'recent' | 'starred' | 'trash';
      folderId?: string | null;
      pageSize?: number;
    } = {},
  ): Promise<
    {
      id: string;
      name: string;
      mimeType: string;
      size: number;
      starred: boolean;
      trashed: boolean;
      modifiedTime?: string;
      createdTime?: string;
      webViewLink?: string;
      parents?: string[];
    }[]
  > {
    const mode = input.mode || 'my';
    const pageSize = Math.min(Math.max(input.pageSize || 100, 1), 200);
    const parts: string[] = [];
    if (mode === 'trash') {
      parts.push('trashed=true');
    } else if (mode === 'shared') {
      parts.push('sharedWithMe=true', 'trashed=false');
    } else if (mode === 'starred') {
      parts.push('starred=true', 'trashed=false');
    } else if (mode === 'recent') {
      parts.push('trashed=false');
    } else {
      const parent = input.folderId?.trim() || 'root';
      parts.push(`'${parent.replace(/'/g, "\\'")}' in parents`, 'trashed=false');
    }
    const params: Record<string, string | number | boolean> = {
      q: parts.join(' and '),
      pageSize,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields:
        'files(id,name,mimeType,size,starred,trashed,modifiedTime,createdTime,webViewLink,parents)',
    };
    if (mode === 'recent') {
      params.orderBy = 'viewedByMeTime desc';
    } else {
      params.orderBy = 'folder,name_natural';
    }
    try {
      const res = await axios.get(`${DRIVE_API}/files`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params,
        timeout: 60_000,
      });
      const files = Array.isArray(res.data?.files) ? res.data.files : [];
      return files.map((d: Record<string, unknown>) => ({
        id: String(d.id || ''),
        name: String(d.name || 'file'),
        mimeType: String(d.mimeType || 'application/octet-stream'),
        size: Number(d.size || 0),
        starred: !!d.starred,
        trashed: !!d.trashed,
        modifiedTime: d.modifiedTime ? String(d.modifiedTime) : undefined,
        createdTime: d.createdTime ? String(d.createdTime) : undefined,
        webViewLink: d.webViewLink ? String(d.webViewLink) : undefined,
        parents: Array.isArray(d.parents)
          ? d.parents.map((p) => String(p))
          : undefined,
      }));
    } catch (e) {
      this.rethrowDrive(e, 'Gagal memuat daftar Google Drive');
    }
  }

  async getFileMeta(
    accessToken: string,
    fileId: string,
  ): Promise<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    webViewLink?: string;
  }> {
    try {
      const res = await axios.get(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            fields: 'id,name,mimeType,size,webViewLink',
            supportsAllDrives: true,
          },
          timeout: 60_000,
        },
      );
      const d = res.data || {};
      return {
        id: String(d.id || fileId),
        name: String(d.name || 'file'),
        mimeType: String(d.mimeType || 'application/octet-stream'),
        size: Number(d.size || 0),
        webViewLink: d.webViewLink ? String(d.webViewLink) : undefined,
      };
    } catch (e) {
      this.rethrowDrive(e, 'Gagal membaca metadata Drive');
    }
  }

  async downloadFile(accessToken: string, fileId: string): Promise<Buffer> {
    try {
      const res = await axios.get(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { alt: 'media', supportsAllDrives: true },
          responseType: 'arraybuffer',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 30 * 60_000,
        },
      );
      return Buffer.from(res.data);
    } catch (e) {
      this.rethrowDrive(e, 'Download Drive gagal');
    }
  }

  /**
   * Export Google Workspace files (Docs/Sheets/Slides/…) to a downloadable MIME.
   * @see https://developers.google.com/drive/api/guides/manage-downloads#export
   */
  async exportFile(
    accessToken: string,
    fileId: string,
    exportMimeType: string,
  ): Promise<Buffer> {
    try {
      const res = await axios.get(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { mimeType: exportMimeType },
          responseType: 'arraybuffer',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 5 * 60_000,
        },
      );
      const buf = Buffer.from(res.data);
      if (!buf.length) {
        throw new BadRequestException('Export Drive kosong');
      }
      return buf;
    } catch (e) {
      this.rethrowDrive(e, 'Export Google Docs gagal');
    }
  }

  /** Ensure anyone-with-link reader; return webViewLink (fallback constructed URL). */
  async ensureAnyoneReader(
    accessToken: string,
    fileId: string,
  ): Promise<string> {
    try {
      await axios.post(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`,
        { role: 'reader', type: 'anyone' },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { supportsAllDrives: true },
          timeout: 60_000,
        },
      );
    } catch (e) {
      const ax = e as AxiosError<{ error?: { message?: string } }>;
      const msg = ax.response?.data?.error?.message || (e as Error).message;
      if (!/already|duplicate/i.test(msg)) {
        this.rethrowDrive(e, 'Gagal set permission Anyone with link');
      }
    }

    let url = '';
    try {
      const metaRes = await axios.get(
        `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            fields: 'webViewLink,webContentLink',
            supportsAllDrives: true,
          },
          timeout: 60_000,
        },
      );
      url = String(
        metaRes.data?.webViewLink || metaRes.data?.webContentLink || '',
      );
    } catch {
      /* best-effort */
    }
    if (!url) {
      url = `https://drive.google.com/file/d/${fileId}/view`;
    }
    return url;
  }

  async grantReaders(
    accessToken: string,
    fileId: string,
    emails: string[],
  ): Promise<void> {
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    for (const email of unique) {
      try {
        await axios.post(
          `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`,
          {
            role: 'reader',
            type: 'user',
            emailAddress: email,
          },
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { sendNotificationEmail: false, supportsAllDrives: true },
            timeout: 20_000,
          },
        );
      } catch (e) {
        const ax = e as AxiosError<{ error?: { message?: string } }>;
        const msg = ax.response?.data?.error?.message || (e as Error).message;
        // Already has access — ignore
        if (/already|duplicate/i.test(msg)) continue;
        this.logger.warn(`grantReaders ${fileId} → ${email}: ${msg}`);
      }
    }
  }

  private rethrowDrive(e: unknown, fallback: string): never {
    const ax = e as AxiosError<{ error?: { message?: string } }>;
    const code = ax.code || '';
    const raw = ax.response?.data?.error?.message || (e as Error).message || fallback;
    if (
      code === 'ECONNABORTED' ||
      /timeout of \d+ms exceeded/i.test(String(raw))
    ) {
      throw new BadRequestException(
        'Google Drive lambat merespons. Coba lagi sebentar.',
      );
    }
    throw new BadRequestException(raw);
  }
}
