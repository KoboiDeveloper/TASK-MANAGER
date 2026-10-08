export function getAllowedOrigins(): string[] {
  return [
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    'http://localhost:3000',
    'https://cloud.amscorp.id',
    'https://workspace.amscorp.id',
    process.env.FRONTEND_URL,
    process.env.CLOUD_FRONTEND_URL,
  ].filter(Boolean) as string[];
}

export function isOriginAllowed(origin?: string | null): boolean {
  if (!origin) return true;
  if (
    getAllowedOrigins().includes(origin) ||
    origin.endsWith('.vercel.app') ||
    origin === 'https://amscorp.id' ||
    origin.endsWith('.amscorp.id')
  ) {
    return true;
  }
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  } catch {
    return false;
  }
  return false;
}
