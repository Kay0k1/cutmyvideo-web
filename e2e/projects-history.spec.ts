import { expect, test, type Page } from '@playwright/test';
import { goToClips, goToExport, goToSource, showExactTimes } from './helpers';

const source = (id: string, title: string) => ({ id, title, duration_ms: 12000, width: 640, height: 360, kind: 'upload', preview_kind: 'none', preview_url: null, embed_url: null, thumbnail_url: null });
const draft = (id: string, title: string, label: string) => ({ workflow_version: 2, source_id: id, source_title: title, source_duration_ms: 12000, ranges: [{ id: `${id}-range`, label, start_ms: 1000, end_ms: 4000 }], selected_id: `${id}-range`, selected_range_ids: [`${id}-range`], step: 2, precision_open: true, current_ms: 2000, timeline_span: 10000, output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } });
async function mockProjectAPI(page: Page, removed = false) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const value = path.endsWith('/session') ? { ok: true } : path.endsWith('/tracks') ? { tracks: [] } : path === '/api/v1/sources' ? { sources: [source('source-a', 'A.mp4'), source('source-b', 'B.mp4')] } : path.endsWith('/sources/source-a') ? { ...source('source-a', 'A.mp4'), media_removed: removed } : path.endsWith('/sources/source-b') ? source('source-b', 'B.mp4') : path.endsWith('/jobs') ? { jobs: [] } : { error: { code: 'preview_unavailable', message: 'No preview' } };
    await route.fulfill({ status: 'error' in value ? 400 : 200, json: value });
  });
}
async function seedProjects(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem('seeded')) return;
    const d = (id: string, title: string, label: string) => ({ workflow_version: 2, source_id: id, source_title: title, source_duration_ms: 12000, ranges: [{ id: `${id}-range`, label, start_ms: 1000, end_ms: 4000 }], selected_id: `${id}-range`, selected_range_ids: [`${id}-range`], step: 2, precision_open: true, current_ms: 2000, timeline_span: 10000, output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } });
    localStorage.setItem('cutmy.projects.v1', JSON.stringify({ version: 1, active_id: 'source-a', projects: [{ id: 'source-a', updated_at: 1, draft: d('source-a', 'A.mp4', 'A clip') }, { id: 'source-b', updated_at: 2, draft: d('source-b', 'B.mp4', 'B clip') }] })); localStorage.setItem('seeded', 'yes');
  });
}

test('projects keep per-video edits and bounded gesture history across switching and reload', async ({ page }) => {
  await mockProjectAPI(page); await seedProjects(page); await page.goto('/');
  await expect(page.locator('.editor-workspace')).toBeVisible();
  await goToClips(page);
  const name = page.getByLabel('Название фрагмента 1', { exact: true });
  await name.fill('A edited'); await name.press('Tab');
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click(); await expect(name).toHaveValue('A clip');
  await page.getByRole('button', { name: 'Повторить изменение', exact: true }).click(); await expect(name).toHaveValue('A edited');
  await page.locator('.clip-bulk-menu > summary').click();
  await page.getByRole('button', { name: 'Дублировать выбранные', exact: true }).click();
  await page.getByLabel('Название фрагмента 2', { exact: true }).fill('A second'); await page.getByLabel('Название фрагмента 2', { exact: true }).press('Tab');
  await page.locator('.clip-list > li').nth(1).locator('.clip-row-menu > summary').click();
  await page.getByRole('button', { name: 'Переместить фрагмент 2 вверх', exact: true }).click(); await expect(name).toHaveValue('A second');
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click(); await expect(name).toHaveValue('A edited');
  await goToSource(page); await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть проект «B.mp4»', exact: true }).click(); await goToClips(page); await expect(name).toHaveValue('B clip'); await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
  await goToSource(page); await page.getByRole('button', { name: 'Мои проекты', exact: true }).click(); await page.getByRole('button', { name: 'Открыть проект «A.mp4»', exact: true }).click(); await goToClips(page); await expect(name).toHaveValue('A edited'); await expect(page.locator('.clip-list > li')).toHaveCount(2);
  await page.reload(); await expect(page.locator('.editor-workspace')).toBeVisible(); await expect(name).toHaveValue('A edited'); await expect(page.locator('.clip-list > li')).toHaveCount(2);
});

