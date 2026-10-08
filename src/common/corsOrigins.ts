export function getAllowedOrigins(): string[] {
  return [
    'https://task-manager-fe-lyart.vercel.app',
    'https://workspace.amscorp.id',
    'https://cloud.amscorp.id',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3100',
    'http://127.0.0.1:3100',
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
  // Dev: FE di LAN IP (http://192.168.x.x:3000) upload langsung ke BE :1000
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // private LAN
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  } catch {
    return false;
  }
  return false;
}
