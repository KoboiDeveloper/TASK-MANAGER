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
      throw new Error('DROPBOX_CLIENT_ID dan DROPBOX_CLIENT_SECRET wajib diisi di environment variables');
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
      this.logger.warn('⚠️  DropboxStorageService menggunakan ACCESS TOKEN sementara (akan expired ~4 jam). Segera set DROPBOX_REFRESH_TOKEN!');
    } else {
      throw new Error('DROPBOX_REFRESH_TOKEN atau DROPBOX_ACCESS_TOKEN harus diset di environment variables');
    }

    this.basePath = process.env.DROPBOX_FOLDER_PATH || '/task-manager-files';
    this.logger.log(`DropboxStorageService initialized dengan basePath: ${this.basePath}`);
  }

  async uploadFile(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string; path: string }> {
    try {
      // Normalize path - ensure no leading slash issues
      const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
      const fullPath = `${this.basePath}/${normalizedPath}`;

      this.logger.debug(`Uploading file to Dropbox: ${fullPath}`);
      this.logger.debug(`File size: ${buffer.length} bytes, Content-Type: ${contentType}`);

      // Upload file ke Dropbox
      const uploadResponse = await this.dropbox.filesUpload({
        path: fullPath,
        contents: buffer,
        mode: { '.tag': 'add' },
        autorename: true,
        mute: false,
      });

      const uploadedPath = uploadResponse.result.path_display || fullPath;
      this.logger.debug(`File uploaded to Dropbox at: ${uploadedPath}`);

      // Buat atau ambil shared link
      const sharedUrl = await this.getOrCreateSharedLink(uploadedPath);

      // Convert Dropbox preview URL ke direct download URL
      const directUrl = this.toDirectUrl(sharedUrl);
      this.logger.log(`File uploaded successfully: ${directUrl}`);

      return {
        url: directUrl,
        path: uploadedPath,
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload file: ${path}`, error?.message);
      this.logger.error(`Error details:`, JSON.stringify(error?.error || error, null, 2));
      throw new BadRequestException(`Failed to upload file: ${error?.message || 'Unknown error'}`);
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
      if (error?.error?.error?.['.tag'] === 'path_lookup' &&
          error?.error?.error?.path_lookup?.['.tag'] === 'not_found') {
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

  /**
   * ✅ Helper: Buat shared link baru atau ambil yang sudah ada.
   * Menggunakan API terbaru: sharingCreateSharedLinkWithSettings
   * (sharingCreateSharedLink sudah deprecated)
   */
  private async getOrCreateSharedLink(filePath: string): Promise<string> {
    try {
      // ✅ Pakai API terbaru (bukan yang deprecated)
      const linkResponse = await this.dropbox.sharingCreateSharedLinkWithSettings({
        path: filePath,
        settings: {
          requested_visibility: { '.tag': 'public' },
        },
      });
      this.logger.debug(`Shared link created: ${linkResponse.result.url}`);
      return linkResponse.result.url;
    } catch (linkError: any) {
      // Jika link sudah ada, ambil yang existing
      if (
        linkError?.error?.error?.['.tag'] === 'shared_link_already_exists' ||
        linkError?.error?.['.tag'] === 'shared_link_already_exists'
      ) {
        this.logger.debug(`Shared link already exists, fetching existing link...`);
        const listResponse = await this.dropbox.sharingListSharedLinks({
          path: filePath,
          direct_only: true, // ✅ Hanya ambil link untuk file ini, bukan folder parent
        });

        if (!listResponse.result.links.length) {
          throw new Error('Failed to get existing shared link');
        }

        this.logger.debug(`Found existing shared link: ${listResponse.result.links[0].url}`);
        return listResponse.result.links[0].url;
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
