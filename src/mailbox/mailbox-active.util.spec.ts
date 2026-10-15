import { pickActiveAfterDisconnect } from './mailbox-active.util';

describe('pickActiveAfterDisconnect', () => {
  const t = (
    email: string,
    createdAt: string,
    provider?: 'zimbra' | 'gmail',
  ) => ({
    email,
    createdAt: new Date(createdAt),
    ...(provider ? { provider } : {}),
  });

  it('returns null when no remaining accounts', () => {
    expect(pickActiveAfterDisconnect([])).toBeNull();
  });

  it('returns the only remaining account', () => {
    expect(pickActiveAfterDisconnect([t('a@x.com', '2026-01-01')])).toBe(
      'a@x.com',
    );
  });

  it('returns newest by createdAt among remaining', () => {
    expect(
      pickActiveAfterDisconnect([
        t('old@x.com', '2026-01-01T00:00:00Z'),
        t('new@x.com', '2026-06-01T00:00:00Z'),
        t('mid@x.com', '2026-03-01T00:00:00Z'),
      ]),
    ).toBe('new@x.com');
  });

  it('picks newest across mixed zimbra and gmail providers', () => {
    expect(
      pickActiveAfterDisconnect([
        t('zimbra@x.com', '2026-01-01T00:00:00Z', 'zimbra'),
        t('gmail@x.com', '2026-08-01T00:00:00Z', 'gmail'),
        t('older-gmail@x.com', '2026-02-01T00:00:00Z', 'gmail'),
      ]),
    ).toBe('gmail@x.com');
  });

  it('picks remaining zimbra when newer gmail is gone', () => {
    expect(
      pickActiveAfterDisconnect([
        t('zimbra@x.com', '2026-03-01T00:00:00Z', 'zimbra'),
        t('old-gmail@x.com', '2026-01-01T00:00:00Z', 'gmail'),
      ]),
    ).toBe('zimbra@x.com');
  });
});
