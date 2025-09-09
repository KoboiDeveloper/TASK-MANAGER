import { PartialType } from '@nestjs/mapped-types';
import { RequestCreateRegionDto } from './requestCreateRegion.dto';

export class UpdateRegionDto extends PartialType(RequestCreateRegionDto) {}
