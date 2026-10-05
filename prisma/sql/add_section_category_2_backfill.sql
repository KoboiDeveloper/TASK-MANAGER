-- Step 2: backfill existing rows based on section name (zero data loss)
UPDATE dbo.DT_SECTION
SET category = 'done'
WHERE (category IS NULL OR category = 'active' OR category = '')
  AND (
    LOWER(name) LIKE '%complete%' OR
    LOWER(name) LIKE '%done%' OR
    LOWER(name) LIKE '%selesai%' OR
    LOWER(name) LIKE '%closed%' OR
    LOWER(name) LIKE '%finish%' OR
    LOWER(name) LIKE '%tuntas%' OR
    LOWER(name) LIKE '%beres%' OR
    LOWER(name) LIKE '%resolved%'
  );

UPDATE dbo.DT_SECTION
SET category = 'not_started'
WHERE (category IS NULL OR category = '')
  AND (
    LOWER(name) LIKE '%to do%' OR
    LOWER(name) LIKE '%todo%' OR
    LOWER(name) LIKE '%backlog%'
  );

UPDATE dbo.DT_SECTION
SET category = 'active'
WHERE category IS NULL OR category = '';

-- Add default constraint for future inserts
IF NOT EXISTS (
  SELECT 1 FROM sys.default_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.DT_SECTION')
    AND parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.DT_SECTION'), 'category', 'ColumnId')
)
BEGIN
  ALTER TABLE dbo.DT_SECTION
    ADD CONSTRAINT DF_DT_SECTION_category DEFAULT 'active' FOR category;
END;
