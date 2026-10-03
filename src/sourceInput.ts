export const videoProviders = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { id: 'twitch', name: 'Twitch', hosts: ['twitch.tv'] },
  { id: 'rutube', name: 'Rutube', hosts: ['rutube.ru'] },
  { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com'] },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com'] },
  { id: 'vimeo', name: 'Vimeo', hosts: ['vimeo.com'] },
  { id: 'dailymotion', name: 'Dailymotion', hosts: ['dailymotion.com', 'dai.ly'] },
  { id: 'vk', name: 'VK Видео', hosts: ['vk.com', 'vk.ru', 'vkvideo.ru', 'vkvideo.com'] },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch'] },
  { id: 'x', name: 'X / Twitter', hosts: ['x.com', 'twitter.com', 't.co'] },
  { id: 'reddit', name: 'Reddit', hosts: ['reddit.com', 'redd.it'] },
  { id: 'ok', name: 'Одноклассники', hosts: ['ok.ru'] },
  { id: 'bilibili', name: 'Bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  { id: 'streamable', name: 'Streamable', hosts: ['streamable.com'] },
  { id: 'rumble', name: 'Rumble', hosts: ['rumble.com'] },
] as const;

export type VideoProvider = typeof videoProviders[number];

function pastedURL(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  const authority = candidate.split('://')[1]?.split(/[/?#]/)[0] ?? '';
  if (authority.includes('@') || /\s/.test(authority)) return null;
  try {
    const parsed = new URL(candidate);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null;
    return parsed;
  } catch { return null; }
}

function providerForHost(hostname: string): VideoProvider | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return videoProviders.find(provider => provider.hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) ?? null;
}

/** Recognition is a display hint. The core validates and resolves the real video. */
export function videoProvider(value: string): VideoProvider | null {
  const parsed = pastedURL(value);
  return parsed ? providerForHost(parsed.hostname) : null;
}

export function providerName(id: string | undefined): string | null {
  return videoProviders.find(provider => provider.id === id)?.name ?? null;
}

/** Keep unknown HTTPS links intact: CDN signatures and generic extractors need their query. */
export function canonicalSourceUrl(value: string): string | null {
  const parsed = pastedURL(value);
  if (!parsed) return null;
  const provider = providerForHost(parsed.hostname);
  if (provider?.id === 'youtube') return canonicalYouTubeUrl(value);
  if (parsed.protocol === 'http:' && !provider) return null;
  parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  parsed.hash = '';
  return parsed.href;
}

/** Canonical video links from genuine YouTube hosts only. */
export function canonicalYouTubeUrl(value: string): string | null {
  let parsed: URL;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  if (candidate.split('://')[1]?.split(/[/?#]/)[0].includes('@')) return null;
  try { parsed = new URL(candidate); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) return null;
  if (parsed.search.includes(';') || /%(?![a-fA-F0-9]{2})/.test(parsed.search)) return null;
  let path: string;
  try { path = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, ''); } catch { return null; }
  const parts = path.split('/');
  let id: string | null = null;
  if (host.endsWith('youtu.be') && parts.length === 1) id = parts[0];
  else if (host.endsWith('youtube-nocookie.com')) { if (parts.length === 2 && parts[0] === 'embed') id = parts[1]; }
  else if (path === 'watch') { const values = parsed.searchParams.getAll('v'); if (values.length === 1) id = values[0]; }
  else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** A light container check; the core still validates the media streams. */
export async function validateMP4(file: File): Promise<string | null> {
  if (file.size > 1024 ** 3) return 'Файл больше 1 ГБ. Выберите видео меньшего размера.';
  if (!/\.mp4$/i.test(file.name) || (file.type && !['video/mp4', 'application/mp4'].includes(file.type))) return 'Выберите файл MP4. Другие форматы пока не поддерживаются на сайте.';
  if (!file.size) return 'Файл пустой. Выберите другое видео MP4.';
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === 'ftyp' && length >= 16 && length <= file.size - offset && offset + 16 <= bytes.length) {
      const brand = String.fromCharCode(...bytes.slice(offset + 8, offset + 12));
      if (brand === 'qt  ') return 'Этот файл похож на MOV. Сохраните его как MP4 и попробуйте снова.';
      return null;
    }
    if (length < 8) break;
    offset += length;
  }
  return 'В файле не найден контейнер MP4. Проверьте файл; смена расширения не меняет формат.';
}
