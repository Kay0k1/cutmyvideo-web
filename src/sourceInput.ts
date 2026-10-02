/** The website accepts video links from genuine YouTube hosts only. */
export function canonicalYouTubeUrl(value: string): string | null {
  let parsed: URL;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try { parsed = new URL(candidate); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) return null;
  if (parsed.search.includes(';') || /%(?![a-fA-F0-9]{2})/.test(parsed.search)) return null;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
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
