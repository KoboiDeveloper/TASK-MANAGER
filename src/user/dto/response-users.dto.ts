export class ResponseListUsersDto {
  nik: string;
  nama: string;
  noTelp: string;
  email: string;
  roleId: string;
  statusActive: boolean;
  handleWeb: boolean;
  accessRegionIds: { regionId: string }[];
  accessStoreIds: { storeId: string }[];
}
