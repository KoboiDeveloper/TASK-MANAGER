import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from './utils/mail/mail.module';
import { RoleModule } from './role/role.module';
import { StoreModule } from './store/store.module';
import { RegionModule } from './region/region.module';
import { TicketModule } from './ticket/ticket.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ProjectModule } from './project/project.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    UserModule,
    AuthModule,
    PrismaModule,
    MailModule,
    RoleModule,
    StoreModule,
    RegionModule,
    TicketModule,
    ProjectModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
