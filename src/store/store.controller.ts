import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { StoreService } from './store.service';
import { RequestStoreDto } from './dto/request-store.dto';
import { DT_STORE } from '@prisma/client';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { Roles } from '../security/roles.decorator';
import { AuthGuard } from '../security/authGuard';

@UseGuards(AuthGuard)
@Roles('SUPER')
@Controller('api/stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Post('/add')
  async create(@Body() createStoreDto: RequestStoreDto) {
    try {
      await this.storeService.create(createStoreDto);
      return new CommonResponse<null>('Store created', HttpStatus.CREATED, null);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get()
  async findAll() {
    try {
      const stores: DT_STORE[] = await this.storeService.findAll();
      return new CommonResponse<DT_STORE[]>('All stores retrieved', HttpStatus.OK, stores);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get('/:id')
  async findOne(@Param('id') id: string) {
    try {
      const store: DT_STORE | null = await this.storeService.findOne(id);
      return new CommonResponse<DT_STORE | null>('Store found', HttpStatus.OK, store);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Patch('/update/:id')
  async update(@Param('id') id: string, @Body() requestStoreDto: RequestStoreDto) {
    try {
      const updated = await this.storeService.update(id, requestStoreDto);
      return new CommonResponse<DT_STORE>('Store updated', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete('/delete/:id')
  async remove(@Param('id') id: string) {
    try {
      const deleted = await this.storeService.remove(id);
      return new CommonResponse<DT_STORE>('Store deleted', HttpStatus.OK, deleted);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }
}
