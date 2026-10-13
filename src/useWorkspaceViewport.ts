import { useLayoutEffect } from 'react';

// Browser chrome can resize the visible area independently of CSS viewport
// units. Measure on tab restoration too; background tabs may miss resize events.
export function useWorkspaceViewport(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const desktop = matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)');
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    let frame = 0;
    const measure = () => {
      if (!desktop.matches) { style.removeProperty('--workspace-height'); return; }
      if (document.hidden || (viewport && Math.abs(viewport.scale - 1) > 0.01)) return;
      const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
      if (height > 0) style.setProperty('--workspace-height', `${Math.floor(height)}px`);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('visibilitychange', schedule);
    viewport?.addEventListener('resize', schedule);
    desktop.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('visibilitychange', schedule);
      viewport?.removeEventListener('resize', schedule);
      desktop.removeEventListener('change', schedule);
      style.removeProperty('--workspace-height');
    };
  }, [active]);
}
