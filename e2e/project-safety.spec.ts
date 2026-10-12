import { expect, test, type Page } from '@playwright/test';
import { api, goToClips, goToExport, goToSource, stepButton } from './helpers';

const source = (id: string, title: string, removed = false) => ({ id, title, duration_ms: 12000, width: 640, height: 360, kind: 'upload', preview_kind: 'none', preview_url: null, embed_url: null, thumbnail_url: null, media_removed: removed });
const draft = (id: string, title: string, label: string) => ({ workflow_version: 2, source_id: id, source_title: title, source_duration_ms: 12000, ranges: [{ id: `${id}-range`, label, start_ms: 1000, end_ms: 4000 }], selected_id: `${id}-range`, selected_range_ids: [`${id}-range`], step: 2, precision_open: true, output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } });
const projectStore = () => ({ version: 1, active_id: 'source-a', projects: [{ id: 'source-a', updated_at: 1, draft: draft('source-a', 'A.mp4', 'A clip') }, { id: 'source-b', updated_at: 2, draft: draft('source-b', 'B.mp4', 'B clip') }] });
async function setup(page: Page, store = projectStore(), legacy: object | null = null) {
  await page.addInitScript(({ store, legacy }) => { if (!localStorage.getItem('safety-seeded')) { if (legacy) localStorage.setItem('cutmy.workbench.v1', JSON.stringify(legacy)); else localStorage.setItem('cutmy.projects.v1', JSON.stringify(store)); localStorage.setItem('safety-seeded', 'yes'); } }, { store, legacy });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const value = path.endsWith('/session') ? { ok: true } : path.endsWith('/tracks') ? { tracks: [] } : path === `${api}/sources/source-a` ? source('source-a', 'A.mp4') : path === `${api}/sources/source-b` ? source('source-b', 'B.mp4') : path === `${api}/sources` && route.request().method() === 'POST' ? source('source-c', 'C.mp4') : path === `${api}/sources` ? { sources: [] } : path === `${api}/jobs` ? { jobs: [] } : { error: { code: 'preview_unavailable', message: 'No mocked media' } };
    await route.fulfill({ status: 'error' in value ? 400 : 200, json: value });
  });
}
async function openOther(page: Page) {
  await page.locator('#source-url').fill('https://example.com/video.mp4');
  await page.locator('form.source-form button[type="submit"]').click();
}
async function openProjects(page: Page) { await goToSource(page); await page.getByRole('button', { name: 'My projects', exact: true }).click(); }

test('undo and redo content preserve current export selections for surviving clips', async ({ page }) => {
  const store = projectStore();
  store.projects[0].draft.ranges.push({ id: 'second-range', label: 'Second clip', start_ms: 5000, end_ms: 7000 });
  await setup(page, store); await page.goto('/?lang=en'); await goToClips(page);
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Delete clip 1', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select clip 1', exact: true }).check();
  await page.getByRole('button', { name: 'Undo change', exact: true }).click();
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('A clip');
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Redo change', exact: true }).click();
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Second clip');
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Select clip 1', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Undo change', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).not.toBeChecked();
});

test('cancelling a delayed project open prevents it overwriting a new source', async ({ page }) => {
  await setup(page);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/sources/source-b', async route => { started(); await blocked; await route.fulfill({ json: source('source-b', 'B.mp4') }).catch(() => {}); });
  await page.goto('/?lang=en'); await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await requestStarted;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await openOther(page);
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step'); await expect(page.locator('.source-title')).toContainText('C.mp4');
  release(); await page.waitForTimeout(150); await expect(page.locator('.source-title')).toContainText('C.mp4');
});

test('cancelling a project job read does not attach its delayed job to a replacement source', async ({ page }) => {
  const store = projectStore(); Object.assign(store.projects[1].draft, { job_id: 'old-job' }); await setup(page, store);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/jobs/old-job', async route => { started(); await blocked; await route.fulfill({ json: { id: 'old-job', status: 'failed', stage: 'finished', message: 'Old project job', items: [] } }).catch(() => {}); });
  await page.goto('/?lang=en'); await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await requestStarted;
  await page.getByRole('button', { name: 'Change video', exact: true }).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await openOther(page);
  await expect(page.locator('.source-title')).toContainText('C.mp4'); release(); await page.waitForTimeout(150);
  await expect(page.locator('.source-title')).toContainText('C.mp4'); await goToExport(page); await expect(page.locator('.job-status')).toHaveCount(0); expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}').job_id)).not.toBe('old-job');
});

test('a cleaned-up source restores an intentionally empty project and its settings', async ({ page }) => {
  const store = projectStore(); store.projects[0].draft.ranges = []; store.projects[0].draft.selected_range_ids = []; Object.assign(store.projects[0].draft.output, { crop: { x: .2, y: 0, width: .5, height: 1 }, cleanup_source: false });
  await setup(page, store); await page.route('**/api/v1/sources/source-a', route => route.fulfill({ json: source('source-a', 'A.mp4', true) }));
  await page.goto('/?lang=en'); await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}').source_id)).toBe('source-a');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}')); expect(saved.ranges).toEqual([]); expect(saved.output.crop).toEqual({ x: .2, y: 0, width: .5, height: 1 }); expect(saved.output.cleanup_source).toBe(false);
});

