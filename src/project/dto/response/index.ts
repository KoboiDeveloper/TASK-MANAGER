import { LOG_ACTIVITY } from '@prisma/client';

export type ProjectMemberFlat = {
  nik: string;
  role: string;
  nama: string;
  photo?: string | null;
};

export type ProjectDetail = {
  id: string;
  name: string;
  desc: string | null;
  color?: string | null;
  icon?: string | null;
  views?: string | null;
  isPrivate?: boolean;
  defaultPermission?: string;
  createdBy?: string;
  createdAt?: Date;
  isArchive?: boolean;
  members: ProjectMemberFlat[];
  activities: LOG_ACTIVITY[] | null;
};
type Assignees = {
  nik: string;
  nama: string;
  photo?: string | null;
};
export type SubTask = {
  id: string;
  name: string;
  dueDate: Date | null;
  status: boolean;
  assignees: Assignees[];
};

export type AttachmentTask = {
  id: string;
  taskId: string | null;
  url: string;
  filename: string;
  mimeType: string;
};

export type TaskNonSection = {
  id: string;
  name: string;
  desc: string | null;
  dueDate: Date | null;
  status: boolean;
  assignees: Assignees[];
  creator: { nama: string };
  subTask: SubTask[];
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

export type ownTaskResponse = {
  id: string;
  name: string;
  status: boolean;
  dueDate: Date | null;
  project: {
    id: string;
    name: string;
    color: string | null;
  };
};
