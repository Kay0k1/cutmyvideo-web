import { readBrowserDraft, readBrowserProject } from './browserProjectStorage'; import { clickProjectAcrossSave } from './support/project-library';
import { expect, test, type Page } from '@playwright/test';
import { api, goToClips, goToExport, goToSource, showExportSettings } from './helpers';

const source = (id: string, title: string, removed = false) => ({ id, title, duration_ms: 12000, width: 640, height: 360, kind: 'upload', preview_kind: 'none', preview_url: null, embed_url: null, thumbnail_url: null, media_removed: removed });
const draft = (id: string, title: string, label: string) => ({ workflow_version: 2, source_id: id, source_title: title, source_duration_ms: 12000, ranges: [{ id: `${id}-range`, label, start_ms: 1000, end_ms: 4000 }], selected_id: `${id}-range`, selected_range_ids: [`${id}-range`], step: 2, precision_open: true, output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } });
const projectStore = () => ({ version: 1, active_id: 'source-a', projects: [{ id: 'source-a', updated_at: 1, draft: draft('source-a', 'A.mp4', 'A clip') }, { id: 'source-b', updated_at: 2, draft: draft('source-b', 'B.mp4', 'B clip') }] });
async function setup(page: Page, store = projectStore(), legacy: object | null = null) {
  await page.addInitScript(({ store, legacy }) => { if (!localStorage.getItem('safety-seeded')) { if (legacy) localStorage.setItem('cutmy.workbench.v1', JSON.stringify(legacy)); else localStorage.setItem('cutmy.projects.v1', JSON.stringify(store)); localStorage.setItem('safety-seeded', 'yes'); } }, { store, legacy });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const value = path.endsWith('/session') ? { ok: true } : path.endsWith('/tracks') ? { tracks: [] } : path === `${api}/sources/source-a` ? source('source-a', 'A.mp4') : path === `${api}/sources/source-b` ? source('source-b', 'B.mp4') : path === `${api}/sources/source-c` ? source('source-c', 'C.mp4') : path === `${api}/sources` && route.request().method() === 'POST' ? source('source-c', 'C.mp4') : path === `${api}/sources` ? { sources: [] } : path === `${api}/jobs` ? { jobs: [] } : { error: { code: 'preview_unavailable', message: 'No mocked media' } };
    await route.fulfill({ status: 'error' in value ? 400 : 200, json: value });
  });
}
async function openOther(page: Page) {
  await page.locator('#source-url').fill('https://example.com/video.mp4');
  await page.locator('form.source-form button[type="submit"]').click();
}
async function closeExportSettings(page: Page) {
  const dialog = page.locator('dialog.export-settings-dialog');
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
}
async function submitClip(page: Page) {
  await closeExportSettings(page);
  await goToExport(page);
  await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click();
}
async function openProjects(page: Page) { await closeExportSettings(page); await goToSource(page); await page.getByRole('button', { name: 'My projects', exact: true }).click(); }
async function deleteClip(page: Page, index: number) {
  const menu = page.locator('.clip-list > li').nth(index - 1).locator('.clip-row-menu');
  if (!await menu.evaluate(element => (element as HTMLDetailsElement).open)) await menu.locator('summary').click();
  await menu.getByRole('button', { name: `Delete clip ${index}`, exact: true }).click();
}

test('undo and redo content preserve current export selections for surviving clips', async ({ page }) => {
  const store = projectStore();
  store.projects[0].draft.ranges.push({ id: 'second-range', label: 'Second clip', start_ms: 5000, end_ms: 7000 });
  await setup(page, store); await page.goto('/?lang=en'); await goToClips(page);
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).not.toBeChecked();
  await deleteClip(page, 1);
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
  await expect(page.locator('.editor-workspace')).toBeVisible(); await expect(page.locator('.source-title')).toContainText('C.mp4');
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
  await expect(page.locator('.source-title')).toContainText('C.mp4'); await goToExport(page); await expect(page.locator('.job-status')).toHaveCount(0); expect(await readBrowserDraft(page).then(saved => saved.job_id)).not.toBe('old-job');
});

