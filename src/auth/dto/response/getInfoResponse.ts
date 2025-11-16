class MemberProjects {
  projectId: string;
  roleProject: string;
}

export class GetInfoUserResponse {
  nik: string;
  nama: string;
  roleId: string;
  memberProjects: MemberProjects[];
}
