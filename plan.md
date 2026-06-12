# Rencana Migrasi: Vercel Blob → Dropbox

## 📋 Ringkasan
Migrasi sistem penyimpanan file dari **Vercel Blob** ke **Dropbox** untuk aplikasi Task Manager berbasis NestJS.

---

## 🔍 Analisis Kode Saat Ini

### File yang Menggunakan Vercel Blob
1. **`src/ticket/ticket.service.ts`** (line 3, 126-130)
   - Upload gambar ticket via `put()`
   
2. **`src/project/project.service.ts`** (line 33, 437-440, 395, 513)
   - Upload attachment task via `put()`
   - Delete attachment via `del()`
   
3. **`src/utils/cronjob/cronjob.service.ts`** (line 5, 135)
   - Cronjob cleanup gambar lama via `del()`

### Package Dependencies
- `@vercel/blob@^1.1.1` (akan dihapus)
- Diperlukan: `dropbox` SDK

### Environment Variables
- **Current:** `BLOB_READ_WRITE_TOKEN` (Vercel Blob token)
- **New:** `DROPBOX_ACCESS_TOKEN`, `DROPBOX_FOLDER_PATH`

---

## 🎯 Tahapan Migrasi

### **PHASE 1: Persiapan & Setup** (Estimasi: 2-3 jam)

#### Step 1.1: Buat Dropbox App & Credentials
1. Kunjungi [Dropbox Developers](https://www.dropbox.com/developers)
2. Buat app baru dengan tipe **Scoped access**
3. Pilih **Full Dropbox** access
4. Generate **Access Token** (long-lived token atau setup OAuth2)
5. Catat credentials:
   - `DROPBOX_ACCESS_TOKEN`
   - `DROPBOX_FOLDER_PATH` (misal: `/task-manager-files`)

#### Step 1.2: Install Dropbox SDK
```bash
pnpm add dropbox
pnpm remove @vercel/blob
```

#### Step 1.3: Update Environment Variables
**File: `.env`**
```env
# Hapus atau comment out
# BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."

# Tambahkan
DROPBOX_ACCESS_TOKEN="your_dropbox_access_token_here"
DROPBOX_FOLDER_PATH="/task-manager-files"
```

---

### **PHASE 2: Buat Storage Abstraction Layer** (Estimasi: 3-4 jam)

#### Step 2.1: Buat Storage Service Interface
**File baru: `src/storage/storage.interface.ts`**
```typescript
export interface IStorageService {
  uploadFile(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ url: string; path: string }>;

  deleteFile(path: string): Promise<void>;

  getFileUrl(path: string): Promise<string>;
}
```

#### Step 2.2: Implementasi Dropbox Service
**File baru: `src/storage/dropbox.storage.service.ts`**
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Dropbox } from 'dropbox';
import { IStorageService } from './storage.interface';

@Injectable()
export class DropboxStorageService implements IStorageService {
  private readonly logger = new Logger(DropboxStorageService.name);
  private readonly dropbox: Dropbox;
  private readonly basePath: string;

  constructor() {
    this.dropbox = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });
    this.basePath = process.env.DROPBOX_FOLDER_PATH || '/task-manager-files';
  }

  async uploadFile(path: string, buffer: Buffer, contentType: string) {
    const fullPath = `${this.basePath}/${path}`;
    
    const response = await this.dropbox.filesUpload({
      path: fullPath,
      contents: buffer,
      mode: { '.tag': 'overwrite' },
    });

    // Get shareable link
    const linkResponse = await this.dropbox.sharingCreateSharedLink({
      path: response.result.path_display,
    });

    // Convert preview URL to direct download URL
    const directUrl = linkResponse.result.url.replace('?dl=0', '&raw=1');

    return {
      url: directUrl,
      path: response.result.path_display,
    };
  }

  async deleteFile(path: string): Promise<void> {
    const fullPath = `${this.basePath}/${path}`;
    await this.dropbox.filesDeleteV2({ path: fullPath });
  }

  async getFileUrl(path: string): Promise<string> {
    const fullPath = `${this.basePath}/${path}`;
    const linkResponse = await this.dropbox.sharingCreateSharedLink({ path: fullPath });
    return linkResponse.result.url.replace('?dl=0', '&raw=1');
  }
}
```

#### Step 2.3: Buat Storage Module
**File baru: `src/storage/storage.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { DropboxStorageService } from './dropbox.storage.service';