test('source media removal preserves the project and downloadable core-v1 plan', async ({ page }) => {
  await mockProjectAPI(page, true); await seedProjects(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Фрагменты сохранены', exact: true })).toBeVisible();
  await expect(page.locator('.draft-recovery')).toContainText('A clip');
  await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать план', exact: true }).click();
  const file = await download; const path = await file.path(); expect(path).toBeTruthy();
  const { readFile } = await import('node:fs/promises'); const plan = JSON.parse(await readFile(path!, 'utf8'));
  expect(plan.version).toBe(1); expect(plan.input).toBe('A.mp4'); expect(plan.ranges).toEqual([{ label: 'A clip', start_ms: 1000, end_ms: 4000 }]); expect(plan.source_id).toBeUndefined();
  await page.reload(); await expect(page.locator('.draft-recovery')).toContainText('A clip');
});

test('legacy draft migrates and timeline drags are one undo action', async ({ page }) => {
  await mockProjectAPI(page);
  await page.addInitScript(d => { if (!localStorage.getItem('seeded')) { localStorage.setItem('cutmy.workbench.v1', JSON.stringify(d)); localStorage.setItem('seeded', 'yes'); } }, draft('source-a', 'A.mp4', 'Legacy'));
  await page.goto('/'); await showExactTimes(page);
  const start = page.getByLabel('Начало', { exact: true }); await expect(start).toHaveValue('00:00:01.000');
  const handle = page.getByRole('slider', { name: 'Начало фрагмента на шкале', exact: true }); await handle.scrollIntoViewIfNeeded(); const box = await handle.boundingBox(); expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(start).not.toHaveValue('00:00:01.000'); await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click(); await expect(start).toHaveValue('00:00:01.000'); await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
  await goToSource(page); await page.getByRole('button', { name: 'Мои проекты', exact: true }).click(); await expect(page.getByRole('button', { name: 'Открыть проект «A.mp4»', exact: true })).toBeVisible();
});

test('import replaces selected cuts with an undoable core plan and exports the same order', async ({ page }) => {
  await mockProjectAPI(page); await seedProjects(page);
  let release!: () => void; const delayedSource = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const restorationStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/sources/source-a', async route => {
    started(); await delayedSource; await route.fulfill({ json: source('source-a', 'A.mp4') });
  });
  await page.goto('/'); await restorationStarted;
  // The initial chooser is visible while the saved source is still loading.
  // Navigating to sources must wait for restoration before choosing that view.
  await expect(page.locator('.source-chooser')).toBeVisible();
  await expect(page.locator('.source-open')).toBeDisabled();
  let navigated = false;
  const navigate = goToSource(page).then(() => { navigated = true; });
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(navigated).toBe(false);
  } finally { release(); }
  await navigate;
  await expect(page.locator('.source-chooser')).toBeVisible();
  await expect(page.locator('.return-to-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  const plan = { version: 1, input: 'A.mp4', ranges: [{ label: 'Later', start_ms: 6000, end_ms: 8000 }, { label: 'Earlier', start_ms: 1000, end_ms: 2000 }], options: { format: 'mp4', quality: '720p', cut_mode: 'accurate' }, output_mode: 'joined' };
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Файл плана нарезки', { exact: true }).setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)) });
  await expect(page.locator('.editor-workspace')).toBeVisible(); await expect(page.getByLabel('Название фрагмента 1', { exact: true })).toHaveValue('Later');
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click(); await expect(page.getByLabel('Название фрагмента 1', { exact: true })).toHaveValue('A clip'); await expect(page.locator('.clip-list > li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Повторить изменение', exact: true }).click(); await expect(page.locator('.clip-list > li')).toHaveCount(2);
  await goToSource(page); await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать план', exact: true }).click(); const path = await (await download).path();
  const { readFile } = await import('node:fs/promises'); expect(JSON.parse(await readFile(path!, 'utf8'))).toEqual(plan);
});

test('a project restores completed exports after its source media is removed', async ({ page }) => {
  await mockProjectAPI(page, true); await seedProjects(page);
  await page.addInitScript(() => { const saved = JSON.parse(localStorage.getItem('cutmy.projects.v1')!); saved.projects[0].draft.job_id = 'job-a'; localStorage.setItem('cutmy.projects.v1', JSON.stringify(saved)); });
  let release!: () => void; const delayedJob = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const jobReadStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/v1/jobs/job-a', async route => {
    started(); await delayedJob;
    await route.fulfill({ json: { id: 'job-a', status: 'succeeded', stage: 'finished', message: '', items: [{ id: 'item-a', label: 'A clip', start_ms: 1000, end_ms: 4000, status: 'succeeded', artifact: { id: 'artifact-a', filename: 'A-clip.mp4', size_bytes: 100, download_url: '/completed-A-clip.mp4', actual_start_ms: 1000, actual_end_ms: 4000 } }] } });
  });
  await page.route('**/completed-A-clip.mp4', route => route.fulfill({ contentType: 'video/mp4', body: Buffer.from('completed media fixture') }));
  await page.goto('/'); await jobReadStarted;
  await expect(page.locator('.draft-recovery')).toContainText('A clip');
  // Source recovery has already reported an error, but the saved job can still
  // change the view. Navigation waits for that final read as well.
  let navigated = false;
  const navigate = goToSource(page).then(() => { navigated = true; });
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(navigated).toBe(false);
  } finally { release(); }
  await navigate;
  await expect(page.locator('.source-chooser')).toBeVisible();
  await goToExport(page); await goToExport(page); await expect(page.locator('.export-panel')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', '/completed-A-clip.mp4');
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Скачать', exact: true }).click(); await expect((await download).suggestedFilename()).toBe('A-clip.mp4');
  await goToSource(page); await expect(page.locator('.draft-recovery')).toContainText('A clip'); await page.reload();
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', '/completed-A-clip.mp4');
});
