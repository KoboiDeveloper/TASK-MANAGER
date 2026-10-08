export type MailboxAccountRow = {
  zimbraEmail: string;
  createdAt: Date;
};

/** After deleting the active account: newest remaining by createdAt, or null. */
export function pickActiveAfterDisconnect(
  remaining: MailboxAccountRow[],
): string | null {
  if (!remaining.length) return null;
  const sorted = [...remaining].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return sorted[0].zimbraEmail;
}

export function normalizeMailboxEmail(email: string): string {
  return email.trim().toLowerCase();
}
