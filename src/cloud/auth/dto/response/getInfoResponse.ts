export class GetInfoUserResponse {
  nik: string;
  nama: string;
  roleId: string;
  photo: string | null;
  mustChangePassword?: boolean;
  quota?: {
    limitBytes: string;
    usedBytes: string;
  };
}
