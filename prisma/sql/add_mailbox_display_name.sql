-- Store Zimbra display name on mailbox credential
IF COL_LENGTH('dbo.DT_MAILBOX_CREDENTIAL', 'displayName') IS NULL
BEGIN
  ALTER TABLE dbo.DT_MAILBOX_CREDENTIAL ADD displayName NVARCHAR(255) NULL;
END
GO
