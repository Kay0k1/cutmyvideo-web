import { expect, test, type Page } from '@playwright/test';
import type { CollectionPlan } from '../src/collectionProject';

const token = 'A'.repeat(43), fingerprint = { kind: 'content', sha256: 'a'.repeat(64), size_bytes: 12345 };
const source = { id: 'source-agent', title: 'Интервью с агентом.mp4', kind: 'upload', duration_ms: 12000, width: 640, height: 360, preview_url: '/api/v1/projects/project-agent/sources/source-agent/media', thumbnail_url: null, embed_url: null, preview_kind: 'native', fingerprint };
function plan(count = 15): CollectionPlan { return { version: 1, options: { format: 'mp4', quality: '720p', cut_mode: 'accurate' }, clips: Array.from({ length: count }, (_, index) => ({ id: index < 2 ? ['2', '1'][index] : 'clip-' + String(index + 1).padStart(2, '0'), label: 'Ролик ' + (index + 1), ranges: index === 0 ? [{ start_ms: 8000, end_ms: 9000 }, { start_ms: 1000, end_ms: 2000 }] : [{ start_ms: 1000, end_ms: 2000 }] })) }; }
const signature = (plan: CollectionPlan, clip: CollectionPlan['clips'][number]) => JSON.stringify({ ranges: clip.ranges, options: { ...plan.options, ...clip.options } });
function job(id: string) { return { id, status: 'succeeded', stage: 'finished', message: '', items: [{ id: id + '-item', label: '', start_ms: 1000, end_ms: 2000, status: 'succeeded', artifact: { id: id + '-artifact', filename: id + '.mp4', size_bytes: 1234, download_url: 'https://untrusted.invalid/do-not-follow', actual_start_ms: 1000, actual_end_ms: 2000, segments: [{ index: 0, label: '', source_start_ms: 1000, source_end_ms: 2000, output_start_ms: 0, output_end_ms: 1000 }] } }] }; }
async function setupProject(page: Page, options: { partial?: boolean; failedLast?: boolean; loseRetryReply?: boolean; conflict?: boolean } = {}) {
  let savedPlan = plan(), revision = 1, serial = 15, redeemed = 0, submissions = 0, globalAccess = 0;
  const initial = savedPlan.clips.map((clip, index) => ({ clip_id: clip.id, job: job('job-' + (index + 1)), current: true, signature: signature(savedPlan, clip) }));
  let rows = options.partial ? [] as typeof initial : initial;
  if (options.partial) serial = 0;
  if (options.failedLast) { rows[14].job.status = 'failed'; rows[14].job.items[0].status = 'failed'; Object.assign(rows[14].job.items[0], { artifact: null }); }
  const submitTimes: number[] = [], retryKeys: string[] = []; const retryJobs = new Map<string, ReturnType<typeof job>>();
  function response() { return { version: 1, id: 'project-agent', revision, source, plan: savedPlan, rendition: 'final', jobs: rows.map(row => ({ ...row, current: row.signature === signature(savedPlan, savedPlan.clips.find(clip => clip.id === row.clip_id)!) })), expires_at: '2030-01-01T00:00:00Z', access_expires_at: '2029-01-01T00:00:00Z' }; }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === '/api/v1/session') { expect(new URL(page.url()).hash).toBe(''); return route.fulfill({ json: { ok: true, limits: { max_ranges: 128 } } }); }
    if (path === '/api/v1/projects/handoffs/redeem') { redeemed++; expect(route.request().postDataJSON()).toEqual({ token }); expect(new URL(page.url()).hash).toBe(''); return route.fulfill({ json: { project: response() } }); }
    if (path === '/api/v1/projects/project-agent') {
      if (method === 'PUT') { if (options.conflict) return route.fulfill({ status: 409, json: { error: { code: 'project_conflict', message: 'Stale' } } }); const body = route.request().postDataJSON(); if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: { code: 'project_conflict', message: 'Stale' } } }); savedPlan = body.plan; revision++; }
      return route.fulfill({ json: response() });
    }
    if (path.endsWith('/collections/validate')) return route.fulfill({ json: { version: 1, valid: true, rendition: 'final', clips: [] } });
    if (path.endsWith('/collections/retry')) { const key = route.request().headers()['idempotency-key']; retryKeys.push(key); const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!)); expect(saved.retry_attempt.key).toBe(key); const body = route.request().postDataJSON(); let rendered = retryJobs.get(key); if (!rendered) { rendered = job('job-' + ++serial); retryJobs.set(key, rendered); rows = rows.map(row => body.clip_ids.includes(row.clip_id) ? { ...row, job: rendered! } : row); } if (options.loseRetryReply && retryKeys.length === 1) return route.abort('failed'); return route.fulfill({ json: { version: 1, complete: true, rendition: 'final', clips: body.clip_ids.map((clip_id: string) => ({ clip_id, job: rendered, retryable: false })) } }); }
    if (path.endsWith('/collections') && options.partial) { submissions++; submitTimes.push(Date.now()); let accepted = 0; rows = savedPlan.clips.flatMap(clip => { const previous = rows.find(row => row.clip_id === clip.id); if (previous) return [previous]; if (accepted++ >= 3) return []; return [{ clip_id: clip.id, signature: signature(savedPlan, clip), job: job('job-' + ++serial), current: true }]; }); return route.fulfill({ status: rows.length === 15 ? 200 : 202, headers: rows.length === 15 ? {} : { 'Retry-After': '2' }, json: { version: 1, complete: rows.length === 15, rendition: 'final', clips: savedPlan.clips.map(clip => { const row = rows.find(row => row.clip_id === clip.id); return row ? { clip_id: clip.id, job: row.job, retryable: false } : { clip_id: clip.id, retryable: true, error: { code: 'job_limit', message: 'Capacity' } }; }) } }); }
    if (path.endsWith('/collections')) { submissions++; expect(route.request().headers()).not.toHaveProperty('idempotency-key'); expect(route.request().postDataJSON()).toEqual({}); rows = savedPlan.clips.map(clip => { const previous = rows.find(row => row.clip_id === clip.id && row.signature === signature(savedPlan, clip)); return previous ?? { clip_id: clip.id, signature: signature(savedPlan, clip), job: job('job-' + ++serial), current: true }; }); return route.fulfill({ json: { version: 1, rendition: 'final', complete: true, clips: rows.map(row => ({ clip_id: row.clip_id, job: row.job, retryable: false })) } }); }
    if (path === source.preview_url) return route.fulfill({ path: process.env.CUTMY_E2E_MEDIA!, contentType: 'video/mp4' });
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', default: true }], display_width: 640, display_height: 360 } });
    if (path.startsWith('/api/v1/sources/') || path.startsWith('/api/v1/jobs/')) globalAccess++;
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not available' } } });
  });
  return { get serial() { return serial; }, get redeemed() { return redeemed; }, get submissions() { return submissions; }, get globalAccess() { return globalAccess; }, response, initial, submitTimes, retryKeys };
}

