import {
  GOOGLE_SCOPES,
  hasCalendarScope,
  hasDriveReadonlyScope,
  hasDriveScope,
  hasGmailScope,
} from './google-oauth.client';

describe('Google OAuth scopes', () => {
  it('GOOGLE_SCOPES includes calendar, gmail.modify, drive.file, and drive.readonly', () => {
    expect(GOOGLE_SCOPES).toContain('auth/calendar');
    expect(GOOGLE_SCOPES).toContain('gmail.modify');
    expect(GOOGLE_SCOPES).toContain('drive.file');
    expect(GOOGLE_SCOPES).toContain('drive.readonly');
  });

  describe('hasGmailScope', () => {
    it('returns false for empty scope', () => {
      expect(hasGmailScope(null)).toBe(false);
      expect(hasGmailScope('')).toBe(false);
    });

    it('detects gmail.modify and readonly', () => {
      expect(hasGmailScope('https://www.googleapis.com/auth/gmail.modify')).toBe(
        true,
      );
      expect(
        hasGmailScope('https://www.googleapis.com/auth/gmail.readonly'),
      ).toBe(true);
    });

    it('detects calendar-only as missing gmail', () => {
      expect(
        hasGmailScope('openid https://www.googleapis.com/auth/calendar'),
      ).toBe(false);
    });
  });

  describe('hasDriveScope', () => {
    it('detects drive.file', () => {
      expect(
        hasDriveScope('https://www.googleapis.com/auth/drive.file'),
      ).toBe(true);
    });

    it('returns false without drive', () => {
      expect(
        hasDriveScope('https://www.googleapis.com/auth/gmail.modify'),
      ).toBe(false);
    });
  });

  describe('hasDriveReadonlyScope', () => {
    it('rejects drive.file alone', () => {
      expect(
        hasDriveReadonlyScope('https://www.googleapis.com/auth/drive.file'),
      ).toBe(false);
    });

    it('detects drive.readonly', () => {
      expect(
        hasDriveReadonlyScope(
          'https://www.googleapis.com/auth/drive.readonly',
        ),
      ).toBe(true);
    });
  });

  describe('hasCalendarScope', () => {
    it('returns false for empty scope', () => {
      expect(hasCalendarScope(undefined)).toBe(false);
    });

    it('detects calendar scope', () => {
      expect(
        hasCalendarScope('openid https://www.googleapis.com/auth/calendar'),
      ).toBe(true);
    });

    it('detects gmail-only as missing calendar', () => {
      expect(
        hasCalendarScope('https://www.googleapis.com/auth/gmail.modify'),
      ).toBe(false);
    });
  });
});
