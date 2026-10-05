-- Step 1: add category column to DT_SECTION safely without touching any existing data
IF COL_LENGTH('dbo.DT_SECTION', 'category') IS NULL
BEGIN
  ALTER TABLE dbo.DT_SECTION ADD category VARCHAR(20) NULL;
END;