test('a cleaned-up source restores an intentionally empty project and its settings', async ({ page }) => {
  const store = projectStore(); store.projects[0].draft.ranges = []; store.projects[0].draft.selected_range_ids = []; Object.assign(store.projects[0].draft.output, { crop: { x: .2, y: 0, width: .5, height: 1 }, cleanup_source: false });
  await setup(page, store); await page.route('**/api/v1/sources/source-a', route => route.fulfill({ json: source('source-a', 'A.mp4', true) }));
  await page.goto('/?lang=en'); await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await expect.poll(() => readBrowserDraft(page).then(saved => saved.source_id)).toBe('source-a');
  const saved = await readBrowserDraft(page); expect(saved.ranges).toEqual([]); expect(saved.output.crop).toEqual({ x: .2, y: 0, width: .5, height: 1 }); expect(saved.output.cleanup_source).toBe(false);
});

test('a storage quota failure preserves edits and blocks project switching until storage recovers', async ({ page }) => {
  await setup(page); await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, { safetyBlockStorage: false });
    Storage.prototype.setItem = function(key, value) { if ((window as unknown as { safetyBlockStorage: boolean }).safetyBlockStorage && key.startsWith('cutmy.project.v2.')) throw new DOMException('quota', 'QuotaExceededError'); return original.call(this, key, value); };
  });
  let otherReads = 0; await page.route('**/api/v1/sources/source-b', async route => { otherReads++; await route.fulfill({ json: source('source-b', 'B.mp4') }); });
  await page.goto('/?lang=en'); await goToClips(page); await page.evaluate(() => Object.assign(window, { safetyBlockStorage: true })); await page.getByLabel('Clip 1 name', { exact: true }).fill('Important edit'); await page.getByLabel('Clip 1 name', { exact: true }).press('Tab');
  await page.evaluate(() => Object.assign(window, { safetyBlockStorage: true })); await openProjects(page);
  await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Could not save your project'); expect(otherReads).toBe(0);
  await goToClips(page); await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Important edit');
  await page.evaluate(() => Object.assign(window, { safetyBlockStorage: false })); await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click(); await expect(page.locator('.source-title')).toContainText('B.mp4');
  const saved = await readBrowserProject(page, 'source-a'); expect(saved.ranges[0].label).toBe('Important edit');
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
    const saved = await readBrowserProject(page, 'source-a');
    expect(saved.export_attempt.key).toBe(key); checkedPreflight = true;
    await route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Unknown acceptance' } } });
  });
  await page.goto('/?lang=en'); await goToExport(page); await submitClip(page); await expect.poll(() => keys.length).toBe(1); await expect.poll(() => checkedPreflight).toBe(true);
  await goToExport(page); await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  await openProjects(page); await page.getByRole('button', { name: 'Open project “B.mp4”', exact: true }).click();
  await expect(page.locator('.source-title')).toContainText('B.mp4');
  await clickProjectAcrossSave(page, () => openProjects(page), 'source-a', 'A.mp4', 'source-b');
  await expect(page.locator('.source-title')).toContainText('A.mp4'); await goToExport(page);
  await submitClip(page); await expect.poll(() => keys.length).toBe(2); expect(keys[1]).toBe(keys[0]); await goToExport(page); await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  await page.reload(); await goToExport(page); await submitClip(page); await expect.poll(() => keys.length).toBe(3); expect(keys[2]).toBe(keys[0]);
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
  await page.goto('/?lang=en'); await showExportSettings(page); await expect(page.getByRole('checkbox', { name: 'Delete source after export', exact: true })).not.toBeChecked();
  await submitClip(page); await expect.poll(() => keys.length).toBe(1); await goToExport(page); await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled();
  expect(keys[0]).toBe('legacy-ack-key'); expect(bodies[0]).toBe(body);
  await goToSource(page); await openOther(page); await expect(page.locator('.source-title')).toContainText('C.mp4'); await showExportSettings(page); await expect(page.getByRole('checkbox', { name: 'Delete source after export', exact: true })).toBeChecked();
  await openProjects(page); await page.getByRole('button', { name: 'Open project “A.mp4”', exact: true }).click(); await goToExport(page); await submitClip(page); await expect.poll(() => keys.length).toBe(2);
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
  await page.goto('/?lang=en'); await goToExport(page); await submitClip(page); await expect(page.getByRole('alert')).toBeVisible();
  await page.reload(); await goToExport(page); await expect(page.locator('.orphan-retry')).toBeVisible();
  await page.getByRole('button', { name: 'Retry export', exact: true }).click(); await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', '/completed.mp4');
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[1]).cleanup_source).toBe(true);
});

