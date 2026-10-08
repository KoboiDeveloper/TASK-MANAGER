import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Dropbox, DropboxAuth } from 'dropbox';
import { IStorageService } from './storage.interface';

@Injectable()
export class DropboxStorageService implements IStorageService {
  private readonly logger = new Logger(DropboxStorageService.name);
  private readonly dropbox: Dropbox;
  private readonly basePath: string;

  constructor() {
    const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
    const clientId = process.env.DROPBOX_CLIENT_ID;
    const clientSecret = process.env.DROPBOX_CLIENT_SECRET;

    // Fallback ke access token lama (untuk backward compat, tapi akan expired 4 jam)
    const accessToken = process.env.DROPBOX_ACCESS_TOKEN;

    if (!clientId || !clientSecret) {
      throw new Error(
        'DROPBOX_CLIENT_ID dan DROPBOX_CLIENT_SECRET wajib diisi di environment variables',
      );
    }

    if (refreshToken) {
      // ✅ CARA BENAR: Pakai DropboxAuth dengan refresh token (tidak akan expired)
      const auth = new DropboxAuth({
        clientId,
        clientSecret,
        refreshToken,
      });
      this.dropbox = new Dropbox({ auth });
      this.logger.log('DropboxStorageService initialized dengan REFRESH TOKEN (long-lived)');
    } else if (accessToken) {
      // ⚠️ FALLBACK: Access token sementara (expired dalam 4 jam!)
      this.dropbox = new Dropbox({ accessToken });
      this.logger.warn(
        '⚠️  DropboxStorageService menggunakan ACCESS TOKEN sementara (akan expired ~4 jam). Segera set DROPBOX_REFRESH_TOKEN!',
      );
    } else {
      throw new Error(
        'DROPBOX_REFRESH_TOKEN atau DROPBOX_ACCESS_TOKEN harus diset di environment variables',
      );
    }

    this.basePath = process.env.CLOUD_DROPBOX_FOLDER_PATH || process.env.DROPBOX_FOLDER_PATH || '/CLOUD_STORAGE';
    this.logger.log(`DropboxStorageService initialized dengan basePath: ${this.basePath}`);
  }

  async uploadFile(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string; path: string }> {
    const result = await this.uploadFileWithShareOptions(path, buffer, contentType);
    return { url: result.url, path: result.path };
  }

  /**
   * Upload + shared link dengan opsi kadaluarsa / password (untuk lampiran email besar).
   * Link ber-password dikembalikan sebagai URL halaman Dropbox (bukan direct download).
   */
  async uploadFileWithShareOptions(
    path: string,
    buffer: Buffer,
    contentType: string,
    options?: { expiresAt?: Date; password?: string; signal?: AbortSignal },
  ): Promise<{
    url: string;
    path: string;
    expiresAt?: string;
    passwordProtected: boolean;
  }> {
    return this.uploadWithShareOptionsInternal(path, contentType, options, {
      kind: 'buffer',
      buffer,
    });
  }

