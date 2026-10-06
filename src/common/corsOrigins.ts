export function getAllowedOrigins(): string[] {
  return [
    'https://task-manager-fe-lyart.vercel.app',
    'https://workspace.amscorp.id',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
  ].filter(Boolean) as string[];
}

export function isOriginAllowed(origin?: string | null): boolean {
  if (!origin) return true;
  return getAllowedOrigins().includes(origin) || origin.endsWith('.vercel.app');
}
