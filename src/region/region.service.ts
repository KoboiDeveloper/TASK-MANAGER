import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RequestCreateRegionDto } from './dto/requestCreateRegion.dto';
import { PrismaService } from '../prisma/prisma.service';
import { DT_REGION } from '@prisma/client';

@Injectable()
export class RegionService {
  constructor(private readonly prismaService: PrismaService) {}

  async create(data: RequestCreateRegionDto): Promise<DT_REGION | undefined> {
    try {
      return await this.prismaService.dT_REGION.create({
        data,
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new ConflictException(error.message || 'Unable to create region');
      }
    }
  }

  async findAll(): Promise<DT_REGION[] | undefined> {
    try {
      return await this.prismaService.dT_REGION.findMany();
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new ConflictException(error.message || 'Unable to get regions');
      }
    }
  }

  async findOne(id: string) {
    try {
      return await this.prismaService.dT_REGION.findUnique({
        where: {
          id,
        },
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new NotFoundException(error.message || 'Region not found');
      }
    }
    return `This action returns a #${id} region`;
  }

  async update(id: string, data: RequestCreateRegionDto): Promise<DT_REGION> {
    const existingRegion = await this.findOne(id);
    if (!existingRegion) {
      throw new NotFoundException('Region not found');
    }

    if (data.id !== id) {
      const isIdExist = await this.prismaService.dT_REGION.findUnique({
        where: { id: data.id },
      });
      if (isIdExist) {
        throw new ConflictException(`Region ID '${data.id}' already exists`);
      }
    }

    return this.prismaService.$transaction(async (tx) => {
      if (data.id !== id) {
        // Buat region baru dengan ID baru
        const newRegion = await tx.dT_REGION.create({
          data: {
            id: data.id,
            region: data.region,
          },
        });

        // Update semua relasi ke ID baru
        await tx.dT_STORE.updateMany({
          where: { regionId: id },
          data: { regionId: data.id },
        });

        await tx.dT_ACCESS_REGION.updateMany({
          where: { regionId: id },
          data: { regionId: data.id },
        });

        // Hapus region lama
        await tx.dT_REGION.delete({ where: { id } });

        return newRegion; // return DT_REGION
      }

      // Kalau id sama, cukup update field region
      return tx.dT_REGION.update({
        where: { id },
        data: { region: data.region },
      });
    });
  }

  async remove(id: string): Promise<DT_REGION> {
    // cek apakah region ada
    const region = await this.prismaService.dT_REGION.findUnique({ where: { id } });
    if (!region) {
      throw new NotFoundException(`Region with ID '${id}' not found`);
    }

    // cek apakah region masih dipakai di STORE
    const stores = await this.prismaService.dT_STORE.findMany({
      where: { regionId: id },
    });
    if (stores.length > 0) {
      throw new ConflictException(
        `Region '${id}' cannot be deleted because it is still assigned to stores`,
      );
    }

    // cek apakah region masih dipakai di ACCESS_REGION
    const accessRegions = await this.prismaService.dT_ACCESS_REGION.findMany({
      where: { regionId: id },
    });
    if (accessRegions.length > 0) {
      throw new ConflictException(
        `Region '${id}' cannot be deleted because it is still assigned to active users`,
      );
    }

    // hapus region
    return this.prismaService.dT_REGION.delete({
      where: { id },
    });
  }
}
