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
    const msg = ax.response?.data?.error?.message || (e as Error).message || fallback;
    throw new BadRequestException(msg);
  }
}