@Module({
  providers: [DropboxStorageService],
  exports: [DropboxStorageService],
})
export class StorageModule {}
```

---

### **PHASE 3: Migrasi Ticket Service** (Estimasi: 2-3 jam)

#### Step 3.1: Update Imports & Dependencies
**File: `src/ticket/ticket.service.ts`**

**Hapus:**
```typescript
import { put } from '@vercel/blob';
```

**Tambahkan:**
```typescript
import { DropboxStorageService } from '../storage/dropbox.storage.service';
```

#### Step 3.2: Inject Storage Service
```typescript
@Injectable()
export class TicketService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly userService: UserService,
    private readonly storageService: DropboxStorageService, // <-- Add this
    @Inject('STORE_CLIENT') private readonly client: ClientProxy,
  ) {}
  // ...
}
```

#### Step 3.3: Update `processImageFiles()` Method
**Replace line 126-130:**
```typescript
// OLD (Vercel Blob):
const blob = await put(pathname, data, {
  access: 'public',
  addRandomSuffix: true,
  contentType: file.mimetype,
});

// NEW (Dropbox):
const uploaded = await this.storageService.uploadFile(
  pathname,
  file.buffer,
  file.mimetype || 'application/octet-stream'
);

// Update database dengan uploaded.url
await this.prismaService.dT_IMAGES.create({
  data: {
    url: uploaded.url, // <-- Changed from blob.url
    filename: getOriginalName(file).slice(0, 200),
    mimeType: (file.mimetype || 'application/octet-stream').slice(0, 100),
    bytes: file.size,
    ticketId,
  },
});
```

#### Step 3.4: Update Ticket Module
**File: `src/ticket/ticket.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule], // <-- Add this
  // ... existing config
})
export class TicketModule {}
```

---

### **PHASE 4: Migrasi Project Service** (Estimasi: 2-3 jam)

#### Step 4.1: Update Imports
**File: `src/project/project.service.ts`**

**Hapus:**
```typescript
import { del, put } from '@vercel/blob';
```

**Tambahkan:**
```typescript
import { DropboxStorageService } from '../storage/dropbox.storage.service';
```

#### Step 4.2: Inject Storage Service
```typescript
@Injectable()
export class ProjectService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
    private readonly storageService: DropboxStorageService, // <-- Add this
  ) {}
  // ...
}
```

#### Step 4.3: Update `AddTaskAttachments()` Method
**Replace line 437-440:**
```typescript
// OLD:
const blob = await put(key, file.buffer, {
  access: 'public',
  contentType: file.mimetype,
});

// NEW:
const uploaded = await this.storageService.uploadFile(
  key,
  file.buffer,
  file.mimetype
);

return {
  taskId,
  url: uploaded.url, // <-- Changed from blob.url
  filename: safeFilename,
  mimeType: file.mimetype,
  bytes: file.size,
};
```

#### Step 4.4: Update `deleteTaskId()` Method
**Replace line 395:**
```typescript
// OLD:
await del(att.url);

// NEW:
// Extract path dari URL Dropbox atau simpan path di DB
await this.storageService.deleteFile(att.url);
```

#### Step 4.5: Update `deleteTaskAttachments()` Method
**Replace line 513:**
```typescript
// OLD:
await del(att.url);

// NEW:
await this.storageService.deleteFile(att.url);
```

#### Step 4.6: Update Project Module
**File: `src/project/project.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule], // <-- Add this
  // ... existing config
})
export class ProjectModule {}
```

---

### **PHASE 5: Migrasi Cronjob Service** (Estimasi: 2 jam)

#### Step 5.1: Update Imports
**File: `src/utils/cronjob/cronjob.service.ts`**

**Hapus:**
```typescript
import { del } from '@vercel/blob';
```

**Tambahkan:**
```typescript
import { DropboxStorageService } from '../../storage/dropbox.storage.service';
```

#### Step 5.2: Inject Storage Service
```typescript
@Injectable()
export class CronjobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: DropboxStorageService, // <-- Add this
  ) {}
  // ...
}
```

#### Step 5.3: Update Cleanup Logic
**Replace line 135:**
```typescript
// OLD:
await del(r.url, { token: this.blobToken });

