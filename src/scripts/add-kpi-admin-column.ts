import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`
      IF COL_LENGTH('dbo.DT_USER', 'kpiAdmin') IS NULL
      ALTER TABLE dbo.DT_USER ADD kpiAdmin BIT NOT NULL CONSTRAINT DF_DT_USER_kpiAdmin DEFAULT 0
    `);
    const rows = await prisma.$queryRawUnsafe<{ ready: number }[]>(`
      SELECT CASE WHEN COL_LENGTH('dbo.DT_USER', 'kpiAdmin') IS NULL THEN 0 ELSE 1 END AS ready
    `);
    console.log(JSON.stringify(rows[0]));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
