import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// import { CreateProjectRequest } from './dto/request';

// interface IProjectService {
//   create(nik: string, data: CreateProjectRequest): Promise<string>;
// }

@Injectable()
export class ProjectService {
  constructor(private readonly prismaService: PrismaService) {}

  // create(nik: string,data: CreateProjectRequest): Promise<string> {
  //   return Promise.resolve('');
  // }
}
