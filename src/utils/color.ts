export function generateColorFromString(str: string): string {
  if (!str) return '#3B82F6';
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = (hash & 0x00ffff_ff).toString(16).toUpperCase().padStart(6, '0');
  return `#${color}`;
}
