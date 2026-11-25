import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { profileImageUrl } from '../utils/profile-image';

export type HrisDepartment = {
  id: string;
  name: string;
};

export type HrisEmployee = {
  nik: string;
  name: string;
  position: string;
  photo: string | null;
};

@Injectable()
export class DailyTaskService {
  constructor(private readonly prisma: PrismaService) {}

  async departments(): Promise<HrisDepartment[]> {
    const rows = await this.prisma.$queryRaw<HrisDepartment[]>`
      WITH latest AS (
        SELECT
          tj.PegawaiIDLng,
          tj.DepartemenIDLng,
          ROW_NUMBER() OVER (
            PARTITION BY tj.PegawaiIDLng
            ORDER BY tj.PegawaiJabatanIDLng DESC
          ) AS rn
        FROM hris.dbo.tblpegawaijabatan tj
      )
      SELECT
        CONVERT(varchar(30), d.DepartemenIDLng) AS id,
        LTRIM(RTRIM(d.DepartemenStr)) AS name
      FROM hris.dbo.tbldepartemen d
      WHERE d.DepartemenStr IS NOT NULL
        AND LTRIM(RTRIM(d.DepartemenStr)) <> ''
        AND EXISTS (
          SELECT 1
          FROM latest l
          INNER JOIN hris.dbo.tblpegawai t1 ON t1.PegawaiIDLng = l.PegawaiIDLng
          WHERE l.rn = 1
            AND l.DepartemenIDLng = d.DepartemenIDLng
            AND ISNULL(t1.PegawaiNonAktifInt, 0) = 0
            AND t1.NomorIndukStr IS NOT NULL
            AND t1.NamaLengkapStr IS NOT NULL
        )
      ORDER BY d.DepartemenStr ASC
    `;
    return rows;
  }

  async employees(departmentId: string): Promise<HrisEmployee[]> {
    if (!/^\d+$/.test(departmentId)) return [];
    const rows = await this.prisma.$queryRaw<
      { nik: string; name: string; position: string; photoKey: string | null }[]
    >`
      WITH latest AS (
        SELECT
          tj.PegawaiIDLng,
          tj.DepartemenIDLng,
          tj.PangkatIDLng,
          ROW_NUMBER() OVER (
            PARTITION BY tj.PegawaiIDLng
            ORDER BY tj.PegawaiJabatanIDLng DESC
          ) AS rn
        FROM hris.dbo.tblpegawaijabatan tj
      )
      SELECT
        t1.NomorIndukStr AS nik,
        t1.NamaLengkapStr AS name,
        ISNULL(LTRIM(RTRIM(pk.PangkatStr)), '') AS position,
        ss.photoKey AS photoKey
      FROM hris.dbo.tblpegawai t1
      INNER JOIN latest l ON l.PegawaiIDLng = t1.PegawaiIDLng AND l.rn = 1
      LEFT JOIN hris.dbo.tblpangkat pk ON pk.PangkatIDLng = l.PangkatIDLng
      OUTER APPLY (
        SELECT TOP 1 LTRIM(RTRIM(ph.Photo)) AS photoKey
        FROM hris.dbo.WEB_SELF_SERVICE_PHOTO_PEGAWAI ph
        WHERE LTRIM(RTRIM(ph.NIK)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(t1.NomorIndukStr)) COLLATE DATABASE_DEFAULT
          AND LTRIM(RTRIM(ISNULL(ph.Photo, ''))) <> ''
      ) ss
      WHERE CONVERT(varchar(30), l.DepartemenIDLng) = ${departmentId}
        AND ISNULL(t1.PegawaiNonAktifInt, 0) = 0
        AND t1.NomorIndukStr IS NOT NULL
        AND t1.NamaLengkapStr IS NOT NULL
      ORDER BY
        CASE
          WHEN UPPER(LTRIM(RTRIM(pk.PangkatStr))) IN ('DIREKTUR', 'MANAGER SENIOR', 'MANAGER') THEN 0
          WHEN UPPER(LTRIM(RTRIM(pk.PangkatStr))) LIKE 'MANAGER ASS%' THEN 1
          ELSE 2
        END,
        CASE UPPER(LTRIM(RTRIM(pk.PangkatStr)))
          WHEN 'DIREKTUR' THEN 0
          WHEN 'MANAGER SENIOR' THEN 1
          WHEN 'MANAGER' THEN 2
          ELSE 3
        END,
        t1.NamaLengkapStr ASC
    `;
    return rows.map((row) => ({
      nik: row.nik,
      name: row.name,
      position: row.position,
      photo: profileImageUrl(row.photoKey),
    }));
  }
}
