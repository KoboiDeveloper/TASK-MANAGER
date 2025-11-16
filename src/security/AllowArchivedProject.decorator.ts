// src/auth/allow-archived-project.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const ALLOW_ARCHIVED_PROJECT_KEY = 'allowArchivedProject';

export const AllowArchivedProject = () => SetMetadata(ALLOW_ARCHIVED_PROJECT_KEY, true);
