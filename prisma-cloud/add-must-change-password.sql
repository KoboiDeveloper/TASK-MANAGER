IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'dbo.DT_USER') AND name = 'mustChangePassword'
)
BEGIN
  ALTER TABLE dbo.DT_USER ADD mustChangePassword BIT NOT NULL CONSTRAINT DF_DT_USER_mustChangePassword DEFAULT 0;
END
