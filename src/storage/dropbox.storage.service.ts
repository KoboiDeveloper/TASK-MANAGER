import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Dropbox } from 'dropbox';
import { IStorageService } from './storage.interface';

@Injectable()
export class DropboxStorageService implements IStorageService {
  private readonly logger = new Logger(DropboxStorageService.name);
  private readonly dropbox: Dropbox;
  private readonly basePath: string;

  constructor() {
    const accessToken = process.env.DROPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('DROPBOX_ACCESS_TOKEN is not set in environment variables');
    }

    this.dropbox = new Dropbox({ accessToken });
    this.basePath = process.env.DROPBOX_FOLDER_PATH || '/task-manager-files';

    this.logger.log(`DropboxStorageService initialized with basePath: ${this.basePath}`);
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
        mute: false, // Don't mute notifications for debugging
      });

      const uploadedPath = uploadResponse.result.path_display || fullPath;
      this.logger.debug(`File uploaded to Dropbox at: ${uploadedPath}`);

      // Buat shared link agar file bisa diakses publik
      let sharedUrl: string;
      try {
        const linkResponse = await this.dropbox.sharingCreateSharedLink({
          path: uploadedPath,
          short_url: false,
        });
        sharedUrl = linkResponse.result.url;
        this.logger.debug(`Shared link created: ${sharedUrl}`);
      } catch (linkError: any) {
        // Jika link sudah ada, error "shared_link_already_exists"
        if (linkError?.error?.error?.['.tag'] === 'shared_link_already_exists') {
          this.logger.debug(`Shared link already exists, fetching existing link...`);
          // Get existing shared link
          const listResponse = await this.dropbox.sharingListSharedLinks({
            path: uploadedPath,
          });
          if (listResponse.result.links.length === 0) {
            throw new Error('Failed to get existing shared link');
          }
          sharedUrl = listResponse.result.links[0].url;
        } else {
          this.logger.error(`Failed to create shared link:`, linkError);
          throw linkError;
        }
      }

      // Convert Dropbox preview URL ke direct download URL
      // Dari: https://www.dropbox.com/scl/fi/xxx/filename.jpg?rlkey=xxx&dl=0
      // Ke: https://dl.dropbox.com/scl/fi/xxx/filename.jpg?rlkey=xxx&raw=1
      const directUrl = sharedUrl.replace('www.dropbox.com', 'dl.dropbox.com').replace('?dl=0', '&raw=1');

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
        // Extract dari URL Dropbox
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

      let sharedUrl: string;
      try {
        const linkResponse = await this.dropbox.sharingCreateSharedLink({
          path: fullPath,
          short_url: false,
        });
        sharedUrl = linkResponse.result.url;
      } catch (linkError: any) {
        if (linkError?.error?.error?.['.tag'] === 'shared_link_already_exists') {
          const listResponse = await this.dropbox.sharingListSharedLinks({
            path: fullPath,
          });
          sharedUrl = listResponse.result.links[0].url;
        } else {
          throw linkError;
        }
      }

      return sharedUrl.replace('www.dropbox.com', 'dl.dropbox.com').replace('?dl=0', '&raw=1');
    } catch (error: any) {
      this.logger.error(`Failed to get file URL: ${path}`, error?.message);
      throw new Error(`Failed to get file URL: ${error?.message || 'Unknown error'}`);
    }
  }
}
