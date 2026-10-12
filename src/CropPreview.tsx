import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { containedMediaBox } from './crop';
import type { CropRect } from './types';

/** Read-only framing during draft playback; controls and original pixels stay visible. */
export function CropPreview({ crop, container }: { crop: CropRect; container: HTMLElement }) {
  const [box, setBox] = useState({ x: 0, y: 0, width: 0, height: 0 });
  useEffect(() => {
    const update = () => {
      const media = container.querySelector('video');
      if (!media || !media.videoWidth) return;
      const bounds = media.getBoundingClientRect(), parent = container.getBoundingClientRect();
      const contained = containedMediaBox(bounds.width, bounds.height, media.videoWidth, media.videoHeight);
      setBox({ x: bounds.left - parent.left + contained.x, y: bounds.top - parent.top + contained.y, width: contained.width, height: contained.height });
    };
    const resize = new ResizeObserver(update); resize.observe(container);
    const mutation = new MutationObserver(update); mutation.observe(container, { subtree: true, childList: true });
    container.addEventListener('loadedmetadata', update, true); window.addEventListener('resize', update); update();
    return () => { resize.disconnect(); mutation.disconnect(); container.removeEventListener('loadedmetadata', update, true); window.removeEventListener('resize', update); };
  }, [container]);
  if (!box.width) return null;
  const x = crop.x * box.width, y = crop.y * box.height, width = crop.width * box.width, height = crop.height * box.height;
  return createPortal(<div className="draft-crop-preview" aria-hidden="true" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}><span style={{ left: x, top: y, width, height }} /></div>, container);
}
