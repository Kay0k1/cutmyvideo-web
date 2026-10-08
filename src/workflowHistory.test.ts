import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchStep } from './clipCollection';
import { startWorkflowHistory } from './workflowHistory';
import type { WorkbenchPanel, WorkflowHistoryWindow, WorkflowRoute } from './workflowHistory';

function browserHistory(entries: unknown[] = [null], initial = entries.length - 1) {
  let cursor = initial;
  let href = 'https://cutmy.test/?lang=en';
  const listeners = new Set<EventListener>();
  const events = new Map<string, Set<EventListener>>();
  const values = [...entries];
  const urls = entries.map(() => href);
  const browser: WorkflowHistoryWindow = {
    location: { get href() { return href; } },
    history: {
      get state() { return values[cursor]; },
      replaceState: vi.fn((state, _unused, url) => { values[cursor] = state; if (url) href = url; urls[cursor] = href; }),
      pushState: vi.fn((state, _unused, url) => { values.splice(cursor + 1); urls.splice(cursor + 1); values.push(state); cursor++; if (url) href = url; urls.push(href); }),
      go: vi.fn(delta => {
        const next = cursor + delta;
        if (next < 0 || next >= values.length) return;
        const previousHash = new URL(href).hash;
        cursor = next;
        href = urls[cursor];
        for (const listener of [...(events.get('popstate') ?? [])]) listener(Object.assign(new Event('popstate'), { state: values[cursor] }));
        if (new URL(href).hash !== previousHash) for (const listener of [...(events.get('hashchange') ?? [])]) listener(new Event('hashchange'));
      }),
    },
    addEventListener: (type, listener) => { listeners.add(listener); if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(listener); },
    removeEventListener: (type, listener) => { listeners.delete(listener); events.get(type)?.delete(listener); },
  };
  const hash = (fragment: string) => {
    const url = new URL(href); url.hash = fragment;
    values.splice(cursor + 1); urls.splice(cursor + 1); cursor++;
    values.push(null); urls.push(url.href); href = url.href;
    for (const listener of [...(events.get('popstate') ?? [])]) listener(Object.assign(new Event('popstate'), { state: null }));
    for (const listener of [...(events.get('hashchange') ?? [])]) listener(new Event('hashchange'));
  };
  return { browser, values, cursor: () => cursor, listeners, hash };
}

const route = (step: WorkbenchStep, panel: WorkbenchPanel = null): WorkflowRoute => ({ step, panel });
function startSteps(browser: WorkflowHistoryWindow, initial: WorkbenchStep, onNavigate: (step: WorkbenchStep) => WorkbenchStep | null) {
  const tracker = startWorkflowHistory(browser, route(initial), target => {
    const step = onNavigate(target.step);
    return step === null ? null : route(step, target.panel);
  });
  return { ...tracker, sync: (step: WorkbenchStep) => tracker.sync(route(step)) };
}

