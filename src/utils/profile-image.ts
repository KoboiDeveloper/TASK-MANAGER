const PROFILE_IMAGE_BASE = 'https://web.amscorp.id:3060/ImageProfile/';

export function profileImageUrl(photo: string | null | undefined): string | null {
  const trimmed = photo?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return PROFILE_IMAGE_BASE + encodeURIComponent(trimmed);
}