test('scoped handoff preserves fifteen IDs, ordered joins and independent crop through two revisions and reload', async ({ page }, testInfo) => {
  const backend = await setupProject(page);
  await page.goto('/?lang=ru#handoff=' + token);
  await expect(page.locator('.collection-clip-list li')).toHaveCount(15);
  expect(backend.redeemed).toBe(1); expect(backend.globalAccess).toBe(0);
  await expect(page.locator('.collection-part-tabs button').first()).toContainText('00:00:08');
  await expect(page.locator('.collection-part-tabs button').nth(1)).toContainText('00:00:01');
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
  await page.locator('.collection-clip-settings > summary').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toHaveCount(0);
  await page.locator('.crop-editor > summary').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Пропорции кадра', exact: true }).selectOption('9:16');
  const crop = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!).document.plan.clips[0].options.crop);
  expect(crop.width).toBeLessThan(.4); expect(crop.height).toBe(1);
  await page.getByRole('button', { name: 'Отменить правку', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!).document.plan.clips[0].options?.crop)).toBeUndefined();
  await page.getByRole('button', { name: 'Повторить правку', exact: true }).click();
  await page.locator('[data-clip-id="1"] .collection-clip-name').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toHaveCount(0);
  await page.locator('.crop-editor > summary').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toHaveValue('original');
  await page.locator('.crop-editor > summary').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toHaveCount(0);
  await page.locator('.crop-editor > summary').click();
  await expect(page.getByRole('combobox', { name: 'Пропорции кадра', exact: true })).toHaveValue('original');
  await page.getByLabel('Конец', { exact: true }).fill('00:00:02.500');
  await page.getByLabel('Конец', { exact: true }).press('Tab');
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать проект', exact: true }).click();
  const download = await downloadPromise, stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString()); expect(exported.plan.clips.map((clip: { id: string }) => clip.id)).toEqual(backend.initial.map(row => row.clip_id)); expect(exported.plan.clips[0].ranges.map((range: { start_ms: number }) => range.start_ms)).toEqual([8000, 1000]); expect(JSON.stringify(exported)).not.toMatch(/collection_key|project-agent|source-agent|handoff|owner/);
  await page.getByRole('button', { name: 'Экспортировать выбранные · 15', exact: true }).click();
  await expect.poll(() => backend.submissions).toBe(1); expect(backend.serial).toBe(17);
  await expect(page.locator('.collection-select-actions')).toContainText('15/15');
  await page.reload(); await expect(page.locator('.collection-clip-list li')).toHaveCount(15); await expect(page.locator('#collection-editor')).toHaveAttribute('data-bootstrap-state', 'ready');
  expect(backend.serial).toBe(17); expect(backend.redeemed).toBe(1); expect(backend.globalAccess).toBe(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!));
  expect(saved.document.plan.clips[0].options.crop).toEqual(crop); expect(saved.document.plan.clips[1].ranges[0].end_ms).toBe(2500);
  for (let index = 2; index < 15; index++) expect(saved.jobs[backend.initial[index].clip_id].job.id).toBe(backend.initial[index].job.id);
  expect(saved.jobs['2'].job.id).not.toBe(backend.initial[0].job.id); expect(saved.jobs['1'].job.id).not.toBe(backend.initial[1].job.id);
  expect(await page.locator('.collection-clip-list a').first().getAttribute('href')).toMatch(/^\/api\/v1\/projects\/project-agent\/artifacts\/job-\d+-artifact\/download$/);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  if (testInfo.project.name === 'usability-chromium') { expect((await page.locator('.site-header').boundingBox())!.y).toBeGreaterThanOrEqual(0); await page.screenshot({ path: testInfo.outputPath('collection-desktop.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('collection-mobile.png'), fullPage: true }); }
});

test('portable source relinking requires confirmation for same metadata with different actual content', async ({ page }) => {
  let hintedLookups = 0;
  const own = { ...source, id: 'own-source', preview_url: '/api/v1/sources/own-source/media', fingerprint: { ...fingerprint, sha256: 'b'.repeat(64) } };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: { ok: true } });
    if (path === '/api/v1/sources') return route.fulfill({ json: { sources: [own] } });
    if (path === '/api/v1/sources/foreign-source') hintedLookups++;
    if (path === own.preview_url) return route.fulfill({ path: process.env.CUTMY_E2E_MEDIA!, contentType: 'video/mp4' });
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [], display_width: 640, display_height: 360 } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Missing' } } });
  });
  await page.goto('/?workspace=collection&lang=ru'); await expect(page.locator('#collection-editor')).toHaveAttribute('data-bootstrap-state', 'ready');
  page.on('dialog', dialog => dialog.accept());
  await page.getByLabel('Открыть план коллекции').setInputFiles({ name: 'native.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ source_id: 'foreign-source', plan: plan(2) })) });
  await expect(page.locator('.collection-clip-list li')).toHaveCount(2); expect(hintedLookups).toBe(0); await expect(page.locator('video')).toHaveCount(0);
  await page.getByLabel('Открыть план коллекции').setInputFiles({ name: 'portable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ kind: 'cutmy.collection.project', version: 1, source: { title: source.title, duration_ms: source.duration_ms, fingerprint }, plan: plan(2) })) });
  await page.getByRole('button', { name: 'Мои видео на сервере', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть видео «' + own.title + '»', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Подтвердите исходник' })).toContainText('Отпечаток отличается'); expect(hintedLookups).toBe(0); await expect(page.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Использовать эту запись и проверить границы', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!)); expect(saved.source.id).toBe('own-source'); expect(saved.document.plan.clips.map((clip: { id: string }) => clip.id)).toEqual(['2', '1']); expect(saved.document.source.fingerprint.sha256).toBe('b'.repeat(64));
});


test('partial admission continues after refresh without violating the saved global Retry-After', async ({ page }) => {
  const backend = await setupProject(page, { partial: true });
  await page.goto('/?lang=ru#handoff=' + token);
  await expect(page.locator('.collection-clip-list li')).toHaveCount(15);
  await page.getByRole('button', { name: 'Экспортировать выбранные · 15', exact: true }).click();
  await expect.poll(() => backend.submissions).toBe(1);
  await expect(page.locator('.collection-select-actions')).toContainText('3/15');
  const deadline = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!).next_submit_at);
  expect(deadline).toBeGreaterThan(backend.submitTimes[0] + 1900);
  await page.reload(); await expect(page.locator('.collection-select-actions')).toContainText('15/15', { timeout: 20000 });
  expect(backend.serial).toBe(15); expect(backend.submissions).toBe(5);
  for (let index = 1; index < backend.submitTimes.length; index++) expect(backend.submitTimes[index] - backend.submitTimes[index - 1]).toBeGreaterThanOrEqual(1950);
});

