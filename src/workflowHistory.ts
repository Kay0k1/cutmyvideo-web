import { useEffect, useRef } from 'react';
import type { WorkbenchStep } from './clipCollection';

export type WorkbenchPanel = 'examples' | 'settings' | 'support' | null;
export interface WorkflowRoute { step: WorkbenchStep; panel: WorkbenchPanel; }
interface WorkflowEntry extends WorkflowRoute { version: 1; index: number; panelBase?: number; }
const maximumIndex = 1_000_000;

interface HistoryPort {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string): void;
  pushState(data: unknown, unused: string, url?: string): void;
  go(delta: number): void;
}
export interface WorkflowHistoryWindow {
  history: HistoryPort;
  location: { readonly href: string };
  addEventListener(type: 'popstate' | 'hashchange', listener: EventListener): void;
  removeEventListener(type: 'popstate' | 'hashchange', listener: EventListener): void;
}

function readEntry(state: unknown): WorkflowEntry | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const value = (state as Record<string, unknown>).cutmyWorkflow;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { version, step, index } = value as Record<string, unknown>;
  const panel = (value as Record<string, unknown>).panel ?? null;
  const panelBase = (value as Record<string, unknown>).panelBase;
  if (version !== 1 || typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > 4
    || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > maximumIndex
    || panel !== null && panel !== 'settings' && panel !== 'examples' && panel !== 'support'
    || panelBase !== undefined && (typeof panelBase !== 'number' || !Number.isInteger(panelBase) || panelBase < 0 || panelBase > index)) return null;
  return { version: 1, step: step as WorkbenchStep, panel, index, ...(panel && panelBase !== undefined ? { panelBase: panelBase as number } : {}) };
}

const stateFor = (entry: WorkflowEntry) => ({ cutmyWorkflow: entry });