test('two real tabs keep independent projects while playback saves positions', async ({ page, context }) => {
  await setup(page);
  const { readFile } = await import('node:fs/promises');
  const video = await readFile(process.env.CUTMY_E2E_MEDIA!);
  await page.route('**/api/v1/sources/source-a', route => route.fulfill({ json: { ...source('source-a', 'A.mp4'), preview_kind: 'file', preview_url: '/tabs-preview.mp4' } }));
  await page.route('**/tabs-preview.mp4', route => route.fulfill({ contentType: 'video/mp4', body: video }));
  await page.goto('/?lang=en'); await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Preview clip', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1);
  const second = await context.newPage(); await setup(second); await second.goto('/?lang=en'); await openOther(second);
  await expect(second.locator('.source-title')).toContainText('C.mp4'); await goToClips(second);
  await second.getByLabel('Clip 1 name', { exact: true }).fill('Second tab clip'); await second.getByLabel('Clip 1 name', { exact: true }).press('Tab');
  await readBrowserDraft(second);
  await readBrowserDraft(page);
  await expect.poll(async () => (await readBrowserProject(page, 'source-c')).ranges?.[0]?.label).toBe('Second tab clip');
  await goToClips(page); await page.getByLabel('Clip 1 name', { exact: true }).fill('First tab clip'); await page.getByLabel('Clip 1 name', { exact: true }).press('Tab'); await readBrowserDraft(page);
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('First tab clip');
  await expect(second.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Second tab clip');
  expect(await page.evaluate(() => sessionStorage.getItem('cutmy.project.active.v2'))).toBe('source-a');
  expect(await second.evaluate(() => sessionStorage.getItem('cutmy.project.active.v2'))).toBe('source-c');
  expect((await readBrowserProject(page, 'source-b')).ranges[0].label).toBe('B clip');
});

test('same-project edits in two tabs require explicit conflict recovery and preserve both versions', async ({ page, context }) => {
  await setup(page); await page.goto('/?lang=en'); await goToClips(page);
  const second = await context.newPage(); await setup(second); await second.goto('/?lang=en');
  await second.getByRole('button', { name: 'My projects', exact: true }).click(); await second.getByRole('button', { name: 'Open project “A.mp4”', exact: true }).click(); await goToClips(second);
  await page.getByLabel('Clip 1 name', { exact: true }).fill('First saved version'); await page.getByLabel('Clip 1 name', { exact: true }).press('Tab'); await readBrowserDraft(page);
  await expect(second.getByRole('alert')).toContainText('changed in another tab');
  await second.getByLabel('Clip 1 name', { exact: true }).fill('Second unsaved version'); await second.getByLabel('Clip 1 name', { exact: true }).press('Tab');
  await readBrowserDraft(second);
  expect((await readBrowserProject(page, 'source-a')).ranges[0].label).toBe('First saved version');
  // Reload immediately after editing also retains this tab's unsaved draft.
  await second.reload(); await expect(second.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Second unsaved version');
  await expect(second.getByRole('alert')).toContainText('changed in another tab');
  await second.getByRole('button', { name: 'Save my changes as a copy', exact: true }).click();
  await expect(second.getByRole('alert')).toHaveCount(0);
  const copyID = await second.evaluate(() => sessionStorage.getItem('cutmy.project.active.v2'));
  expect(copyID).not.toBe('source-a'); expect((await readBrowserProject(second, copyID!)).ranges[0].label).toBe('Second unsaved version');
  expect((await readBrowserProject(second, 'source-a')).ranges[0].label).toBe('First saved version');
  await second.reload(); await expect(second.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Second unsaved version');
});

test('deleting a project in another tab cannot be undone by a stale autosave', async ({ page, context }) => {
  await setup(page); await page.goto('/?lang=en'); await goToClips(page);
  const second = await context.newPage(); await setup(second); await second.goto('/?lang=en');
  await second.getByRole('button', { name: 'My projects', exact: true }).click(); second.once('dialog', dialog => dialog.accept());
  await second.getByRole('button', { name: 'Remove project “A.mp4” from this browser', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('removed in another tab');
  await page.getByLabel('Clip 1 name', { exact: true }).fill('Work kept after deletion'); await page.getByLabel('Clip 1 name', { exact: true }).press('Tab'); await readBrowserDraft(page);
  const record = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.project.v2.source-a')!)); expect(record.deleted).toBe(true); expect(record).not.toHaveProperty('draft');
  await page.reload(); await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Work kept after deletion');
  await expect(page.getByRole('alert')).toContainText('removed in another tab');
  await page.getByRole('button', { name: 'Save my changes as a copy', exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  const deleted = await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.project.v2.source-a')!)); expect(deleted.deleted).toBe(true);
  expect((await readBrowserProject(page, 'source-b')).ranges[0].label).toBe('B clip');
});
