import { expect, test, type Page } from '@playwright/test';
import { readBrowserDraft } from '../browserProjectStorage';

/** Complete a saved-project timestamp update between pointer down and up.
 * The fixture records retain their content and revisions, so this exercises
 * list ordering without introducing an unrelated cross-tab edit conflict. */
export async function clickProjectAcrossSave(page: Page, openLibrary: () => Promise<void>, targetID: string, targetTitle: string, savedID: string) {
  await readBrowserDraft(page);
  await openLibrary();
  const updateTimestamp = (id: string, afterID: string) => page.evaluate(async ({ id, afterID }) => {
    await navigator.locks.request('cutmy.projects.v2.transaction', () => {
      const key = `cutmy.project.v2.${id}`, oldValue = localStorage.getItem(key)!;
      const record = JSON.parse(oldValue), other = JSON.parse(localStorage.getItem(`cutmy.project.v2.${afterID}`)!);
      record.updated_at = Math.max(Date.now(), record.updated_at, other.updated_at) + 1;
      const newValue = JSON.stringify(record);
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage, url: location.href }));
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, { id, afterID });
  await updateTimestamp(targetID, savedID);
  const target = page.getByRole('button', { name: `Open project “${targetTitle}”`, exact: true });
  await expect(target).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox(); expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const before = await page.locator('#saved-projects > ul > li h3').allTextContents();
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  let after: string[] = [];
  try { await updateTimestamp(savedID, targetID); after = await page.locator('#saved-projects > ul > li h3').allTextContents(); }
  finally { await page.mouse.up(); }
  await test.info().attach('project-pointer-save-order.json', { body: JSON.stringify({ target: targetID, saved: savedID, before, after, pointer: point }, null, 2), contentType: 'application/json' });
}
