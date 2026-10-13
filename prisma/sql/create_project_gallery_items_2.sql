-- Step 2: backfill orphan files into items + FK

IF OBJECT_ID('dbo.DT_PROJECT_GALLERY_FILE', 'U') IS NOT NULL
  AND COL_LENGTH('dbo.DT_PROJECT_GALLERY_FILE', 'itemId') IS NOT NULL
BEGIN
  DECLARE @id UNIQUEIDENTIFIER, @projectId UNIQUEIDENTIFIER, @viewId UNIQUEIDENTIFIER,
          @filename NVARCHAR(255), @createdBy CHAR(8), @note NVARCHAR(500), @createdAt DATETIME2;

  DECLARE orphan_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT id, projectId, viewId, filename, createdBy, note, createdAt
    FROM dbo.DT_PROJECT_GALLERY_FILE
    WHERE itemId IS NULL;

  OPEN orphan_cursor;
  FETCH NEXT FROM orphan_cursor INTO @id, @projectId, @viewId, @filename, @createdBy, @note, @createdAt;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    DECLARE @itemId UNIQUEIDENTIFIER = NEWID();
    INSERT INTO dbo.DT_PROJECT_GALLERY_ITEM (id, projectId, viewId, title, description, createdBy, createdAt, updatedAt)
    VALUES (@itemId, @projectId, @viewId, LEFT(@filename, 200), @note, @createdBy, @createdAt, @createdAt);

    UPDATE dbo.DT_PROJECT_GALLERY_FILE SET itemId = @itemId, sortOrder = 0 WHERE id = @id;

    FETCH NEXT FROM orphan_cursor INTO @id, @projectId, @viewId, @filename, @createdBy, @note, @createdAt;
  END
  CLOSE orphan_cursor;
  DEALLOCATE orphan_cursor;
END;

IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_DT_PROJECT_GALLERY_FILE_project')
BEGIN
  ALTER TABLE dbo.DT_PROJECT_GALLERY_FILE DROP CONSTRAINT FK_DT_PROJECT_GALLERY_FILE_project;
END;

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_DT_PROJECT_GALLERY_FILE_item')
BEGIN
  DELETE FROM dbo.DT_PROJECT_GALLERY_FILE WHERE itemId IS NULL;
  ALTER TABLE dbo.DT_PROJECT_GALLERY_FILE ALTER COLUMN itemId UNIQUEIDENTIFIER NOT NULL;

  ALTER TABLE dbo.DT_PROJECT_GALLERY_FILE WITH CHECK
  ADD CONSTRAINT FK_DT_PROJECT_GALLERY_FILE_item
  FOREIGN KEY (itemId) REFERENCES dbo.DT_PROJECT_GALLERY_ITEM(id) ON DELETE CASCADE;

  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DT_PROJECT_GALLERY_FILE_itemId' AND object_id = OBJECT_ID('dbo.DT_PROJECT_GALLERY_FILE'))
    CREATE INDEX IX_DT_PROJECT_GALLERY_FILE_itemId ON dbo.DT_PROJECT_GALLERY_FILE(itemId, sortOrder);
END;

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_DT_PROJECT_GALLERY_FILE_project')
BEGIN
  ALTER TABLE dbo.DT_PROJECT_GALLERY_FILE WITH CHECK
  ADD CONSTRAINT FK_DT_PROJECT_GALLERY_FILE_project
  FOREIGN KEY (projectId) REFERENCES dbo.DT_PROJECT(id) ON DELETE NO ACTION;
END;
