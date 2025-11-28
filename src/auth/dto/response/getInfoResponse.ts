class MemberProjects {
  projectId: string;
  name: string;
  color: string | null;
  roleProject: string;
}

export class GetInfoUserResponse {
  nik: string;
  nama: string;
  roleId: string;
  memberProjects: MemberProjects[];
}
