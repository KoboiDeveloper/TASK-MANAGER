import { pickActiveAfterDisconnect } from './mailbox-active.util';

describe('pickActiveAfterDisconnect', () => {
  const t = (email: string, createdAt: string) => ({
    zimbraEmail: email,
    createdAt: new Date(createdAt),
  });

  it('returns null when no remaining accounts', () => {
    expect(pickActiveAfterDisconnect([])).toBeNull();
  });

  it('returns the only remaining account', () => {
    expect(pickActiveAfterDisconnect([t('a@x.com', '2026-01-01')])).toBe('a@x.com');
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
});
