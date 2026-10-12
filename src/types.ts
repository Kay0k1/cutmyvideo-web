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
  preview_kind?: 'native' | 'youtube' | 'window' | 'none';
  width?: number;
  height?: number;
  expires_at?: string | null;
  retention_blocked?: boolean;
  media_removed?: boolean;
  media_removed_at?: string | null;
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
  segments?: { index: number; label: string; source_start_ms: number; source_end_ms: number; output_start_ms: number; output_end_ms: number }[];
  track_manifest?: (MediaTrack & { included: boolean; reason?: string })[];
}

export interface MediaTrack {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  codec: string;
  language?: string;
  title?: string;
  channels?: number;
  sample_rate?: number;
  default?: boolean;
  attached_picture?: boolean;
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

export interface UploadProgress { bytesPerSecond?: number; loaded: number; total: number | null; }

export interface CropRect { x: number; y: number; width: number; height: number; }

export interface OutputSettings {
  crop?: CropRect;
  format: 'mp4' | 'mp3' | 'mkv';
  quality: '1080p' | '720p' | 'best';
  cut_mode: 'accurate' | 'copy';
  output_mode?: 'separate' | 'joined';
  audio_track?: number;
  no_audio?: boolean;
  subtitle_mode?: 'omit' | 'preserve';
  cleanup_source?: boolean;
}

export interface PublicLimits { max_output_bytes?: number; max_fetch_bytes?: number; max_source_bytes: number; max_ranges: number; max_range_ms: number; max_job_ms: number; }
export interface SessionResponse { ok: boolean; limits?: Partial<PublicLimits>; }

export interface JobSummary { id: string; source_id: string; title: string; status: JobStatus; stage: string; created_at: string; total: number; files: Artifact[]; }
