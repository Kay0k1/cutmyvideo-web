import { describe, expect, it } from 'vitest';
import { canonicalYouTubeUrl, validateMP4 } from './sourceInput';

describe('website source boundaries', () => {
  it('normalizes common YouTube sharing links without carrying playlist or tracking data', () => {
    for (const url of ['youtu.be/aqz-KE-bpKQ?si=tracking', 'http://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123', 'https://m.youtube.com/shorts/aqz-KE-bpKQ', 'youtube.com/live/aqz-KE-bpKQ']) {
      expect(canonicalYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    }
  });
  it('rejects lookalike hosts, other media URLs and credentials', () => {
    for (const url of ['https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'https://media.w3.org/trailer.mp4', 'https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com:8081/watch?v=aqz-KE-bpKQ', 'https://youtube.com/playlist?list=123']) expect(canonicalYouTubeUrl(url)).toBeNull();
  });
  it('rejects renamed non-MP4 files before uploading them', async () => {
    expect(await validateMP4(new File(['RIFFfakewav'], 'renamed.mp4', { type: 'video/mp4' }))).not.toBeNull();
    const box = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
    expect(await validateMP4(new File([box], 'video.mp4', { type: 'video/mp4' }))).toBeNull();
    expect(await validateMP4(new File([box], 'video.webm', { type: 'video/webm' }))).not.toBeNull();
  });
});
