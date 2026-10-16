// Installed Playwright drives the actual UI served by the real Go service.
// The private input and the one-time capability never enter logs or traces.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const [inputPath, outputPath] = process.argv.slice(2);
let browser, stage = 'read_input';
async function publish(value) {
  const temporary = outputPath + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, outputPath);
}
async function checkpoint(next) { stage = next; await publish({ complete: false, stage }); }
try {
  await checkpoint('read_input');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const base = new URL(input.base_url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !/^[A-Za-z0-9_-]{1,160}$/.test(input.project_id) || !/^[A-Za-z0-9_-]{32,256}$/.test(input.token)) throw new Error();
  browser = await chromium.launch({ headless: true, ...(process.env.CUTMY_AGENT_PROJECT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CUTMY_AGENT_PROJECT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: false });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const target = new URL('/?lang=ru', base); target.hash = 'handoff=' + input.token;
  await checkpoint('redeem_handoff'); await page.goto(target.toString());
  await page.waitForFunction(() => !location.hash && document.querySelectorAll('.collection-clip-list li').length === 15);
  const first = page.locator('[data-clip-id="clip-01"]'), last = page.locator('[data-clip-id="clip-15"]');
  await checkpoint('edit_first_range'); await first.locator('.collection-clip-name').click();
  const before = await page.locator('#collection-start').inputValue();
  const parts = before.split(':').map(Number), start = Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000) + 40;
  const format = ms => [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(value => String(value).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
  await page.locator('#collection-start').fill(format(start)); await page.locator('#collection-start').press('Tab');
  await checkpoint('edit_last_crop'); await last.locator('.collection-clip-name').click();
  await page.locator('.collection-clip-settings > summary').click();
  await page.locator('.crop-editor > summary').click();
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.videoWidth > 0; });
  const geometry = await page.locator('video').evaluate(video => ({ width: video.videoWidth, height: video.videoHeight }));
  await page.getByRole('combobox', { name: 'Пропорции кадра', exact: true }).selectOption('custom');
  await page.getByLabel('Ширина', { exact: true }).fill(String(geometry.width / 2));
  await page.getByLabel('Высота', { exact: true }).fill(String(geometry.height));
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await checkpoint('export_selected'); await page.getByRole('button', { name: 'Снять выбор', exact: true }).click();
  await first.locator('input[type=checkbox]').check(); await last.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Экспортировать выбранные · 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.collection-select-actions')?.textContent?.includes('2/2'), undefined, { timeout: 600000 });
  await checkpoint('save_complete_selection'); await page.getByRole('button', { name: 'Выбрать все', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить редакцию на сервере', exact: true }).click();
  await page.getByText('Редакция проекта сохранена.', { exact: true }).waitFor();
  await checkpoint('verify_complete_project'); const response = await page.request.get(new URL('/api/v1/projects/' + encodeURIComponent(input.project_id), base).toString());
  if (!response.ok()) throw new Error();
  const project = await response.json(), edited = ['clip-01', 'clip-15'];
  const one = project.plan.clips.find(clip => clip.id === edited[0]), fifteen = project.plan.clips.find(clip => clip.id === edited[1]);
  const crop = fifteen?.options?.crop;
  if (project.id !== input.project_id || one?.ranges?.[0]?.start_ms !== start || !crop || Math.abs(crop.x - .25) > 1e-8 || crop.y !== 0 || Math.abs(crop.width - .5) > 1e-8 || crop.height !== 1) throw new Error();
  const current = project.jobs.filter(row => row.current && edited.includes(row.clip_id));
  if (current.length !== 2 || current.some(row => row.job.status !== 'succeeded') || project.jobs.filter(row => row.current).length !== 15 || project.clip_ids && project.clip_ids.length !== 15) throw new Error();
  const screenshot = join(dirname(outputPath), 'browser-review-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await publish({ complete: true, edited_ids: edited, project_id: project.id, revision: project.revision, clip_ids: project.plan.clips.map(clip => clip.id), selected_ids: project.clip_ids, jobs: current.map(row => ({ clip_id: row.clip_id, job_id: row.job.id, artifact_ids: row.job.items.filter(item => item.artifact).map(item => item.artifact.id) })), screenshot, fragment_removed: !new URL(page.url()).hash, start_ms: start, crop });
  await context.close(); await browser.close(); browser = undefined;
} catch {
  await browser?.close().catch(() => {});
  if (outputPath) await publish({ complete: false, error: 'browser_project_review_failed', stage }).catch(() => {});
  process.stderr.write('Agent project browser review failed; inspect the bounded public receipt.\n'); process.exitCode = 1;
}
