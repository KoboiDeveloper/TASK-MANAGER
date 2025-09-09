import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { Module } from '@nestjs/common';
import { RegionModule } from '../region/region.module';

@Module({
  imports: [RegionModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