describe('native workflow history', () => {
  it('initializes with replace and stores only a bounded step marker', () => {
    const history = browserHistory([{ source_id: 'must-not-persist', owner: 'must-not-persist' }]);
    const tracker = startSteps(history.browser, 2, target => target);
    expect(history.values).toEqual([{ cutmyWorkflow: { version: 1, step: 2, panel: null, index: 0 } }]);
    tracker.sync(2);
    expect(history.browser.history.pushState).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('supports Back and Forward without duplicate entries and truncates old Forward paths on a new choice', () => {
    const history = browserHistory();
    let visible: WorkbenchStep = 1;
    const navigate = vi.fn((target: WorkbenchStep) => { visible = target; return target; });
    const tracker = startSteps(history.browser, visible, navigate);
    for (const step of [2, 3, 4] as WorkbenchStep[]) { visible = step; tracker.sync(step); }
    expect(history.values).toHaveLength(4);
    history.browser.history.go(-1); tracker.sync(visible);
    expect(visible).toBe(3);
    history.browser.history.go(-1); tracker.sync(visible);
    expect(visible).toBe(2);
    history.browser.history.go(1); tracker.sync(visible);
    expect(visible).toBe(3);
    expect(history.values).toHaveLength(4);
    expect(history.browser.history.pushState).toHaveBeenCalledTimes(3);
    history.browser.history.go(-1); tracker.sync(visible);
    tracker.sync(4);
    expect(history.values).toHaveLength(3);
    expect(history.values.at(-1)).toEqual({ cutmyWorkflow: { version: 1, step: 4, panel: null, index: 2 } });
    tracker.dispose();
  });

  it('rejects leaving an invalid moment by returning to the same entry, without consuming Forward history', () => {
    const history = browserHistory();
    let invalid = true;
    const navigate = vi.fn((target: WorkbenchStep) => invalid ? null : target);
    const tracker = startSteps(history.browser, 1, navigate);
    tracker.sync(3); tracker.sync(2);
    history.browser.history.go(-1);
    expect(history.cursor()).toBe(2);
    expect(history.browser.history.state).toEqual({ cutmyWorkflow: { version: 1, step: 2, panel: null, index: 2 } });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(3);
    expect(history.browser.history.pushState).toHaveBeenCalledTimes(2);
    expect(history.values).toHaveLength(3);
    invalid = false;
    history.browser.history.go(-1); tracker.sync(3);
    expect(history.cursor()).toBe(1);
    history.browser.history.go(1); tracker.sync(2);
    expect(history.cursor()).toBe(2);
    expect(history.values).toHaveLength(3);
    tracker.dispose();
  });

  it('replaces unavailable steps with the guard’s available destination after deletion', () => {
    const history = browserHistory();
    const tracker = startSteps(history.browser, 1, () => 1);
    tracker.sync(2); tracker.sync(3); tracker.sync(4);
    history.browser.history.go(-1); tracker.sync(1);
    expect(history.browser.history.state).toEqual({ cutmyWorkflow: { version: 1, step: 1, panel: null, index: 2 } });
    history.browser.history.go(1); tracker.sync(1);
    expect(history.browser.history.state).toEqual({ cutmyWorkflow: { version: 1, step: 1, panel: null, index: 3 } });
    expect(history.values).toHaveLength(4);
    expect(history.browser.history.pushState).toHaveBeenCalledTimes(3);
    tracker.dispose();
  });

  it('uses restored draft state on reload and retains the existing browser position', () => {
    const history = browserHistory([
      { cutmyWorkflow: { version: 1, step: 1, panel: null, index: 0 } },
      { cutmyWorkflow: { version: 1, step: 2, panel: null, index: 1 } },
    ]);
    const navigate = vi.fn((target: WorkbenchStep) => target);
    const tracker = startSteps(history.browser, 4, navigate);
    expect(history.browser.history.state).toEqual({ cutmyWorkflow: { version: 1, step: 4, panel: null, index: 1 } });
    tracker.sync(4); history.browser.history.go(-1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(1);
    expect(history.values).toHaveLength(2);
    tracker.dispose();
  });

  it.each([null, { anotherApplication: true }, { cutmyWorkflow: { version: 1, step: 99, index: 0 } },
    { cutmyWorkflow: { version: 1, step: 2, panel: null, index: -1 } }, { cutmyWorkflow: { version: 1, step: 2, panel: null, index: 1_000_001 } }])
  ('allows normal browser exit to unrelated or invalid history state %j', outside => {
    const history = browserHistory([outside, null]);
    const navigate = vi.fn((target: WorkbenchStep) => target);
    const tracker = startSteps(history.browser, 1, navigate);
    history.browser.history.go(-1);
    expect(history.cursor()).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(history.browser.history.pushState).not.toHaveBeenCalled();
    tracker.dispose();
    expect(history.listeners.size).toBe(0);
    tracker.sync(2);
    expect(history.browser.history.pushState).not.toHaveBeenCalled();
  });
});

describe('dialog history shares the workflow coordinator', () => {
  it('adopts repeated native anchors so dialog Close, Back and Forward retain their real positions', async () => {
    const history = browserHistory();
    let visible = route(1);
    const tracker = startWorkflowHistory(history.browser, visible, target => { visible = target; return target; });
    visible = route(2); tracker.sync(visible);
    history.hash('first'); history.hash('editor');
    expect(history.browser.history.state).toEqual({ cutmyWorkflow: { version: 1, step: 2, panel: null, index: 3 } });
    visible = route(2, 'settings'); tracker.sync(visible);
    expect(await tracker.closePanel()).toBe(true);
    expect(history.cursor()).toBe(3);
    expect(visible).toEqual(route(2));
    history.browser.history.go(1); tracker.sync(visible);
    expect(visible).toEqual(route(2, 'settings'));
    expect(await tracker.closePanel()).toBe(true);
    tracker.dispose();
  });

  it('retains the dialog’s original return entry through native anchors inside the dialog and Forward jumps', async () => {
    const history = browserHistory();
    let visible = route(2);
    const tracker = startWorkflowHistory(history.browser, visible, target => { visible = target; return target; });
    visible = route(2, 'settings'); tracker.sync(visible);
    history.hash('first'); history.hash('second');
    expect(visible).toEqual(route(2, 'settings'));
    expect(await tracker.closePanel()).toBe(true);
    expect(history.cursor()).toBe(0);
    history.browser.history.go(3); tracker.sync(visible);
    expect(visible).toEqual(route(2, 'settings'));
    expect(await tracker.closePanel()).toBe(true);
    expect(history.cursor()).toBe(0);
    tracker.dispose();
  });

  it('restores the exact anchor entry when invalid time validation rejects a multi-entry Back jump', () => {
    const history = browserHistory();
    let visible = route(1);
    const tracker = startWorkflowHistory(history.browser, visible, target => target.step === 1 ? null : (visible = target));
    visible = route(2); tracker.sync(visible);
    history.hash('first'); history.hash('editor');
    history.browser.history.go(-3);
    expect(history.cursor()).toBe(3);
    expect(visible).toEqual(route(2));
    expect(new URL(history.browser.location.href).hash).toBe('#editor');
    expect(history.values).toHaveLength(4);
    tracker.dispose();
  });

  it('Back closes the dialog, Forward reopens it, and Close returns to its editing entry', async () => {
    const history = browserHistory();
    let visible = route(2);
    const tracker = startWorkflowHistory(history.browser, visible, target => { visible = target; return target; });
    tracker.sync(route(2, 'settings'));
    expect(new URL(history.browser.location.href).searchParams.get('panel')).toBe('settings');
    history.browser.history.go(-1); tracker.sync(visible);
    expect(visible).toEqual(route(2));
    expect(new URL(history.browser.location.href).searchParams.get('panel')).toBeNull();
    history.browser.history.go(1); tracker.sync(visible);
    expect(visible).toEqual(route(2, 'settings'));
    expect(new URL(history.browser.location.href).searchParams.get('panel')).toBe('settings');
    expect(await tracker.closePanel()).toBe(true);
    tracker.sync(visible);
    expect(visible).toEqual(route(2));
    expect(history.cursor()).toBe(0);
    expect(history.values).toHaveLength(2);
    expect(history.browser.history.pushState).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('closes an initial panel link in place and preserves other URL parameters', async () => {
    const history = browserHistory();
    let visible = route(2, 'examples');
    const tracker = startWorkflowHistory(history.browser, visible, target => { visible = target; return target; });
    expect(await tracker.closePanel()).toBe(true);
    tracker.sync(visible);
    expect(visible).toEqual(route(2));
    expect(history.browser.history.go).not.toHaveBeenCalled();
    expect(history.browser.history.pushState).not.toHaveBeenCalled();
    expect(new URL(history.browser.location.href).searchParams.get('panel')).toBeNull();
    expect(new URL(history.browser.location.href).searchParams.get('lang')).toBe('en');
    tracker.dispose();
  });

  it('closes settings before validating an invalid moment, then rejects leaving that moment without losing its history', async () => {
    const history = browserHistory();
    let visible = route(1);
    const guard = vi.fn((target: WorkflowRoute) => {
      if (target.step !== visible.step && visible.step === 2) return null;
      visible = target; return target;
    });
    const tracker = startWorkflowHistory(history.browser, visible, guard);
    visible = route(2); tracker.sync(visible);
    visible = route(2, 'settings'); tracker.sync(visible);
    history.browser.history.go(-1); tracker.sync(visible);
    expect(visible).toEqual(route(2));
    history.browser.history.go(-1); tracker.sync(visible);
    expect(history.cursor()).toBe(1);
    expect(visible).toEqual(route(2));
    expect(history.values).toHaveLength(3);
    history.browser.history.go(1); tracker.sync(visible);
    expect(visible).toEqual(route(2, 'settings'));
    expect(await tracker.closePanel()).toBe(true);
    tracker.dispose();
  });

  it('awaits closing Examples before a new source flow replaces the Forward branch', async () => {
    const history = browserHistory();
    let visible = route(2);
    const tracker = startWorkflowHistory(history.browser, visible, target => { visible = target; return target; });
    tracker.sync(route(2, 'examples'));
    expect(await tracker.closePanel()).toBe(true);
    expect(visible).toEqual(route(2));
    tracker.sync(route(1));
    expect(history.values).toEqual([
      { cutmyWorkflow: { version: 1, step: 2, panel: null, index: 0 } },
      { cutmyWorkflow: { version: 1, step: 1, panel: null, index: 1 } },
    ]);
    expect(new URL(history.browser.location.href).searchParams.get('panel')).toBeNull();
    tracker.dispose();
  });

  it('resolves a pending Close as cancelled on disposal so an example cannot start after leaving the page', async () => {
    const history = browserHistory();
    const tracker = startWorkflowHistory(history.browser, route(2), target => target);
    tracker.sync(route(2, 'examples'));
    history.browser.history.go = vi.fn();
    const closed = tracker.closePanel();
    tracker.dispose();
    expect(await closed).toBe(false);
  });
});