test('an explicit failed-clip retry recovers a lost reply with the same persisted key and preserves fourteen jobs', async ({ page }) => {
  const backend = await setupProject(page, { failedLast: true, loseRetryReply: true });
  await page.goto('/?lang=ru#handoff=' + token); await expect(page.locator('.collection-select-actions')).toContainText('14/15');
  await page.getByRole('button', { name: 'Повторить неудачные ролики', exact: true }).click();
  await expect.poll(() => backend.retryKeys.length).toBe(1);
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить состояние');
  await page.getByRole('button', { name: 'Продолжить повторную попытку', exact: true }).click();
  await expect(page.locator('.collection-select-actions')).toContainText('15/15');
  expect(backend.retryKeys).toHaveLength(2); expect(new Set(backend.retryKeys).size).toBe(1); expect(backend.serial).toBe(16);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!));
  for (let index = 0; index < 14; index++) expect(saved.jobs[backend.initial[index].clip_id].job.id).toBe(backend.initial[index].job.id);
});

test('a server revision conflict preserves local edits and performs no collection submission', async ({ page }) => {
  const backend = await setupProject(page, { conflict: true });
  await page.goto('/?lang=ru#handoff=' + token); await expect(page.locator('.collection-clip-list li')).toHaveCount(15);
  await page.locator('.collection-clip-settings > summary').click(); await page.getByLabel('Название ролика', { exact: true }).fill('Несохранённая правка');
  await page.getByRole('button', { name: 'Сохранить редакцию на сервере', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Проект изменён в другой вкладке');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.collection.current.v1')!).document.plan.clips[0].label)).toBe('Несохранённая правка'); expect(backend.submissions).toBe(0);
});
