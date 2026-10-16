import { ApiError, request } from './api';
import type { Artifact } from './types';
export interface CollectionSubtitles { format: 'srt' | 'vtt'; text: string; name: string; }
export const subtitleInputLimit = 512 * 1024;
export async function readCollectionSubtitles(file: File): Promise<CollectionSubtitles> {
  const format = file.name.toLowerCase().split('.').at(-1);
  if (format !== 'srt' && format !== 'vtt') throw new Error('Выберите готовый файл SRT или VTT.');
  if (!file.size || file.size > subtitleInputLimit) throw new Error('Файл субтитров должен быть не больше 512 КБ.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new Error('Сохраните субтитры в кодировке UTF-8.'); }
  return { format, text, name: file.name.split(/[\\/]/).at(-1)!.slice(0, 200) };
}
export async function retimeCollectionSubtitles(clipID: string, artifact: Artifact, subtitles: CollectionSubtitles): Promise<{ text: string; format: 'srt' | 'vtt' }> {
  if (!artifact.segments?.length) throw new Error('У файла нет карты исходных интервалов для субтитров.');
  const response = await request<{ outputs: { clip_id: string; text: string; format: 'srt' | 'vtt'; sha256: string }[] }>('/subtitles/retime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, format: subtitles.format, text: subtitles.text, outputs: [{ clip_id: clipID, segments: artifact.segments }] }) });
  const output = response.outputs?.[0];
  if (response.outputs?.length !== 1 || output.clip_id !== clipID || !['srt', 'vtt'].includes(output.format) || typeof output.text !== 'string' || new TextEncoder().encode(output.text).length > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(output.sha256)) throw new ApiError('invalid_response', 'Invalid subtitle response');
  return { text: output.text, format: output.format };
}
