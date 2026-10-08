-- Multi-account mailbox: UUID PK + activeZimbraEmail on DT_USER
-- Run against SQL Server after backup.

-- 1) User.activeZimbraEmail
IF COL_LENGTH('dbo.DT_USER', 'activeZimbraEmail') IS NULL
BEGIN
  ALTER TABLE dbo.DT_USER ADD activeZimbraEmail NVARCHAR(255) NULL;
END
GO

-- 2) Add id column if missing
IF COL_LENGTH('dbo.DT_MAILBOX_CREDENTIAL', 'id') IS NULL
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ADD id VARCHAR(36) NULL;
END
GO

-- 3) Backfill ids
UPDATE dbo.DT_MAILBOX_CREDENTIAL
SET id = LOWER(CONVERT(VARCHAR(36), NEWID()))
WHERE id IS NULL;
GO

-- 4) Backfill active from existing single credential
UPDATE u
SET u.activeZimbraEmail = c.zimbraEmail
FROM dbo.DT_USER u
INNER JOIN dbo.DT_MAILBOX_CREDENTIAL c ON c.nik = u.nik
WHERE u.activeZimbraEmail IS NULL;
GO

-- 5) Drop old PK (name may vary — inspect if fails)
DECLARE @pk NVARCHAR(200);
SELECT @pk = kc.name
FROM sys.key_constraints kc
WHERE kc.parent_object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL') AND kc.type = 'PK';
IF @pk IS NOT NULL
  EXEC('ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL DROP CONSTRAINT [' + @pk + ']');
GO

IF COL_LENGTH('dbo.DT_MAILBOX_CREDENTIAL', 'id') IS NOT NULL
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ALTER COLUMN id VARCHAR(36) NOT NULL;
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.key_constraints kc
  WHERE kc.parent_object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL') AND kc.type = 'PK'
)
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ADD CONSTRAINT PK_DT_MAILBOX_CREDENTIAL PRIMARY KEY (id);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'UQ_DT_MAILBOX_CREDENTIAL_nik_email'
    AND object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL')
)
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL
    ADD CONSTRAINT UQ_DT_MAILBOX_CREDENTIAL_nik_email UNIQUE (nik, zimbraEmail);
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_DT_MAILBOX_CREDENTIAL_nik'
    AND object_id = OBJECT_ID('dbo.DT_MAILBOX_CREDENTIAL')
)
BEGIN
  CREATE INDEX IX_DT_MAILBOX_CREDENTIAL_nik ON dbo.DT_MAILBOX_CREDENTIAL(nik);
END
GO
