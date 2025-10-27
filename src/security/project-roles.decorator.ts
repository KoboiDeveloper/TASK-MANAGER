import { SetMetadata } from '@nestjs/common';
import { EProjectRole } from '../constant/EProjectRole';

export const PROJECT_ROLES_KEY = 'project_roles';

/**
 * @ProjectRoles() digunakan untuk membatasi endpoint berdasarkan role di project.
 *
 * Contoh:
 *   @ProjectRoles(EProjectRole.OWNER, EProjectRole.EDITOR)
 */
export const ProjectRoles = (...roles: EProjectRole[]) => SetMetadata(PROJECT_ROLES_KEY, roles);
