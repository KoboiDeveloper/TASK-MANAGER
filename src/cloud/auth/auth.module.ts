import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from '../security/authGuard';
import { RolesGuard } from '../security/roles.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, RolesGuard],
  exports: [AuthService, AuthGuard, RolesGuard],
})
export class CloudAuthModule {}
