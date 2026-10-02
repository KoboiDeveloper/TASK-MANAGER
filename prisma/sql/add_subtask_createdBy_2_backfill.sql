-- Step 2: backfill + index + FK (run after step 1)
UPDATE st
SET st.createdBy = t.createdBy
FROM dbo.DT_SUB_TASK st
INNER JOIN dbo.DT_TASK t ON t.id = st.id_dt_task
WHERE st.createdBy IS NULL
  AND t.createdBy IS NOT NULL;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'DT_SUB_TASK_createdBy_idx'
    AND object_id = OBJECT_ID('dbo.DT_SUB_TASK')
)
BEGIN
  CREATE INDEX DT_SUB_TASK_createdBy_idx ON dbo.DT_SUB_TASK (createdBy);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys
  WHERE name = 'DT_SUB_TASK_createdBy_fkey'
)
BEGIN
  ALTER TABLE dbo.DT_SUB_TASK
    ADD CONSTRAINT DT_SUB_TASK_createdBy_fkey
    FOREIGN KEY (createdBy) REFERENCES dbo.DT_USER (nik)
    ON DELETE NO ACTION
    ON UPDATE NO ACTION;
END;
