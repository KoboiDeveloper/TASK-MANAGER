import { BadRequestException } from '@nestjs/common';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i;

export function assertImageFile(file?: Express.Multer.File): asserts file is Express.Multer.File {
  if (!file) throw new BadRequestException('File wajib diunggah');
  if (!IMAGE_MIME_RE.test(file.mimetype))
    throw new BadRequestException('Tipe file tidak diizinkan');
  if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException('Maksimum ukuran gambar 2MB');
}

export function safePathname(filename: string, ticketId?: string | null): string {
  const base = (filename || 'upload.bin').replace(/[^\w.-]+/g, '_');
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const prefix = ticketId
    ? `tickets/${ticketId}/${yyyy}-${mm}-${dd}/`
    : `tickets/${yyyy}-${mm}-${dd}/`;
  return `${prefix}${base}`;
}

export function getOriginalName(f?: Express.Multer.File | null): string {
  const name = f?.originalname;
  return typeof name === 'string' && name.trim() ? name : 'file';
}

export function safeUserPhotoPath(filename: string, nik: string): string {
  const base = (filename || 'avatar.jpg').replace(/[^\w.-]+/g, '_');
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `users/${nik}/${yyyy}-${mm}-${dd}/${Date.now()}_${base}`;
}