/** One coordinator for editing steps and dialogs; no media IDs or owner state. */
export function startWorkflowHistory(browser: WorkflowHistoryWindow, initial: WorkflowRoute,
  onNavigate: (route: WorkflowRoute) => WorkflowRoute | null) {
  let current: WorkflowEntry = { version: 1, ...initial, index: readEntry(browser.history.state)?.index ?? 0 };
  let restoring: WorkflowEntry | null = null;
  let deferredRoute: WorkflowRoute | null = null;
  let panelReturnIndex: number | null = null;
  let closeWaiters: ((closed: boolean) => void)[] = [];
  let disposed = false;
  const write = (push: boolean) => {
    const url = new URL(browser.location.href);
    if (current.panel) url.searchParams.set('panel', current.panel);
    else url.searchParams.delete('panel');
    if (push) browser.history.pushState(stateFor(current), '', url.href);
    else browser.history.replaceState(stateFor(current), '', url.href);
  };
  const finishClose = (closed: boolean) => { const pending = closeWaiters; closeWaiters = []; for (const resolve of pending) resolve(closed); };
  // Bootstrap after async draft restoration. This entry is the browser's
  // ordinary exit point; opening the site does not add a synthetic Back trap.
  write(false);

  const adoptHashEntry = () => {
    if (disposed || restoring || readEntry(browser.history.state)) return;
    // Native fragment links create a same-document entry with null state. Give
    // it its own position before a dialog/step is pushed so Close and rejected
    // Back navigation return to the real entry, including repeated anchors.
    current = { ...current, index: Math.min(maximumIndex, current.index + 1) };
    write(false);
  };

  const sync = (route: WorkflowRoute) => {
    if (disposed) return;
    if (restoring) { deferredRoute = route; return; }
    adoptHashEntry();
    if (route.step === current.step && route.panel === current.panel) return;
    const sameDialog = current.panel !== null && route.panel !== null && route.step === current.step;
    const push = !sameDialog && current.index < maximumIndex;
    if (route.panel && !current.panel) panelReturnIndex = current.index;
    else if (!route.panel) panelReturnIndex = null;
    current = { version: 1, ...route, index: current.index + (push ? 1 : 0),
      ...(route.panel && panelReturnIndex !== null ? { panelBase: panelReturnIndex } : {}) };
    write(push);
  };

  const pop = (event: PopStateEvent) => {
    if (disposed) return;
    const target = readEntry(event.state);
    // Unrelated entries belong to normal browser navigation. Never push an
    // editor entry to prevent the user from leaving the initial page.
    if (!target) {
      // An explicit Close must settle even if it reaches an older unmanaged
      // entry. Ordinary unrelated navigation and new fragment entries remain
      // untouched here; hashchange will adopt the latter separately.
      if (closeWaiters.length && current.panel) {
        const next = onNavigate({ step: current.step, panel: null });
        if (next) { current = { version: 1, ...next, index: panelReturnIndex ?? Math.max(0, current.index - 1) }; panelReturnIndex = null; finishClose(true); }
        else finishClose(false);
      }
      return;
    }
    if (restoring) {
      if (target.index !== restoring.index) { browser.history.go(restoring.index - target.index); return; }
      current = restoring; restoring = null;
      if (deferredRoute !== null) { const route = deferredRoute; deferredRoute = null; sync(route); }
      return;
    }
    const next = onNavigate({ step: target.step, panel: target.panel });
    if (next === null) {
      // Invalid time edits remain visible and focused. Return to the entry we
      // left instead of pushing another copy and discarding Forward history.
      const delta = current.index - target.index;
      finishClose(false);
      if (delta) { restoring = current; browser.history.go(delta); }
      else write(false);
      return;
    }
    panelReturnIndex = next.panel ? target.panelBase ?? (target.index > 0 ? target.index - 1 : null) : null;
    current = { version: 1, ...next, index: target.index,
      ...(next.panel && panelReturnIndex !== null ? { panelBase: panelReturnIndex } : {}) };
    if (next.step !== target.step || next.panel !== target.panel) write(false);
    if (!next.panel) finishClose(true);
  };
  const popListener: EventListener = event => pop(event as PopStateEvent);
  const hashListener: EventListener = () => adoptHashEntry();
  browser.addEventListener('popstate', popListener);
  browser.addEventListener('hashchange', hashListener);
  return {
    sync,
    closePanel: (): Promise<boolean> => {
      if (disposed) return Promise.resolve(false);
      adoptHashEntry();
      if (!current.panel) return Promise.resolve(true);
      if (panelReturnIndex !== null && panelReturnIndex < current.index) {
        return new Promise(resolve => {
          const alreadyClosing = closeWaiters.length > 0;
          closeWaiters.push(resolve);
          if (!alreadyClosing) browser.history.go(panelReturnIndex! - current.index);
        });
      }
      // A direct ?panel= link (including a refreshed panel) has no dialog entry
      // created in this visit. Close it in place rather than leaving the site.
      const next = onNavigate({ step: current.step, panel: null });
      if (!next) return Promise.resolve(false);
      current = { version: 1, ...next, index: current.index }; panelReturnIndex = null; write(false);
      return Promise.resolve(true);
    },
    dispose: () => { disposed = true; browser.removeEventListener('popstate', popListener); browser.removeEventListener('hashchange', hashListener); finishClose(false); },
  };
}

/** Integrate only after sessionReady, with the latest draft-aware navigation guard. */
export function useWorkflowHistory({ ready, step, panel, onNavigate }: {
  ready: boolean; step: WorkbenchStep; panel: WorkbenchPanel;
  onNavigate(route: WorkflowRoute): WorkflowRoute | null;
}) {
  const tracker = useRef<ReturnType<typeof startWorkflowHistory> | null>(null);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    if (!ready) return;
    const active = startWorkflowHistory(window, { step, panel }, target => navigate.current(target));
    tracker.current = active;
    return () => { active.dispose(); if (tracker.current === active) tracker.current = null; };
  }, [ready]);
  useEffect(() => { tracker.current?.sync({ step, panel }); }, [ready, step, panel]);
  return {
    closePanel: () => {
      if (tracker.current) return tracker.current.closePanel();
      const closed = navigate.current({ step, panel: null }) !== null;
      if (closed) {
        const url = new URL(window.location.href); url.searchParams.delete('panel');
        window.history.replaceState(window.history.state, '', url.href);
      }
      return Promise.resolve(closed);
    },
  };
}
