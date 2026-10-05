import { LOG_ACTIVITY } from '@prisma/client';

export type ProjectMemberFlat = {
  nik: string;
  role: string;
  nama: string;
  photo?: string | null;
};

export type ViewItem = {
  id: string;
  projectId: string;
  name: string;
  type: string;
  rank: string;
  shortId?: string | null;
  settings?: string | null;
};

export type ActivityResponse = {
  id: string;
  projectId: string;
  taskid?: string | null;
  nik: string;
  action: string;
  details?: string | null;
  createdAt: Date | string;
  user?: {
    nik: string;
    nama: string;
    photo?: string | null;
  } | null;
};

export type ProjectDetail = {
  id: string;
  shortId?: string | null;
  name: string;
  desc: string | null;
  color?: string | null;
  icon?: string | null;
  views?: ViewItem[] | string | null;
  isPrivate?: boolean;
  defaultPermission?: string;
  createdBy?: string;
  createdAt?: Date;
  isArchive?: boolean;
  members: ProjectMemberFlat[];
  activities: ActivityResponse[] | null;
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
  doneDate?: Date | string | null;
  createdAt?: Date | string | null;
  createdBy?: string | null;
  creator?: { nik?: string; nama: string; photo?: string | null } | null;
  assignees: Assignees[];
  customFields?: string | null;
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
  shortId?: string | null;
  name: string;
  desc: string | null;
  dueDate: Date | null;
  status: boolean;
  doneDate?: Date | string | null;
  createdAt?: Date | string | null;
  id_dt_view?: string | null;
  view?: { id: string; name: string; type: string; shortId?: string | null } | null;
  assignees: Assignees[];
  creator: { nik?: string; nama: string; photo?: string | null };
  subTask: SubTask[];
  customFields?: string | null;
};
export type SectionGroup = {
  id: string;
  name: string;
  category?: string;
  rank?: string;
  tasks: TaskNonSection[];
};
export type TaskSectionResponse = {
  unlocated: TaskNonSection[];
  sections: SectionGroup[];
};

export type ownTaskResponse = {
  id: string;
  shortId?: string | null;
  name: string;
  status: boolean;
  dueDate: Date | null;
  project: {
    id: string;
    shortId?: string | null;
    name: string;
    color: string | null;
  };
};
