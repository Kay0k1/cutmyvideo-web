export interface Source {
  id: string;
  title: string;
  duration_ms: number;
  kind: 'upload' | 'direct' | 'youtube' | 'platform';
  preview_url: string | null;
  embed_url: string | null;
  thumbnail_url: string | null;
  width?: number;
  height?: number;
}

export interface ClipRange {
  id: string;
  label: string;
  start_ms: number;
  end_ms: number;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Artifact {
  id: string;
  filename: string;
  size_bytes: number;
  download_url: string;
  actual_start_ms: number;
  actual_end_ms: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  stage: string;
  message: string;
  items: {
    id: string;
    label: string;
    start_ms: number;
    end_ms: number;
    status: JobStatus;
    message?: string;
    artifact: Artifact | null;
  }[];
}

export interface OutputSettings {
  format: 'mp4' | 'mp3';
  quality: '1080p' | '720p' | 'best';
  cut_mode: 'accurate' | 'copy';
}
