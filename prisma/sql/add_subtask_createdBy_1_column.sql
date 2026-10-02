-- Step 1: add nullable column (existing rows stay intact)
IF COL_LENGTH('dbo.DT_SUB_TASK', 'createdBy') IS NULL
BEGIN
  ALTER TABLE dbo.DT_SUB_TASK ADD createdBy CHAR(8) NULL;
END;
