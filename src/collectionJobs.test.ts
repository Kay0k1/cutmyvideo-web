import { expect, it } from 'vitest';
import { collectionJobReady, collectionJobRetryable } from './collectionJobs';
import type { Job } from './types';
it('does not present expired or removed artifacts as ready and permits an explicit retry without rerendering available successes', () => {
  const job = { status: 'succeeded', items: [{ artifact: { id: 'a', expires_at: '2026-10-15T00:00:00Z' } }] } as Job, now = Date.parse('2026-10-16T00:00:00Z');
  expect(collectionJobReady(job, now)).toBe(false); expect(collectionJobRetryable(job, now)).toBe(true);
  expect(collectionJobRetryable({ ...job, items: [{ ...job.items[0], artifact: null }] }, now)).toBe(true);
  expect(collectionJobReady({ ...job, items: [{ ...job.items[0], artifact: { ...job.items[0].artifact!, expires_at: '2026-10-17T00:00:00Z' } }] }, now)).toBe(true);
  expect(collectionJobRetryable({ ...job, items: [{ ...job.items[0], artifact: { ...job.items[0].artifact!, expires_at: null } }] }, now)).toBe(false);
  expect(collectionJobRetryable({ ...job, status: 'running' }, now)).toBe(false);
});
