export function takeStr(s: string | null | undefined, n: number): string | null {
  if (s == null) return null;
  const t = s;
  return t.length > n ? t.slice(0, n) : t;
}

export function normalizeErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}
