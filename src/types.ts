export interface Source {
  id: string;
  title: string;
  duration_ms: number;
  kind: 'upload' | 'direct' | 'youtube' | 'platform';
  preview_url: string | null;
  embed_url: string | null;
  thumbnail_url: string | null;
  provider?: string;
  provider_video_id?: string | null;
  source_url?: string | null;
  preview_kind?: 'native' | 'youtube' | 'none';
  width?: number;
  height?: number;
  expires_at?: string | null;
  retention_blocked?: boolean;
}

export interface ClipRange {
  id: string;
  label: string;
  start_ms: number;
  end_ms: number;
}

export type JobStatus = 'queued' | 'waiting_storage' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Artifact {
  id: string;
  filename: string;
  size_bytes: number;
  download_url: string;
  actual_start_ms: number;
  actual_end_ms: number;
  expires_at?: string | null;
}

export interface Job {
  id: string;
  status: JobStatus;
  stage: string;
  message: string;
  storage_wait_until?: string | null;
  items: {
    id: string;
    label: string;
    start_ms: number;
    end_ms: number;
    status: JobStatus;
    progress_ms?: number;
    message?: string;
    error_code?: string;
    artifact: Artifact | null;
  }[];
}

export interface UploadProgress { loaded: number; total: number | null; }

export interface OutputSettings {
  format: 'mp4' | 'mp3';
  quality: '1080p' | '720p' | 'best';
  cut_mode: 'accurate' | 'copy';
}

export interface PublicLimits { max_source_bytes: number; max_ranges: number; max_range_ms: number; max_job_ms: number; }
export interface SessionResponse { ok: boolean; limits?: Partial<PublicLimits>; }
