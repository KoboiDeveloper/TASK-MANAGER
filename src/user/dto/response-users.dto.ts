class ACCESSSTORES {
  storeId: string;
}

class ACCESSREGIONS {
  regionId: string;
}

export class RequestCreateUsersDto {
  nik: string;
  nama: string;
  password: string;
  noTelp: string;
  email: string;
  roleId: string;
  accessStores: Partial<ACCESSSTORES>[] | null;
  accessRegions: Partial<ACCESSREGIONS>[] | null;
  statusActive: boolean;
}

export class ResponseListUsersDto {
  nik: string;
  nama: string;
  noTelp: string;
  email: string;
  roleId: string;
  statusActive: boolean;
  accessRegionIds: { regionId: string }[];
  accessStoreIds: { storeId: string }[];
}
