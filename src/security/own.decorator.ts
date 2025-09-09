import { SetMetadata } from '@nestjs/common';

export const OWN_KEY = 'own';
export const Own = () => SetMetadata(OWN_KEY, true);
