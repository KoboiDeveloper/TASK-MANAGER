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
import { RegionService } from './region.service';
import { RequestCreateRegionDto } from './dto/requestCreateRegion.dto';
import { CommonResponse } from '../common/commonResponse';
import { handleException } from '../utils/handleException';
import { DT_REGION } from '@prisma/client';
import { AuthGuard } from '../security/authGuard';
import { Roles } from '../security/roles.decorator';

@UseGuards(AuthGuard)
@Roles('SUPER')
@Controller('api/regions')
export class RegionController {
  constructor(private readonly regionService: RegionService) {}

  @Post('/add')
  async create(@Body() createRegionDto: RequestCreateRegionDto) {
    try {
      const response: DT_REGION | undefined = await this.regionService.create(createRegionDto);
      return new CommonResponse<DT_REGION | undefined>(
        'Region Created',
        HttpStatus.CREATED,
        response,
      );
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get()
  async findAll() {
    try {
      const response: DT_REGION[] | undefined = await this.regionService.findAll();
      return new CommonResponse<DT_REGION[] | undefined>('Region List', HttpStatus.OK, response);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Get('/:id')
  findOne(@Param('id') id: string) {
    return this.regionService.findOne(id);
  }

  @Patch('/update/:id')
  async update(@Param('id') id: string, @Body() data: RequestCreateRegionDto) {
    try {
      const updated = await this.regionService.update(id, data);
      return new CommonResponse('Update Region Successfully', HttpStatus.OK, updated);
    } catch ({ message }) {
      return handleException(message as string);
    }
  }

  @Delete('/remove/:id')
  remove(@Param('id') id: string) {
    return this.regionService.remove(id);
  }
}
