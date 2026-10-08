export class GetInfoUserResponse {
  nik: string;
  nama: string;
  roleId: string;
  photo: string | null;
  quota?: {
    limitBytes: string;
    usedBytes: string;
  };
}
