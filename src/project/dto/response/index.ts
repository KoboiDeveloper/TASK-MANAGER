import { LOG_ACTIVITY } from '@prisma/client';

export type ProjectMemberFlat = {
  nik: string;
  role: string;
  nama: string;
};

export type ProjectDetail = {
  id: string;
  name: string;
  desc: string | null;
  members: ProjectMemberFlat[];
  activities: LOG_ACTIVITY[] | null;
};
type Assignees = {
  nik: string;
  name: string;
  assignedAt: Date;
};
export type TaskNonSection = {
  id: string;
  name: string;
  desc: string | null;
  dueDate: Date | null;
  status: boolean;
  assignees: Assignees[];
  creator: { nama: string };
};
export type SectionGroup = {
  id: string;
  name: string;
  tasks: TaskNonSection[];
};
export type TaskSectionResponse = {
  unlocated: TaskNonSection[];
  sections: SectionGroup[];
};
