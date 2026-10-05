-- Add notificationPrefs column to DT_USER safely
IF COL_LENGTH('dbo.DT_USER', 'notificationPrefs') IS NULL
BEGIN
  ALTER TABLE dbo.DT_USER ADD notificationPrefs NVARCHAR(MAX) NULL;
END;
