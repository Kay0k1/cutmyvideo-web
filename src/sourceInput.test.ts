import { describe, expect, it, vi } from 'vitest';
import { canonicalSourceUrl, canonicalYouTubeUrl, validateVideo, videoProvider, videoProviders } from './sourceInput';

describe('website source boundaries', () => {
  it('normalizes common YouTube sharing links without carrying playlist or tracking data', () => {
    for (const url of ['youtu.be/aqz-KE-bpKQ?si=tracking', 'http://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123', 'https://m.youtube.com/shorts/aqz-KE-bpKQ', 'youtube.com/live/aqz-KE-bpKQ', '//youtube.com/watch?v=aqz-KE-bpKQ', 'https://www.youtube.com./watch?v=aqz-KE-bpKQ', 'https://youtube-nocookie.com/embed/aqz-KE-bpKQ', 'https://youtu.be/%61qz-KE-bpKQ', 'https://youtube.com/%77atch?v=aqz-KE-bpKQ']) {
      expect(canonicalYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    }
  });
  it('rejects lookalike hosts, other media URLs and credentials', () => {
    for (const url of ['https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'https://media.w3.org/trailer.mp4', 'https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com:8081/watch?v=aqz-KE-bpKQ', 'https://youtube.com/playlist?list=123', 'https://youtu.be/aqz-KE-bpKQ/extra', 'youtube.com/shorts/aqz-KE-bpKQ/extra', 'https://youtube.com/watch?v=aqz-KE-bpKQ&v=other123456', 'https://@youtube.com/watch?v=aqz-KE-bpKQ', 'https://:@youtube.com/watch?v=aqz-KE-bpKQ']) expect(canonicalYouTubeUrl(url)).toBeNull();
  });
  it('rejects renamed non-MP4 files before uploading them', async () => {
    expect(await validateVideo(new File(['RIFFfakewav'], 'renamed.mp4', { type: 'video/mp4' }))).not.toBeNull();
    expect(await validateVideo(new File([new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112])], 'fake.mp4', { type: 'video/mp4' }))).not.toBeNull();
    const box = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
    expect(await validateVideo(new File([box], 'video.mp4', { type: 'video/mp4' }))).toBeNull();
    expect(await validateVideo(new File([box], 'video.webm', { type: 'video/webm' }))).not.toBeNull();
  });

  it('recognizes fifteen services and normalizes copied platform links', () => {
    const links: Record<string, string> = {
      youtube: 'm.youtube.com/shorts/aqz-KE-bpKQ?si=tracking',
      twitch: 'www.twitch.tv/videos/12345678',
      rutube: 'rutube.ru/video/abcdef0123456789abcdef0123456789/',
      tiktok: 'vm.tiktok.com/abc123/',
      instagram: 'www.instagram.com/reel/AbCdEf12345/',
      vimeo: 'player.vimeo.com/video/12345678',
      dailymotion: 'dai.ly/x123abc',
      vk: 'vkvideo.ru/video-123_456',
      facebook: 'fb.watch/abc123/',
      x: 'x.com/example/status/12345678',
      reddit: 'www.reddit.com/r/example/comments/abc123/video/',
      ok: 'ok.ru/video/12345678',
      bilibili: 'b23.tv/abc123',
      streamable: 'streamable.com/abc123',
      rumble: 'rumble.com/v123abc-example.html',
    };
    expect(videoProviders).toHaveLength(15);
    for (const [id, value] of Object.entries(links)) {
      expect(videoProvider(value)?.id).toBe(id);
      expect(canonicalSourceUrl(value)).toMatch(/^https:\/\//);
    }
    expect(canonicalSourceUrl('http://m.twitch.tv/videos/12345678#t=1h')).toBe('https://m.twitch.tv/videos/12345678');
    expect(canonicalSourceUrl(links.youtube)).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  });

  it('preserves signed generic media URLs and does not mislabel unrelated hosts', () => {
    const url = 'https://cdn.example.com/interview.mp4?token=abc%2Fdef&expires=123&part=2';
    expect(canonicalSourceUrl(url + '#position')).toBe(url);
    expect(videoProvider(url)).toBeNull();
    for (const host of ['twitch.tv.evil.test', 'notinstagram.com', 'youtube.com.evil.test', 'rutube.ru.evil.test']) {
      expect(videoProvider(`https://${host}/video`)).toBeNull();
    }
    expect(videoProvider('https://CLIPS.TWITCH.TV./SomeClip')?.id).toBe('twitch');
  });

  it('does not send malformed or credential-bearing links to the core', () => {
    for (const value of ['', 'not a url', 'ftp://example.com/video', 'javascript:alert(1)', 'https://user:pass@twitch.tv/videos/1', 'https://@rutube.ru/video/1', 'https://twitch.tv:8080/videos/1', 'http://cdn.example.com/video.mp4', 'https://twit\nch.tv/videos/1', 'https://youtube.com/playlist?list=1', 'https://youtu.be/invalid', 'https://example.com/' + 'a'.repeat(8192)]) {
      expect(canonicalSourceUrl(value)).toBeNull();
    }
  });

  it('rejects whitespace in a host while retaining video paths and signed queries', () => {
    for (const value of ['not a valid URL', 'https://not a valid URL/video', 'https://cdn\u00a0.example.com/video.mp4']) {
      expect(canonicalSourceUrl(value)).toBeNull();
    }
    expect(canonicalSourceUrl('https://cdn.example.com/my interview.mp4?token=abc%2Fdef&title=my%20video'))
      .toBe('https://cdn.example.com/my%20interview.mp4?token=abc%2Fdef&title=my%20video');
  });
});

describe('live upload byte limits', () => {
  it('accepts supported containers with generic MIME types and rejects renamed documents', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
    for (const ext of ['mp4', 'mov']) await expect(validateVideo(new File([mp4], `recording.${ext}`, { type: 'application/octet-stream' }))).resolves.toBeNull();
    for (const ext of ['mkv', 'webm']) await expect(validateVideo(new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])], `recording.${ext}`))).resolves.toBeNull();
    for (const ext of ['mp4', 'mov', 'mkv', 'webm']) await expect(validateVideo(new File(['<html>Not a video</html>'], `recording.${ext}`))).resolves.not.toBeNull();
  });
  it('rejects a file exceeding the session policy before inspecting its bytes', async () => {
    const inspect = vi.fn();
    const file = { size: 1025, name: 'video.mp4', type: 'video/mp4', slice: inspect } as unknown as File;
    await expect(validateVideo(file, 1024)).resolves.toBe('Файл превышает лимит сервиса. Выберите файл меньшего размера.');
    expect(inspect).not.toHaveBeenCalled();
  });
});
