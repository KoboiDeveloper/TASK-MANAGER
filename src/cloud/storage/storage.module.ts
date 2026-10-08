import { Module } from '@nestjs/common';
import { DropboxStorageService } from './dropbox.storage.service';

@Module({
  providers: [DropboxStorageService],
  exports: [DropboxStorageService],
})
export class CloudStorageModule {}
