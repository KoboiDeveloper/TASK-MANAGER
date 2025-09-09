// import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
// import { Reflector } from '@nestjs/core';
// import { STOREACCESS } from './storeAccess.decorator';
// import { PrismaService } from '../prisma/prisma.service';
//
// @Injectable()
// export class StoreAccessGuard implements CanActivate {
//   constructor(
//     private reflector: Reflector,
//     private prisma: PrismaService,
//   ) {}
//
//   async canActivate(context: ExecutionContext): Promise<boolean> {
//     const isProtected = this.reflector.getAllAndOverride<boolean>(
//       STOREACCESS,
//       context.getHandler(),
//       context.getClass(),
//     );
//
//     if (!isProtected) return true;
//
//     const request = context.switchToHttp().getRequest();
//     const user = request.user;
//     const role: string = user.role;
//     const storeId = request.params.storeId || request.body?.storeId;
//
//     if (!storeId) {
//       throw new ForbiddenException('storeId tidak ditemukan di request');
//     }
//
//     // SUPER
//     if (role == 'SUPER') {
//       return true;
//     }
//
//     // CASHIER → hanya boleh akses by storeIds
//     if (role == 'CASHIER' || role == 'SPV' || role == 'SPVJ') {
//       const accessStoreIds = user.accessStoreIds || [];
//       if (!accessStoreIds.includes(storeId)) {
//         throw new ForbiddenException(`CASHIER tidak punya akses ke store ${storeId}`);
//       }
//       return true;
//     }
//
//     // AREACORDINATOR → hanya boleh akses by region
//     if (roles.includes('AC')) {
//       const accessRegionIds = user.accessRegionIds || [];
//
//       const store = await this.prisma.dT_STORE.findUnique({
//         where: { id_store: storeId },
//         select: { region: true },
//       });
//
//       if (!store || !store.region) {
//         throw new ForbiddenException('Store atau region tidak valid');
//       }
//
//       const regionId = store.region;
//
//       if (!accessRegionIds.includes(regionId)) {
//         throw new ForbiddenException(`SUPERVISOR tidak punya akses ke region ${regionId}`);
//       }
//
//       return true;
//     }
//
//     throw new ForbiddenException('Role tidak dikenali atau tidak memiliki akses');
//   }
// }