// NEW:
await this.storageService.deleteFile(r.url);
```

#### Step 5.4: Remove Blob Token Validation
**Hapus atau update line 66-75 & 84-87:**
```typescript
// Remove blob token check
// OLD:
private readonly blobToken: string = String(process.env.BLOB_READ_WRITE_TOKEN ?? '');
private isAllowedBlobHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === 'blob.vercel-storage.com') return true;
  return (
    hostname.endsWith('.blob.vercel-storage.com') ||
    hostname.endsWith('.public.blob.vercel-storage.com')
  );
}

// NEW: Simplify atau hapus validasi blob host
```

#### Step 5.5: Update Cronjob Module
**File: `src/utils/cronjob/cronjob.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule], // <-- Add this
  // ... existing config
})
export class CronjobModule {}
```

---

### **PHASE 6: Testing & Validasi** (Estimasi: 3-4 jam)

#### Step 6.1: Unit Testing
- Test upload file ke Dropbox
- Test delete file dari Dropbox
- Test error handling (invalid token, quota exceeded, dll)

#### Step 6.2: Integration Testing
1. **Ticket Flow:**
   - Create ticket dengan attachment
   - Verify file ter-upload ke Dropbox
   - Verify URL dapat diakses
   
2. **Project Flow:**
   - Add task attachments
   - Delete task dengan attachments
   - Delete specific attachments
   
3. **Cronjob Flow:**
   - Trigger cleanup manual
   - Verify file lama terhapus dari Dropbox
   - Verify DB records terhapus

#### Step 6.3: Testing Checklist
- [ ] Upload gambar ticket berhasil
- [ ] Upload task attachment berhasil
- [ ] Delete task dengan attachments berhasil
- [ ] Delete specific attachment berhasil
- [ ] Cronjob cleanup berjalan otomatis
- [ ] URL file dapat diakses publik
- [ ] Error handling saat Dropbox down
- [ ] File size validation masih bekerja
- [ ] Content-type validation masih bekerja

---

### **PHASE 7: Data Migration (Opsional)** (Estimasi: 2-4 jam)

> **Note:** Jika Anda ingin memindahkan file existing dari Vercel Blob ke Dropbox

#### Step 7.1: Buat Migration Script
**File baru: `scripts/migrate-blob-to-dropbox.ts`**
```typescript
import { PrismaClient } from '@prisma/client';
import { Dropbox } from 'dropbox';
import axios from 'axios';

const prisma = new PrismaClient();
const dropbox = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });
const BASE_PATH = process.env.DROPBOX_FOLDER_PATH || '/task-manager-files';

