import { useLayoutEffect, useSyncExternalStore } from 'react';

const desktopQuery = '(min-width: 900px) and (hover: hover) and (pointer: fine)';
const subscribeDesktop = (notify: () => void) => {
  const query = matchMedia(desktopQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
export function useDesktopWorkspace() {
  return useSyncExternalStore(subscribeDesktop, () => matchMedia(desktopQuery).matches, () => false);
}

// Browser chrome can resize the visible area independently of CSS viewport
// units. Measure on tab restoration too; background tabs may miss resize events.
export function useWorkspaceViewport(active: boolean, layout: 'editor' | 'source' = 'editor') {
  useLayoutEffect(() => {
    if (!active) return;
    const desktop = matchMedia(desktopQuery);
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    let frame = 0;
    const measure = () => {
      if (!desktop.matches) { style.removeProperty('--workspace-height'); return; }
      if (document.hidden || (viewport && Math.abs(viewport.scale - 1) > 0.01)) return;
      const shell = document.querySelector<HTMLElement>('.workspace-shell:not(.collection-shell), .source-shell');
      // Large text must reflow rather than clip controls in a fixed canvas.
      const navigation = document.querySelector<HTMLElement>('.window-player-position');
      shell?.classList.toggle('workspace-reflow', parseFloat(getComputedStyle(shell).fontSize) >= 24
        || !!navigation && parseFloat(getComputedStyle(navigation).fontSize) >= 24);
      const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
      if (height > 0) style.setProperty('--workspace-height', `${Math.floor(height)}px`);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    const controls = document.querySelector('.moment-controls');
    if (controls) observer.observe(controls);
    const preview = document.querySelector('.player-frame');
    if (preview) observer.observe(preview);
    const navigation = document.querySelector('.window-player-navigation');
    if (navigation) observer.observe(navigation);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('visibilitychange', schedule);
    viewport?.addEventListener('resize', schedule);
    desktop.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.querySelector('.workspace-reflow')?.classList.remove('workspace-reflow');
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('visibilitychange', schedule);
      viewport?.removeEventListener('resize', schedule);
      desktop.removeEventListener('change', schedule);
      style.removeProperty('--workspace-height');
    };
  }, [active, layout]);
}
