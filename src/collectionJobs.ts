import type { Artifact, Job } from './types';
export function collectionArtifactAvailable(artifact: Artifact, now = Date.now()): boolean {
  const expires = artifact.expires_at ? Date.parse(artifact.expires_at) : NaN;
  return !Number.isFinite(expires) || expires > now;
}
export function collectionJobReady(job: Job, now = Date.now()): boolean {
  return job.status === 'succeeded' && job.items.some(item => item.artifact && collectionArtifactAvailable(item.artifact, now));
}
export function collectionJobRetryable(job: Job, now = Date.now()): boolean {
  return ['failed', 'cancelled'].includes(job.status) || job.status === 'succeeded' && !collectionJobReady(job, now);
}