test('a storage quota failure preserves edits and blocks project switching until storage recovers', async ({ page }) => {
  await setup(page); await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, { safetyBlockStorage: false });
    Storage.prototype.setItem = function(key, value) { if ((window as unknown as { safetyBlockStorage: boolean }).safetyBlockStorage && key === 'cutmy.projects.v1') throw new DOMException('quota', 'QuotaExceededError'); return original.call(this, key, value); };
  });
  let otherReads = 0; await page.route('**/api/v1/sources/source-b', async route => { otherReads++; await route.fulfill({ json: source('source-b', 'B.mp4') }); });
  await page.goto('/?lang=en'); await goToClips(page); await page.getByLabel('Clip 1 name', { exact: true }).fill('Important edit'); await page.getByLabel('Clip 1 name', { exact: true }).press('Tab');
  await page.evaluate(() => Object.assign(window, { safetyBlockStorage: true })); await openProjects(page);
  await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Could not save your project'); expect(otherReads).toBe(0);
  await goToClips(page); await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Important edit');
  await page.evaluate(() => Object.assign(window, { safetyBlockStorage: false })); await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await expect(page.locator('.source-title')).toContainText('B.mp4');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.projects.v1')!).projects.find((project: any) => project.id === 'source-a').draft); expect(saved.ranges[0].label).toBe('Important edit');
});

test('a full project index blocks a new source before creating server media', async ({ page }) => {
  const store = projectStore(); for (let index = 2; index < 100; index++) store.projects.push({ id: `project-${index}`, updated_at: index, draft: draft(`source-${index}`, `Video ${index}`, `Clip ${index}`) });
  await setup(page, store); let created = 0; await page.route('**/api/v1/sources', async route => { if (route.request().method() === 'POST') created++; await route.fulfill({ json: source('source-c', 'C.mp4') }); });
  await page.goto('/?lang=en'); await goToSource(page); await openOther(page); await expect(page.getByRole('alert')).toContainText('Too many projects'); expect(created).toBe(0);
  await goToClips(page); await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('A clip');
});

test('retry identity is written to the project before POST and restored after navigation', async ({ page }) => {
  await setup(page); const keys: string[] = []; let checkedPreflight = false;
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: { jobs: [] } }); return; }
    const key = route.request().headers()['idempotency-key']; keys.push(key);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.projects.v1')!).projects.find((project: any) => project.id === 'source-a').draft);
    expect(saved.export_attempt.key).toBe(key); checkedPreflight = true;
    await route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Unknown acceptance' } } });
  });
  await page.goto('/?lang=en'); await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect.poll(() => keys.length).toBe(1); await expect.poll(() => checkedPreflight).toBe(true);
  await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await openProjects(page); await page.getByRole('button', { name: 'Open project “A.mp4”', exact: true }).click(); await goToExport(page);
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect.poll(() => keys.length).toBe(2); expect(keys[1]).toBe(keys[0]); await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  await page.reload(); await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect.poll(() => keys.length).toBe(3); expect(keys[2]).toBe(keys[0]);
});


test('an upgraded 0.3 lost acknowledgement keeps its exact request and key without changing new-video defaults', async ({ page }) => {
  const saved = draft('source-a', 'A.mp4', 'A clip');
  const body = JSON.stringify({ source_id: 'source-a', ranges: [{ start_ms: 1000, end_ms: 4000, label: 'A clip' }], format: 'mp4', quality: '720p', cut_mode: 'accurate' });
  const legacy = { ...saved, step: 4, export_attempt: { fingerprint: body, key: 'legacy-ack-key' } };
  await setup(page, projectStore(), legacy);
  const keys: string[] = [], bodies: string[] = [];
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: { jobs: [] } }); return; }
    keys.push(route.request().headers()['idempotency-key']); bodies.push(route.request().postData()!);
    await route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Unknown acceptance' } } });
  });
  await page.goto('/?lang=en'); await goToExport(page); await expect(page.getByRole('checkbox', { name: 'Delete source after export', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect.poll(() => keys.length).toBe(1); await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  expect(keys[0]).toBe('legacy-ack-key'); expect(bodies[0]).toBe(body);
  await goToSource(page); await openOther(page); await expect(page.locator('.source-title')).toContainText('C.mp4'); await goToExport(page); await expect(page.getByRole('checkbox', { name: 'Delete source after export', exact: true })).toBeChecked();
  await openProjects(page); await page.getByRole('button', { name: 'Open project “A.mp4”', exact: true }).click(); await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe('legacy-ack-key'); expect(bodies[1]).toBe(body);
});

test('a lost acknowledgement recovers the accepted job after automatic media removal using the original request', async ({ page }) => {
  await setup(page); let removed = false; const keys: string[] = [], bodies: string[] = [];
  await page.route('**/api/v1/sources/source-a', route => route.fulfill({ json: source('source-a', 'A.mp4', removed) }));
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: { jobs: [] } }); return; }
    keys.push(route.request().headers()['idempotency-key']); bodies.push(route.request().postData()!);
    if (keys.length === 1) { removed = true; await route.abort('failed'); return; }
    await route.fulfill({ json: { id: 'accepted-job', status: 'succeeded', stage: 'finished', message: '', items: [{ id: 'item', label: 'A clip', start_ms: 1000, end_ms: 4000, status: 'succeeded', artifact: { id: 'retained-artifact', filename: 'A.mp4', size_bytes: 100, download_url: '/completed.mp4', actual_start_ms: 1000, actual_end_ms: 4000 } }] } });
  });
  await page.goto('/?lang=en'); await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await page.reload(); await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Retry export', exact: true }).click(); await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', '/completed.mp4');
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[1]).cleanup_source).toBe(true);
});
