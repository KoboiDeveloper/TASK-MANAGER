import { PrismaClient } from '@prisma/client';

const statements = [
  `IF OBJECT_ID(N'dbo.DT_KPI_METHOD', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_METHOD (
     id VARCHAR(40) NOT NULL PRIMARY KEY,
     name NVARCHAR(80) NOT NULL,
     hint NVARCHAR(400) NOT NULL,
     formula NVARCHAR(400) NOT NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_DT_KPI_METHOD_sort DEFAULT 0
   )`,
  `IF OBJECT_ID(N'dbo.DT_KPI_CATEGORY', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_CATEGORY (
     id VARCHAR(40) NOT NULL PRIMARY KEY,
     min INT NOT NULL,
     label NVARCHAR(80) NOT NULL
   )`,
  `IF OBJECT_ID(N'dbo.DT_KPI', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI (
     id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     departmentId VARCHAR(30) NULL,
     ownerNik CHAR(8) NULL,
     title NVARCHAR(500) NOT NULL,
     weight DECIMAL(6, 2) NOT NULL,
     seasonal BIT NOT NULL CONSTRAINT DF_DT_KPI_seasonal DEFAULT 0,
     breakdown NVARCHAR(MAX) NOT NULL,
     escalation NVARCHAR(MAX) NOT NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_DT_KPI_sort DEFAULT 0,
     createdBy CHAR(8) NOT NULL,
     updatedBy CHAR(8) NULL,
     createdAt DATETIME2 NOT NULL CONSTRAINT DF_DT_KPI_created DEFAULT SYSUTCDATETIME(),
     updatedAt DATETIME2 NOT NULL CONSTRAINT DF_DT_KPI_updated DEFAULT SYSUTCDATETIME()
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_departmentId_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI'))
   CREATE INDEX DT_KPI_departmentId_idx ON dbo.DT_KPI (departmentId)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_ownerNik_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI'))
   CREATE INDEX DT_KPI_ownerNik_idx ON dbo.DT_KPI (ownerNik)`,
  `IF OBJECT_ID(N'dbo.DT_KPI_TARGET', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_TARGET (
     id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     kpiId UNIQUEIDENTIFIER NOT NULL,
     text NVARCHAR(1000) NOT NULL,
     dueDate DATETIME2 NULL,
     dueDay INT NULL,
     dueMonth INT NULL,
     methodId VARCHAR(40) NULL,
     targetValue DECIMAL(12, 2) NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_DT_KPI_TARGET_sort DEFAULT 0,
     CONSTRAINT FK_DT_KPI_TARGET_kpi FOREIGN KEY (kpiId) REFERENCES dbo.DT_KPI(id) ON DELETE CASCADE,
     CONSTRAINT FK_DT_KPI_TARGET_method FOREIGN KEY (methodId) REFERENCES dbo.DT_KPI_METHOD(id)
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_TARGET_kpiId_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_TARGET'))
   CREATE INDEX DT_KPI_TARGET_kpiId_idx ON dbo.DT_KPI_TARGET (kpiId)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_TARGET_methodId_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_TARGET'))
   CREATE INDEX DT_KPI_TARGET_methodId_idx ON dbo.DT_KPI_TARGET (methodId)`,
  `IF OBJECT_ID(N'dbo.DT_KPI_ENTRY', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_ENTRY (
     id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     targetId UNIQUEIDENTIFIER NOT NULL,
     nik CHAR(8) NOT NULL,
     month CHAR(7) NOT NULL,
     realisasi NVARCHAR(100) NULL,
     note NVARCHAR(2000) NULL,
     submittedAt DATETIME2 NULL,
     CONSTRAINT FK_DT_KPI_ENTRY_target FOREIGN KEY (targetId) REFERENCES dbo.DT_KPI_TARGET(id) ON DELETE CASCADE,
     CONSTRAINT UQ_DT_KPI_ENTRY UNIQUE (targetId, nik, month)
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_ENTRY_nik_month_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_ENTRY'))
   CREATE INDEX DT_KPI_ENTRY_nik_month_idx ON dbo.DT_KPI_ENTRY (nik, month)`,
  `IF OBJECT_ID(N'dbo.DT_KPI_ENTRY_FILE', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_ENTRY_FILE (
     id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     entryId UNIQUEIDENTIFIER NOT NULL,
     url NVARCHAR(2000) NOT NULL,
     filename NVARCHAR(255) NOT NULL,
     mimeType VARCHAR(100) NOT NULL,
     bytes INT NOT NULL,
     uploadedBy CHAR(8) NOT NULL,
     uploadedAt DATETIME2 NOT NULL CONSTRAINT DF_DT_KPI_ENTRY_FILE_uploaded DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_DT_KPI_ENTRY_FILE_entry FOREIGN KEY (entryId) REFERENCES dbo.DT_KPI_ENTRY(id) ON DELETE CASCADE
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_ENTRY_FILE_entryId_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_ENTRY_FILE'))
   CREATE INDEX DT_KPI_ENTRY_FILE_entryId_idx ON dbo.DT_KPI_ENTRY_FILE (entryId)`,
  `IF OBJECT_ID(N'dbo.DT_KPI_LOG', N'U') IS NULL
   CREATE TABLE dbo.DT_KPI_LOG (
     id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
     actorNik CHAR(8) NOT NULL,
     subjectNik CHAR(8) NULL,
     departmentId VARCHAR(30) NULL,
     month CHAR(7) NULL,
     entityType VARCHAR(20) NOT NULL,
     entityId VARCHAR(40) NOT NULL,
     action VARCHAR(20) NOT NULL,
     summary NVARCHAR(400) NOT NULL,
     beforeJson NVARCHAR(MAX) NULL,
     afterJson NVARCHAR(MAX) NULL,
     createdAt DATETIME2 NOT NULL CONSTRAINT DF_DT_KPI_LOG_created DEFAULT SYSUTCDATETIME()
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_LOG_department_month_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_LOG'))
   CREATE INDEX DT_KPI_LOG_department_month_idx ON dbo.DT_KPI_LOG (departmentId, month)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_LOG_subject_month_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_LOG'))
   CREATE INDEX DT_KPI_LOG_subject_month_idx ON dbo.DT_KPI_LOG (subjectNik, month)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'DT_KPI_LOG_createdAt_idx' AND object_id = OBJECT_ID(N'dbo.DT_KPI_LOG'))
   CREATE INDEX DT_KPI_LOG_createdAt_idx ON dbo.DT_KPI_LOG (createdAt)`,
];

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log(JSON.stringify({ tables: statements.length }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
