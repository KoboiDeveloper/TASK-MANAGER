export class ResponseListUsersDto {
  nik: string;
  nama: string;
  noTelp: string | null;
  email: string | null;
  roleId: string;
  statusActive: boolean;
  handleWeb: boolean;
  photo: string | null;
  departement?: string | null;
  departemen?: string | null;
  notificationPrefs?: string | null;
}

export class ResponseUserContains {
  nik: string;
  nama: string;
  photo: string | null;
}

export type EmpHRIS = {
  nik: string;
  name: string;
  department?: string;
  status: boolean;
};
