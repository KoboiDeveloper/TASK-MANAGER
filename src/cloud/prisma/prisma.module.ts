import { Global, Module } from '@nestjs/common';
import { CloudPrismaService } from './prisma.service';

@Global()
@Module({
  providers: [CloudPrismaService],
  exports: [CloudPrismaService],
})
export class CloudPrismaModule {}