  /** Upload dari file di disk (chunked) — hindari load 200MB+ penuh ke RAM. */
  async uploadLocalFileWithShareOptions(
    path: string,
    localFilePath: string,
    size: number,
    contentType: string,
    options?: { expiresAt?: Date; password?: string; signal?: AbortSignal },
  ): Promise<{
    url: string;
    path: string;
    expiresAt?: string;
    passwordProtected: boolean;
  }> {
    return this.uploadWithShareOptionsInternal(path, contentType, options, {
      kind: 'file',
      localFilePath,
      size,
    });
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new BadRequestException('Upload dibatalkan');
    }
  }

  private async uploadWithShareOptionsInternal(
    path: string,
    contentType: string,
    options: { expiresAt?: Date; password?: string; signal?: AbortSignal } | undefined,
    source: { kind: 'buffer'; buffer: Buffer } | { kind: 'file'; localFilePath: string; size: number },
  ): Promise<{
    url: string;
    path: string;
    expiresAt?: string;
    passwordProtected: boolean;
  }> {
    let uploadedPath: string | undefined;
    try {
      this.throwIfAborted(options?.signal);
      const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
      const fullPath = `${this.basePath}/${normalizedPath}`;
      const size = source.kind === 'buffer' ? source.buffer.length : source.size;

      this.logger.debug(`Uploading file to Dropbox: ${fullPath}`);
      this.logger.debug(`File size: ${size} bytes, Content-Type: ${contentType}`);

      uploadedPath =
        source.kind === 'buffer'
          ? await this.uploadBuffer(fullPath, source.buffer, options?.signal)
          : await this.uploadLocalFile(fullPath, source.localFilePath, source.size, options?.signal);
      this.logger.debug(`File uploaded to Dropbox at: ${uploadedPath}`);

      this.throwIfAborted(options?.signal);

      const password = options?.password?.trim() || undefined;
      const expiresAt = options?.expiresAt;
      const link = await this.createSharedLinkSafe(uploadedPath, { expiresAt, password });

      this.throwIfAborted(options?.signal);

      const url = link.passwordProtected ? link.url : this.toDirectUrl(link.url);
      this.logger.log(`File uploaded successfully: ${url}`);

      return {
        url,
        path: uploadedPath,
        expiresAt: link.expiresAt,
        passwordProtected: link.passwordProtected,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        // Klien abort setelah file sempat masuk Dropbox → hapus agar tidak menumpuk
        if (error.message === 'Upload dibatalkan' && uploadedPath) {
          try {
            await this.deleteFile(uploadedPath);
            this.logger.warn(`Dropbox file dihapus karena upload dibatalkan: ${uploadedPath}`);
          } catch (delErr: any) {
            this.logger.warn(`Gagal hapus file abort Dropbox: ${delErr?.message || delErr}`);
          }
        }
        throw error;
      }
      const tag =
        error?.error?.error?.['.tag'] ||
        error?.error?.['.tag'] ||
        error?.error?.error?.shared_link_settings_error?.['.tag'];
      if (tag === 'not_authorized' || tag === 'shared_link_settings_error') {
        throw new BadRequestException(
          'Akun Dropbox tidak mengizinkan password/kadaluarsa pada shared link. Coba tanpa password/kadaluarsa.',
        );
      }
      const detail =
        error?.error?.error_summary ||
        error?.error?.error?.['.tag'] ||
        error?.message ||
        'Unknown error';
      this.logger.error(`Failed to upload file: ${path}`, detail);
      this.logger.error(`Error details:`, JSON.stringify(error?.error || error, null, 2));
      throw new BadRequestException(`Gagal upload Dropbox: ${detail}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      // Kalau path adalah URL, extract path-nya
      let dropboxPath = path;
      if (path.startsWith('http')) {
        // Format: https://dl.dropbox.com/scl/fi/xxx/path/file.jpg?rlkey=xxx&raw=1
        const url = new URL(path);
        const pathParts = url.pathname.split('/').slice(4); // Remove /scl/fi/xxx/
        dropboxPath = `/${pathParts.join('/')}`;

        // Atau kalau basePath ada di path
        if (path.includes(this.basePath)) {
          const idx = path.indexOf(this.basePath);
          dropboxPath = path.substring(idx);
          // Hapus query parameters
          dropboxPath = dropboxPath.split('?')[0];
        }
      }

      // Kalau bukan fullPath, tambahkan basePath
      if (!dropboxPath.startsWith(this.basePath)) {
        dropboxPath = `${this.basePath}${dropboxPath.startsWith('/') ? '' : '/'}${dropboxPath}`;
      }

      this.logger.debug(`Deleting file from Dropbox: ${dropboxPath}`);

      await this.dropbox.filesDeleteV2({
        path: dropboxPath,
      });

      this.logger.log(`File deleted successfully: ${dropboxPath}`);
    } catch (error: any) {
      // Ignore jika file tidak ditemukan
      if (
        error?.error?.error?.['.tag'] === 'path_lookup' &&
        error?.error?.error?.path_lookup?.['.tag'] === 'not_found'
      ) {
        this.logger.warn(`File not found for deletion: ${path}`);
        return;
      }

      this.logger.error(`Failed to delete file: ${path}`, error?.message);
      throw new Error(`Failed to delete file: ${error?.message || 'Unknown error'}`);
    }
  }

  async getFileUrl(path: string): Promise<string> {
    try {
      const fullPath = path.startsWith(this.basePath) ? path : `${this.basePath}/${path}`;
      const sharedUrl = await this.getOrCreateSharedLink(fullPath);
      return this.toDirectUrl(sharedUrl);
    } catch (error: any) {
      this.logger.error(`Failed to get file URL: ${path}`, error?.message);
      throw new Error(`Failed to get file URL: ${error?.message || 'Unknown error'}`);
    }
  }

  /** Account-level Dropbox space usage (team/individual). */
  async getSpaceUsage(): Promise<{
    usedBytes: string;
    allocatedBytes: string;
    remainingBytes: string;
  }> {
    const response = await this.dropbox.usersGetSpaceUsage();
    const used = Number(response.result.used || 0);
    const allocation = response.result.allocation as {
      '.tag'?: string;
      allocated?: number;
    };
    const allocated = Number(allocation?.allocated || 0);
    const remaining = Math.max(0, allocated - used);
    return {
      usedBytes: String(used),
      allocatedBytes: String(allocated),
      remainingBytes: String(remaining),
    };
  }

  /** Download file bytes from Dropbox for inline preview (no attachment redirect). */
  async downloadFile(path: string): Promise<Buffer> {
    const fullPath = path.startsWith(this.basePath)
      ? path
      : `${this.basePath}${path.startsWith('/') ? '' : '/'}${path}`;
    const response = await this.dropbox.filesDownload({ path: fullPath });
    const binary = (response.result as { fileBinary?: ArrayBuffer | Buffer | string }).fileBinary;
    if (!binary) {
      throw new Error('Dropbox download returned empty content');
    }
    if (Buffer.isBuffer(binary)) return binary;
    if (typeof binary === 'string') return Buffer.from(binary, 'binary');
    return Buffer.from(binary);
  }

  /**
   * ✅ Helper: Buat shared link baru atau ambil yang sudah ada.
   * Menggunakan API terbaru: sharingCreateSharedLinkWithSettings
   * (sharingCreateSharedLink sudah deprecated)
   */
  private async getOrCreateSharedLink(filePath: string): Promise<string> {
    return this.createSharedLink(filePath);
  }

  /**
   * Dropbox filesUpload max ~150MB — di atas itu pakai upload session (chunked).
   */
  private async uploadBuffer(
    fullPath: string,
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.uploadSession(
      fullPath,
      buffer.length,
      async (offset, len) => buffer.subarray(offset, offset + len),
      signal,
    );
  }

  private async uploadLocalFile(
    fullPath: string,
    localFilePath: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const { open } = await import('fs/promises');
    const fh = await open(localFilePath, 'r');
    try {
      return await this.uploadSession(
        fullPath,
        size,
        async (offset, len) => {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, offset);
          return bytesRead === len ? buf : buf.subarray(0, bytesRead);
        },
        signal,
      );
    } finally {
      await fh.close();
    }
  }

  private async uploadSession(
    fullPath: string,
    size: number,
    readChunk: (offset: number, len: number) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<string> {
    const SINGLE_MAX = 140 * 1024 * 1024;
    const CHUNK = 8 * 1024 * 1024;

    this.throwIfAborted(signal);

    if (size <= SINGLE_MAX) {
      const contents = await readChunk(0, size);
      this.throwIfAborted(signal);
      const uploadResponse = await this.dropbox.filesUpload({
        path: fullPath,
        contents,
        mode: { '.tag': 'add' },
        autorename: true,
        mute: false,
      });
      this.throwIfAborted(signal);
      return uploadResponse.result.path_display || fullPath;
    }

    this.logger.log(
      `Large Dropbox upload (${(size / (1024 * 1024)).toFixed(1)} MB) via session: ${fullPath}`,
    );

    const firstLen = Math.min(CHUNK, size);
    const first = await readChunk(0, firstLen);
    this.throwIfAborted(signal);
    const start = await this.dropbox.filesUploadSessionStart({
      contents: first,
      close: false,
    });
    let offset = first.length;
    const sessionId = start.result.session_id;

    while (offset < size) {
      this.throwIfAborted(signal);
      const toRead = Math.min(CHUNK, size - offset);
      const chunk = await readChunk(offset, toRead);
      const isLast = offset + chunk.length >= size;

      if (isLast) {
        this.throwIfAborted(signal);
        const finished = await this.dropbox.filesUploadSessionFinish({
          cursor: { session_id: sessionId, offset },
          commit: {
            path: fullPath,
            mode: { '.tag': 'add' },
            autorename: true,
            mute: false,
          },
          contents: chunk,
        });
        this.throwIfAborted(signal);
        return finished.result.path_display || fullPath;
      }

      await this.dropbox.filesUploadSessionAppendV2({
        cursor: { session_id: sessionId, offset },
        contents: chunk,
        close: false,
      });
      offset += chunk.length;
    }

    this.throwIfAborted(signal);
    const finished = await this.dropbox.filesUploadSessionFinish({
      cursor: { session_id: sessionId, offset },
      commit: {
        path: fullPath,
        mode: { '.tag': 'add' },
        autorename: true,
        mute: false,
      },
      contents: Buffer.alloc(0),
    });
    this.throwIfAborted(signal);
    return finished.result.path_display || fullPath;
  }

  private async createSharedLinkSafe(
    filePath: string,
    options?: { expiresAt?: Date; password?: string },
  ): Promise<{ url: string; passwordProtected: boolean; expiresAt?: string }> {
    const password = options?.password?.trim() || undefined;
    const expiresAt = options?.expiresAt;

    try {
      const url = await this.createSharedLink(filePath, { expiresAt, password });
      return {
        url,
        passwordProtected: Boolean(password),
        expiresAt: expiresAt?.toISOString(),
      };
    } catch (err: any) {
      const tag =
        err?.error?.error?.['.tag'] ||
        err?.error?.error?.shared_link_settings_error?.['.tag'] ||
        err?.error?.['.tag'];
      this.logger.warn(
        `Shared link with options failed (${tag || err?.message}); retrying public link without password/expiry`,
      );
      // Fallback: tautan publik tanpa password/kadaluarsa (akun Dropbox basic sering menolak settings)
      const url = await this.createSharedLink(filePath);
      return { url, passwordProtected: false, expiresAt: undefined };
    }
  }

  private async createSharedLink(
    filePath: string,
    options?: { expiresAt?: Date; password?: string },
  ): Promise<string> {
    const password = options?.password?.trim() || undefined;
    const expires = options?.expiresAt?.toISOString();

    const settings: {
      require_password?: boolean;
      link_password?: string;
      expires?: string;
      requested_visibility?: { '.tag': 'public' | 'team_only' | 'password' };
      allow_download?: boolean;
    } = {
      allow_download: true,
      requested_visibility: password ? { '.tag': 'password' } : { '.tag': 'public' },
    };

    if (password) {
      settings.require_password = true;
      settings.link_password = password;
    }
    if (expires) settings.expires = expires;

    try {
      const linkResponse = await this.dropbox.sharingCreateSharedLinkWithSettings({
        path: filePath,
        settings,
      });
      this.logger.debug(`Shared link created: ${linkResponse.result.url}`);
      return linkResponse.result.url;
    } catch (linkError: any) {
      if (
        linkError?.error?.error?.['.tag'] === 'shared_link_already_exists' ||
        linkError?.error?.['.tag'] === 'shared_link_already_exists'
      ) {
        this.logger.debug(`Shared link already exists, fetching existing link...`);
        const listResponse = await this.dropbox.sharingListSharedLinks({
          path: filePath,
          direct_only: true,
        });

        if (!listResponse.result.links.length) {
          throw new Error('Failed to get existing shared link');
        }

        const existingUrl = listResponse.result.links[0].url;
        if (password || expires) {
          try {
            const modified = await this.dropbox.sharingModifySharedLinkSettings({
              url: existingUrl,
              settings: {
                require_password: Boolean(password),
                ...(password ? { link_password: password } : {}),
                ...(expires ? { expires } : {}),
                allow_download: true,
              },
              remove_expiration: !expires,
            });
            return modified.result.url;
          } catch (modErr) {
            this.logger.warn(
              `Could not modify existing shared link settings`,
              (modErr as Error)?.message,
            );
          }
        }

        this.logger.debug(`Found existing shared link: ${existingUrl}`);
        return existingUrl;
      }

      this.logger.error(`Failed to create/get shared link:`, linkError);
      throw linkError;
    }
  }

  /**
   * ✅ Convert Dropbox preview URL ke direct download URL dengan cara yang benar.
   * Dari: https://www.dropbox.com/scl/fi/xxx/filename.jpg?rlkey=xxx&dl=0
   * Ke:   https://dl.dropbox.com/scl/fi/xxx/filename.jpg?rlkey=xxx&raw=1
   */
  private toDirectUrl(sharedUrl: string): string {
    try {
      const url = new URL(sharedUrl);
      // Ganti host ke dl.dropbox.com
      url.hostname = 'dl.dropbox.com';
      // Hapus param dl=0 dan tambahkan raw=1
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return url.toString();
    } catch {
      // Fallback ke string replace jika URL parsing gagal
      return sharedUrl
        .replace('www.dropbox.com', 'dl.dropbox.com')
        .replace(/[?&]dl=0/, (match) => (match.startsWith('?') ? '?raw=1' : '&raw=1'));
    }
  }
}
