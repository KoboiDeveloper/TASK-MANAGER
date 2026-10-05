import { BadRequestException, Injectable, NotFoundException, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/request/requestCreateTicket.dto';

import { assertImageFile, safePathname, getOriginalName } from '../utils/file';
import { normalizeErrMsg } from '../utils/string';
import { RequestRepairTransactionDto } from './dto/request/requestTicketCommand';
import { EStatus } from '../constant/EStatus';
import { ResponseTicketCommand } from './dto/response/responseTicketCommand';
import { TicketListResponseDto, UserTicketSummaryDto } from './dto/response/responseTIcket.dto';
import { UserService } from '../user/user.service';
import { DropboxStorageService } from '../storage/dropbox.storage.service';

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);
  constructor(
    private readonly prismaService: PrismaService,
    private readonly userService: UserService,
    private readonly storageService: DropboxStorageService,
  ) {}

  private async pickNextAdminNik(category: string): Promise<string> {
    let users: Array<{ nik: string }> = [];
    const normalized = category.toLowerCase().replace(/\s+/g, '');
    if (normalized === 'kaskecil' || normalized === 'webother') {
      users = await this.prismaService.dT_USER.findMany({
        where: {
          handleWeb: true,
          statusActive: true,
        },
        select: { nik: true },
        orderBy: { nik: 'asc' },
      });
    } else {
      users = await this.prismaService.dT_USER.findMany({
        where: {
          roleId: 'ADMIN',
          statusActive: true,
        },
        select: { nik: true },
        orderBy: { nik: 'asc' },
      });
    }

    if (!users.length) {
      throw new BadRequestException('Tidak ada user untuk assign handlerNik.');
    }

    const handlerNiks = Array.from(new Set(users.map((u) => u.nik)));

    const last = await this.prismaService.dT_TICKET.findFirst({
      where: { handlerNik: { in: handlerNiks } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { handlerNik: true },
    });

    if (!last?.handlerNik) {
      return handlerNiks[0];
    }

    const idx = handlerNiks.indexOf(last.handlerNik);
    const nextIdx = idx >= 0 ? (idx + 1) % handlerNiks.length : 0;
    return handlerNiks[nextIdx];
  }

  // private async ensureTicket(ticketId: string): Promise<{ id: string }> {
  //   if (!ticketId) throw new BadRequestException('ticketId wajib diisi');
  //   const ticket = await this.prismaService.dT_TICKET.findUnique({
  //     where: { id: ticketId },
  //     select: { id: true },
  //   });
  //   if (!ticket) throw new NotFoundException('Ticket tidak ditemukan');
  //   return ticket;
  // }
  //
  // private async tryDeleteBlob(url: string, context: string): Promise<boolean> {
  //   try {
  //     await del(url);
  //     return true;
  //   } catch (e) {
  //     this.logger.warn(`Non-fatal: gagal hapus blob (${context}): ${url} :: ${normalizeErrMsg(e)}`);
  //     return false;
  //   }
  // }

  private async generateTicketId(): Promise<string> {
    const prefix = 'TC-';

    const last = await this.prismaService.dT_TICKET.findFirst({
      where: { id: { startsWith: prefix } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    let next = 1;
    if (last?.id) {
      const m = /^TC-(\d+)$/.exec(last.id);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) next = n + 1;
      }
    }

    const number = String(next).padStart(6, '0');
    return `${prefix}${number}`;
  }

  private async processImageFiles(
    files: Express.Multer.File[],
    ticketId: string,
  ): Promise<{ added: number; errors: string[] }> {
    let added = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        assertImageFile(file);

        const pathname = safePathname(getOriginalName(file) ?? 'upload.bin', ticketId);
        const data = new Blob([new Uint8Array(file.buffer)], {
          type: file.mimetype || 'application/octet-stream',
        });

        const uploaded = await this.storageService.uploadFile(
          pathname,
          file.buffer,
          file.mimetype || 'application/octet-stream',
        );

        await this.prismaService.dT_IMAGES.create({
          data: {
            url: uploaded.url,
            filename: getOriginalName(file).slice(0, 200),
            mimeType: (file.mimetype || 'application/octet-stream').slice(0, 100),
            bytes: file.size,
            ticketId,
          },
        });

        added++;
      } catch (e) {
        const name = getOriginalName(file);
        errors.push(`Tambah gambar "${name}" gagal: ${normalizeErrMsg(e)}`);
      }
    }

    return { added, errors };
  }

  //core
  async createTicket(data: CreateTicketDto, files?: Express.Multer.File[]): Promise<string> {
    const handlerNik = await this.pickNextAdminNik(data.category);
    const id = await this.generateTicketId();

    const {
      idStore,
      category,
      noTelp,
      description,
      fromPayment,
      toPayment,
      isDirectSelling,
      billCode,
      grandTotal,
      idtv,
    } = data;

    // ✅ UPLOAD IMAGES DULU (sebelum transaksi DB)
    const uploadedImages: Array<{
      url: string;
      filename: string;
      mimeType: string;
      bytes: number;
      path: string;
    }> = [];

    if (files?.length) {
      this.logger.log(`Ticket ${id}: Uploading ${files.length} image(s) to Dropbox...`);

      // Upload semua images dulu
      for (const file of files) {
        try {
          assertImageFile(file);
          const pathname = safePathname(getOriginalName(file) ?? 'upload.bin', id);

          const uploaded = await this.storageService.uploadFile(
            pathname,
            file.buffer,
            file.mimetype || 'application/octet-stream',
          );

          uploadedImages.push({
            url: uploaded.url,
            filename: getOriginalName(file).slice(0, 200),
            mimeType: (file.mimetype || 'application/octet-stream').slice(0, 100),
            bytes: file.size,
            path: uploaded.path,
          });
        } catch (e) {
          const name = getOriginalName(file);
          this.logger.error(`Ticket ${id}: Upload image "${name}" FAILED`);

          // ⚠️ ROLLBACK: Hapus semua images yang sudah ter-upload
          await this.rollbackUploadedImages(uploadedImages, id);

          throw new BadRequestException(
            `Gagal upload gambar "${name}": ${normalizeErrMsg(e)}. Ticket tidak dibuat.`,
          );
        }
      }

      this.logger.log(`Ticket ${id}: ${uploadedImages.length} image(s) uploaded successfully`);
    }

    // ✅ SIMPAN KE DB DALAM TRANSAKSI (ticket + images)
    try {
      await this.prismaService.$transaction(async (tx) => {
        // 1) Buat ticket utama
        await tx.dT_TICKET.create({
          data: {
            id,
            handlerNik,
            idStore,
            noTelp,
            category,
            status: EStatus.QUEUED,
            idtv,
            description,
            fromPayment,
            toPayment,
            isDirectSelling,
            billCode,
            grandTotal,
          },
        });

        // 2) Simpan semua image records
        if (uploadedImages.length > 0) {
          await tx.dT_IMAGES.createMany({
            data: uploadedImages.map((img) => ({
              url: img.url,
              filename: img.filename,
              mimeType: img.mimeType,
              bytes: img.bytes,
              ticketId: id,
            })),
          });
        }
      });

      this.logger.log(`Ticket ${id} created successfully with ${uploadedImages.length} image(s)`);
      return id;
    } catch (e) {
      // ⚠️ ROLLBACK: Hapus semua images dari Dropbox jika DB save gagal
      this.logger.error(`Ticket ${id}: Failed to save to DB, rolling back...`);
      await this.rollbackUploadedImages(uploadedImages, id);

      throw new BadRequestException(`Gagal membuat ticket: ${normalizeErrMsg(e)}`);
    }
  }

  // ✅ HELPER: Rollback uploaded images jika ada error
  private async rollbackUploadedImages(
    images: Array<{ url: string; path: string }>,
    ticketId: string,
  ): Promise<void> {
    if (images.length === 0) return;

    this.logger.warn(`Ticket ${ticketId}: Rolling back ${images.length} uploaded image(s)...`);

    for (const img of images) {
      try {
        await this.storageService.deleteFile(img.url);
        this.logger.debug(`Ticket ${ticketId}: Rolled back image ${img.path}`);
      } catch (err) {
        this.logger.error(
          `Ticket ${ticketId}: Failed to rollback image ${img.path}: ${normalizeErrMsg(err)}`,
        );
      }
    }
  }

  async getTickets(): Promise<TicketListResponseDto[]> {
    return await this.prismaService.dT_TICKET.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        idStore: true,
        noTelp: true,
        category: true,
        status: true,
        description: true,
        fromPayment: true,
        toPayment: true,
        isDirectSelling: true,
        billCode: true,
        grandTotal: true,
        completedBy: { select: { nama: true } },
        idtv: true,
        reason: true,
        completedAt: true,
        createdAt: true,
        handler: { select: { nik: true, nama: true, noTelp: true } },
        images: {
          select: {
            id: true,
            url: true,
          },
        },
      },
    });
  }

  async getTicketsPaginated(
    limit: number,
    offset: number,
    handlerNik?: string,
    search?: string,
    status?: string,
    ticketId?: string,
    idStore?: string,
  ): Promise<{ data: TicketListResponseDto[]; total: number; hasMore: boolean }> {
    const where: any = {};
    if (ticketId && ticketId.trim()) {
      where.id = { contains: ticketId.trim() };
    }
    if (idStore && idStore.trim()) {
      where.idStore = { contains: idStore.trim() };
    }
    if (handlerNik && handlerNik.trim()) {
      const handlerList = handlerNik
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      if (handlerList.length === 1) {
        where.handlerNik = handlerList[0];
      } else if (handlerList.length > 1) {
        where.handlerNik = { in: handlerList };
      }
    }
    if (status && status.trim()) {
      const statusList = status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statusList.length === 1) {
        where.status = statusList[0];
      } else if (statusList.length > 1) {
        where.status = { in: statusList };
      }
    }
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { id: { contains: q } },
        { idStore: { contains: q } },
        { noTelp: { contains: q } },
        { category: { contains: q } },
        { description: { contains: q } },
        { billCode: { contains: q } },
        { idtv: { contains: q } },
        { handler: { nama: { contains: q } } },
      ];
    }

    const [total, tickets] = await Promise.all([
      this.prismaService.dT_TICKET.count({ where }),
      this.prismaService.dT_TICKET.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          idStore: true,
          noTelp: true,
          category: true,
          status: true,
          description: true,
          fromPayment: true,
          toPayment: true,
          isDirectSelling: true,
          billCode: true,
          grandTotal: true,
          completedBy: { select: { nama: true } },
          idtv: true,
          reason: true,
          completedAt: true,
          createdAt: true,
          handler: { select: { nik: true, nama: true, noTelp: true } },
          images: {
            select: {
              id: true,
              url: true,
            },
          },
        },
      }),
    ]);

    return {
      data: tickets,
      total,
      hasMore: offset + tickets.length < total,
    };
  }

  async reassignTicket(ticketId: string, nik: string): Promise<string> {
    await this.prismaService.dT_TICKET.update({
      where: {
        id: ticketId,
      },
      data: {
        handlerNik: nik,
      },
    });

    return 'Ticket successfully reassigned';
  }

  async getSummaryByUser(): Promise<UserTicketSummaryDto[]> {
    const admins = await this.userService.findAdmin();
    const niks = admins.map((s) => s.nik).filter(Boolean);
    if (niks.length === 0) return [];

    // 1) totalAll per handlerNik
    const totalAll = await this.prismaService.dT_TICKET.groupBy({
      by: ['handlerNik'],
      where: {
        handlerNik: { in: niks },
      },
      _count: { _all: true },
    });

    // 2) totalQueued per handlerNik (hanya status QUEUED, pending/cancelled/completed tidak dihitung)
    const totalQueued = await this.prismaService.dT_TICKET.groupBy({
      by: ['handlerNik'],
      where: {
        handlerNik: { in: niks },
        status: EStatus.QUEUED,
      },
      _count: { _all: true },
    });

    // Build map untuk lookup cepat
    const mapAll = new Map<string, number>();
    for (const row of totalAll) mapAll.set(row.handlerNik, row._count._all);

    const mapQueued = new Map<string, number>();
    for (const row of totalQueued) mapQueued.set(row.handlerNik, row._count._all);

    // Merge ke list ADMIN; user tanpa tiket tetap muncul (0)
    const result: UserTicketSummaryDto[] = admins.map((s) => {
      const all = mapAll.get(s.nik) ?? 0;
      const queued = mapQueued.get(s.nik) ?? 0;
      return {
        nik: s.nik,
        name: s.nama,
        totalAll: all,
        uncompleted: queued,
      };
    });

    // (Opsional) urutkan yang paling banyak uncompleted dulu untuk UX tab/badge
    result.sort((a, b) => b.uncompleted - a.uncompleted);

    return result;
  }

  async getTicketByStoreId(idStore: string): Promise<TicketListResponseDto[]> {
    return this.prismaService.dT_TICKET.findMany({
      where: { idStore },
      select: {
        id: true,
        idStore: true,
        noTelp: true,
        category: true,
        status: true,
        description: true,
        fromPayment: true,
        toPayment: true,
        isDirectSelling: true,
        billCode: true,
        grandTotal: true,
        idtv: true,
        reason: true,
        completedBy: { select: { nama: true } },
        completedAt: true,
        createdAt: true,
        handler: { select: { nik: true, nama: true, noTelp: true } },
        images: {
          select: {
            id: true,
            url: true,
          },
        },
      },
    });
  }

  async getTicketByNik(handlerNik: string): Promise<TicketListResponseDto[]> {
    return this.prismaService.dT_TICKET.findMany({
      where: { handlerNik },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        idStore: true,
        noTelp: true,
        category: true,
        status: true,
        description: true,
        fromPayment: true,
        toPayment: true,
        isDirectSelling: true,
        billCode: true,
        idtv: true,
        reason: true,
        grandTotal: true,
        completedBy: { select: { nama: true } },
        completedAt: true,
        createdAt: true,
        handler: { select: { nik: true, nama: true, noTelp: true } },
        images: {
          select: {
            id: true,
            url: true,
          },
        },
      },
    });
  }

  async repairtPayment(data: RequestRepairTransactionDto): Promise<string> {
    await this.prismaService.dT_TICKET.update({
      where: { id: data.ticketId },
      data: {
        status: EStatus.ONPROCESS,
      },
    });

    return 'repair payment request processed';
  }
  //by listener
  async TicketStatusUpdated(data: ResponseTicketCommand) {
    console.log('📤 Buka pesan update', data);

    const ticket = await this.prismaService.dT_TICKET.update({
      where: { id: data.ticketId },
      data: {
        status: data.status,
        completedByNik: data.senderNik,
        completedAt: data.status === EStatus.COMPLETED ? new Date() : null,
      },
    });

    this.logger.log(`✅ Ticket ${data.ticketId} updated to ${data.status}`);
    return ticket;
  }

  async completeTicket(ticketId: string, nik: string): Promise<string> {
    // 1) Cek tiket ada atau tidak
    const ticket = await this.prismaService.dT_TICKET.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket tidak ditemukan');

    // 2) Ambil semua images terkait
    // const images = await this.prismaService.dT_IMAGES.findMany({
    //   where: { ticketId },
    //   select: { id: true, url: true },
    // });
    // const imageIds = images.map((i) => i.id);

    // 3) Transaction untuk update tiket + hapus images (sekali saja)
    await this.prismaService.$transaction([
      this.prismaService.dT_TICKET.update({
        where: { id: ticketId },
        data: {
          status: EStatus.COMPLETED,
          completedByNik: nik,
          reason: null,
          completedAt: new Date(),
        },
      }),
      // ...(imageIds.length > 0
      //   ? [this.prismaService.dT_IMAGES.deleteMany({ where: { id: { in: imageIds } } })]
      //   : []),
    ]);

    // // 4) Hapus blob di Vercel pakai helper
    // let blobFailed = 0;
    // for (const img of images) {
    //   const ok = await this.tryDeleteBlob(img.url, `completeTicket(${ticketId}) id=${img.id}`);
    //   if (!ok) blobFailed++;
    // }

    // 5) Return hasil
    return `Ticket ${ticketId} completed.`;
  }

  async pendingTicket(ticketId: string, reason: string): Promise<string> {
    // Cek tiket ada atau tidak
    const ticket = await this.prismaService.dT_TICKET.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) throw new NotFoundException('Ticket tidak ditemukan');

    // Update status tiket jadi PENDING
    await this.prismaService.dT_TICKET.update({
      where: { id: ticketId },
      data: {
        status: EStatus.PENDING,
        reason: reason,
      },
    });
    return `Ticket ${ticketId} berhasil di-hold`;
  }

  async cancelTicket(ticketId: string, reason: string): Promise<string> {
    const ticket = await this.prismaService.dT_TICKET.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) throw new NotFoundException('Ticket tidak ditemukan');

    await this.prismaService.dT_TICKET.update({
      where: { id: ticketId },
      data: {
        status: EStatus.CANCELLED,
        reason: reason,
      },
    });
    return `Ticket ${ticketId} berhasil dibatalkan`;
  }
}
