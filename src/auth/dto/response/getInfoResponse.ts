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
  photo: string | null;
  email: string | null;
  setupStep: 'email' | 'password' | null;
  memberProjects: MemberProjects[];
}