async function migrateImages() {
  const images = await prisma.dT_IMAGES.findMany({
    where: {
      url: { contains: 'blob.vercel-storage.com' }
    }
  });

  console.log(`Found ${images.length} images to migrate`);

  for (const image of images) {
    try {
      // Download from Vercel Blob
      const response = await axios.get(image.url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      // Extract filename from URL
      const filename = image.filename || `image-${image.id}`;
      const path = `/tickets/${image.ticketId}/${filename}`;

      // Upload to Dropbox
      await dropbox.filesUpload({
        path: `${BASE_PATH}${path}`,
        contents: buffer,
        mode: { '.tag': 'overwrite' }
      });

      // Create shared link
      const linkResponse = await dropbox.sharingCreateSharedLink({
        path: `${BASE_PATH}${path}`
      });

      const newUrl = linkResponse.result.url.replace('?dl=0', '&raw=1');

      // Update database
      await prisma.dT_IMAGES.update({
        where: { id: image.id },
        data: { url: newUrl }
      });

      console.log(`✓ Migrated image ${image.id}`);
    } catch (error) {
      console.error(`✗ Failed to migrate image ${image.id}:`, error);
    }
  }
}

async function migrateTaskAttachments() {
  const attachments = await prisma.dT_TASK_ATTACHMENT.findMany({
    where: {
      url: { contains: 'blob.vercel-storage.com' }
    }
  });

  console.log(`Found ${attachments.length} task attachments to migrate`);

  for (const attachment of attachments) {
    try {
      const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      const path = `/tasks/${attachment.taskId}/${attachment.filename}`;

      await dropbox.filesUpload({
        path: `${BASE_PATH}${path}`,
        contents: buffer,
        mode: { '.tag': 'overwrite' }
      });

      const linkResponse = await dropbox.sharingCreateSharedLink({
        path: `${BASE_PATH}${path}`
      });

      const newUrl = linkResponse.result.url.replace('?dl=0', '&raw=1');

      await prisma.dT_TASK_ATTACHMENT.update({
        where: { id: attachment.id },
        data: { url: newUrl }
      });

      console.log(`✓ Migrated attachment ${attachment.id}`);
    } catch (error) {
      console.error(`✗ Failed to migrate attachment ${attachment.id}:`, error);
    }
  }
}

async function main() {
  await migrateImages();
  await migrateTaskAttachments();
  console.log('Migration completed');
}

main().catch(console.error).finally(() => prisma.$disconnect());
```

#### Step 7.2: Run Migration
```bash
ts-node scripts/migrate-blob-to-dropbox.ts
```

---

### **PHASE 8: Cleanup & Deployment** (Estimasi: 1-2 jam)

#### Step 8.1: Remove Vercel Blob Dependencies
```bash
pnpm remove @vercel/blob
```

#### Step 8.2: Update `.gitignore`
Pastikan tidak ada credentials yang ter-commit:
```
.env
.env.local
.env.production
```

#### Step 8.3: Update Documentation
- Update README.md dengan setup instructions baru
- Update environment variables documentation

#### Step 8.4: Deploy to Production
1. Set environment variables di Vercel/production server
2. Deploy aplikasi
3. Monitor logs untuk error
4. Verify semua fitur berfungsi

---

## 📊 Estimasi Total

| Phase | Deskripsi | Estimasi | Status |
|-------|-----------|----------|--------|
| 1 | Persiapan & Setup | 2-3 jam | ✅ SELESAI |
| 2 | Storage Abstraction Layer | 3-4 jam | ✅ SELESAI |
| 3 | Migrasi Ticket Service | 2-3 jam | ✅ SELESAI |
| 4 | Migrasi Project Service | 2-3 jam | ✅ SELESAI |
| 5 | Migrasi Cronjob Service | 2 jam | ✅ SELESAI |
| 6 | Testing & Validasi | 3-4 jam | ⏳ NEXT |
| 7 | Data Migration (Opsional) | 2-4 jam | 📋 OPSIONAL |
| 8 | Cleanup & Deployment | 1-2 jam | 📋 PENDING |
| **TOTAL** | | **17-25 jam** | **~60% DONE** |

---

## ⚠️ Hal yang Perlu Diperhatikan

### 1. **URL Format**
- **Vercel Blob:** Direct URL (public access)
- **Dropbox:** Shared link dengan `?raw=1` parameter untuk direct access
- Pastikan frontend dapat mengakses URL Dropbox

### 2. **Rate Limiting**
- Dropbox API memiliki rate limits
- Pertimbangkan untuk implement retry logic
- Monitor API usage

### 3. **File Size Limits**
- Dropbox: Max 350MB per file (via API)
- Current validation: 1MB untuk images (masih aman)

### 4. **Security**
- Jangan commit access token ke repository
- Rotate token secara berkala
- Consider menggunakan OAuth2 untuk production

### 5. **Backup Strategy**
- Dropbox memiliki versioning (30 hari untuk basic, 180 hari untuk business)
- Pertimbangkan backup strategy tambahan

### 6. **Cost Consideration**
- **Vercel Blob:** Pay per usage
- **Dropbox:** Free tier 2GB, kemudian subscription based
- Evaluate mana yang lebih cost-effective untuk use case Anda

---

## 🔄 Rollback Plan

Jika ada masalah setelah migrasi:

1. **Keep Vercel Blob token** di `.env` selama 1-2 minggu
2. **Jangan hapus file** dari Vercel Blob sampai migrasi confirmed stable
3. **Git branch:** Buat branch `feature/migrate-to-dropbox` sebelum mulai
4. **Database backup:** Backup database sebelum run migration script

---

## ✅ Success Criteria

- [ ] Semua upload file menggunakan Dropbox
- [ ] Semua delete file menggunakan Dropbox API
- [ ] Cronjob cleanup berjalan dengan Dropbox
- [ ] Semua test pass
- [ ] No Vercel Blob imports di codebase
- [ ] `@vercel/blob` removed from package.json
- [ ] Production deployment successful
- [ ] No errors di production logs

---

## 📝 Next Steps

1. Review plan ini
2. Setup Dropbox developer account
3. Create feature branch
4. Start dengan Phase 1
5. Test setiap phase sebelum lanjut ke phase berikutnya

---

**Dibuat:** 2026-06-12  
**Status:** Menunggu review  
**Priority:** Medium
