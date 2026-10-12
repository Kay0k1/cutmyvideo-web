import type { Page } from '@playwright/test';

/** Read the current authoritative project together with this tab's saved view.
 * Waiting on the storage transaction also checks that export preflight is durable. */
export async function readBrowserDraft(page: Page): Promise<Record<string, any>> {
  return page.evaluate(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    const read = () => {
      if (!localStorage.getItem('cutmy.projects.v2.ready')) return JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}');
      const id = sessionStorage.getItem('cutmy.project.active.v2'); if (!id) return {};
      const record = JSON.parse(localStorage.getItem(`cutmy.project.v2.${id}`) || '{}');
      const pending = JSON.parse(sessionStorage.getItem(`cutmy.project.pending.v2.${id}`) || '{}');
      const view = JSON.parse(sessionStorage.getItem(`cutmy.project.view.v2.${id}`) || '{}');
      return { ...(pending.draft || record.draft || {}), ...view };
    };
    return navigator.locks ? navigator.locks.request('cutmy.projects.v2.transaction', read) : read();
  });
}
export async function readBrowserProject(page: Page, id: string): Promise<Record<string, any>> {
  return page.evaluate(id => JSON.parse(localStorage.getItem(`cutmy.project.v2.${id}`) || '{}').draft || {}, id);
}
/** Fault injection intentionally changes stored data, then the caller reloads. */
export async function replaceBrowserDraft(page: Page, draft: Record<string, unknown>) {
  await page.evaluate(async draft => {
    await navigator.locks.request('cutmy.projects.v2.transaction', () => {
      const id = sessionStorage.getItem('cutmy.project.active.v2')!;
      const key = `cutmy.project.v2.${id}`, record = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...record, draft, revision: record.revision + 1 }));
      const fields = ['current_ms', 'timeline_span', 'view_center', 'simple_view', 'selected_id', 'step', 'precision_open', 'start_text', 'end_text'];
      sessionStorage.setItem(`cutmy.project.view.v2.${id}`, JSON.stringify(Object.fromEntries(fields.map(field => [field, draft[field]]))));
      sessionStorage.removeItem(`cutmy.project.pending.v2.${id}`);
    });
  }, draft);
}
