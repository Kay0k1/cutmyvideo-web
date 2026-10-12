import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { CROP_PRESETS, containedMediaBox, cropForAspect, FULL_CROP, moveCrop, parseAspect, scaleCrop } from './crop';
import type { CropRect } from './crop';
import './CropEditor.css';

const copy = {
  ru: { frame: 'Кадр', original: 'Исходные пропорции', custom: 'Свои пропорции', ratio: 'Пропорции кадра', width: 'Ширина', height: 'Высота', apply: 'Применить', size: 'Размер области', reset: 'Сбросить кадр', move: 'Переместить область кадра', resize: 'Изменить размер области кадра', hint: 'Перемещайте область на видео. Стрелки двигают её на один пиксель, Shift — на десять.', invalid: 'Задайте положительные пропорции, оставляющие не менее двух пикселей по каждой стороне.', pending: 'Пропорции появятся после подготовки изображения.', mode: 'Кроп доступен для точного MP4. Выберите этот режим или оставьте исходный кадр.', left: 'Влево', right: 'Вправо', up: 'Вверх', down: 'Вниз' },
  en: { frame: 'Frame', original: 'Original aspect ratio', custom: 'Custom aspect ratio', ratio: 'Frame aspect ratio', width: 'Width', height: 'Height', apply: 'Apply', size: 'Area size', reset: 'Reset frame', move: 'Move crop area', resize: 'Resize crop area', hint: 'Move the area on the video. Arrow keys move by one pixel; Shift moves by ten.', invalid: 'Enter a positive ratio leaving at least two pixels on each side.', pending: 'Aspect ratios will be available once the image is ready.', mode: 'Crop requires accurate MP4. Choose that mode or keep the original frame.', left: 'Left', right: 'Right', up: 'Up', down: 'Down' },
};

export interface CropEditorProps {
  value?: CropRect;
  onChange(value?: CropRect): void;
  displayWidth: number;
  displayHeight: number;
  locale: 'ru' | 'en';
  disabled?: boolean;
  /** Relative-positioned .player-frame, containing a video or iframe. */
  previewContainer?: HTMLElement | null;
  onBeginChange?(): void;
  onEndChange?(): void;
  onOpenChange?(open: boolean): void;
}

function cropLabel(crop: CropRect | undefined, width: number, height: number, original: string) {
  if (!crop) return original;
  const ratio = crop.width * width / (crop.height * height);
  return CROP_PRESETS.find(preset => Math.abs(parseAspect(preset)! - ratio) < .0001) ?? `${Number(ratio.toFixed(3))}:1`;
}

export function CropEditor(props: CropEditorProps) {
  const { value, onChange, displayWidth: width, displayHeight: height, locale, disabled, previewContainer, onBeginChange, onEndChange, onOpenChange } = props;
  const t = copy[locale];
  const id = useId();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customWidth, setCustomWidth] = useState('16');
  const [customHeight, setCustomHeight] = useState('9');
  const [error, setError] = useState(false);
  const sliderGesture = useRef(false);
  const knownGeometry = Number.isFinite(width) && Number.isFinite(height) && width >= 2 && height >= 2;
  const locked = disabled || !knownGeometry;
  const label = knownGeometry ? cropLabel(value, width, height, t.original) : value ? t.custom : t.original;
  useEffect(() => { setCustom(!!value && !CROP_PRESETS.includes(label as typeof CROP_PRESETS[number])); }, [label, !!value]);
  const crop = value ?? FULL_CROP;
  const base = knownGeometry ? cropForAspect(crop.width * width / (crop.height * height), width, height) : undefined;
  const areaSize = base ? Math.round(crop.width / base.width * 100) : 100;

  function commit(next?: CropRect) { onBeginChange?.(); onChange(next); onEndChange?.(); }
  function aspect(selection: string) {
    setError(false); setCustom(selection === 'custom');
    if (selection === 'custom') return;
    if (selection === 'original') { commit(undefined); return; }
    const next = cropForAspect(parseAspect(selection)!, width, height, value);
    if (next) commit(next); else setError(true);
  }
  function applyCustom() {
    const ratio = parseAspect(`${customWidth}:${customHeight}`);
    const next = ratio ? cropForAspect(ratio, width, height, value) : undefined;
    setError(!next); if (next) commit(next);
  }
  function finishSlider() { if (sliderGesture.current) { sliderGesture.current = false; onEndChange?.(); } }

  return <details className="crop-editor" onToggle={event => { const next = event.currentTarget.open; setOpen(next); onOpenChange?.(next); }}>
    <summary><span>{t.frame}</span><span className="crop-current">{label}</span></summary>
    <div className="crop-controls">
      <label htmlFor={`${id}-ratio`}>{t.ratio}<select id={`${id}-ratio`} value={custom ? 'custom' : !value ? 'original' : CROP_PRESETS.includes(label as typeof CROP_PRESETS[number]) ? label : 'custom'} disabled={locked} onChange={event => aspect(event.target.value)}>
        <option value="original">{t.original}</option>
        {CROP_PRESETS.map(preset => <option value={preset} key={preset}>{preset}</option>)}
        <option value="custom">{t.custom}</option>
      </select></label>
      {custom && <div className="crop-custom">
        <label>{t.width}<input type="number" min="0.000001" step="any" inputMode="decimal" value={customWidth} disabled={locked} onChange={event => setCustomWidth(event.target.value)} /></label>
        <span aria-hidden="true">:</span>
        <label>{t.height}<input type="number" min="0.000001" step="any" inputMode="decimal" value={customHeight} disabled={locked} onChange={event => setCustomHeight(event.target.value)} /></label>
        <button type="button" className="button secondary" disabled={locked} onClick={applyCustom}>{t.apply}</button>
      </div>}
      {error && <p className="field-hint" role="alert">{t.invalid}</p>}
      {value && <>
        <label className="crop-size">{t.size}<input type="range" min="1" max="100" step="1" value={areaSize} disabled={locked}
          onPointerDown={() => { sliderGesture.current = true; onBeginChange?.(); }} onPointerUp={finishSlider} onPointerCancel={finishSlider} onBlur={finishSlider}
          onChange={event => { if (!sliderGesture.current) onBeginChange?.(); onChange(scaleCrop(crop, Number(event.target.value) / areaSize, width, height)); if (!sliderGesture.current) onEndChange?.(); }} /></label>
        <div className="crop-actions">
          {([[t.left, -1, 0, '←'], [t.up, 0, -1, '↑'], [t.down, 0, 1, '↓'], [t.right, 1, 0, '→']] as const).map(([name, dx, dy, arrow]) => <button type="button" className="icon-button" aria-label={name} title={name} disabled={locked} key={name} onClick={() => commit(moveCrop(crop, dx * 10 / width, dy * 10 / height))}>{arrow}</button>)}
          <button type="button" className="text-button" onClick={() => commit(undefined)}>{t.reset}</button>
        </div>
      </>}
      <p className="field-hint">{disabled ? t.mode : !knownGeometry ? t.pending : t.hint}</p>
    </div>
    {open && !locked && previewContainer && <CropOverlay {...props} previewContainer={previewContainer} />}
  </details>;
}

export function CropOverlay({ value, onChange, displayWidth, displayHeight, locale, previewContainer, onBeginChange, onEndChange }: CropEditorProps & { previewContainer: HTMLElement }) {
  const t = copy[locale];
  const [box, setBox] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const crop = value ?? FULL_CROP;
  const gesture = useRef<{ x: number; y: number; crop: CropRect; mode: 'move' | 'resize'; boxWidth: number; boxHeight: number } | null>(null);
  useEffect(() => {
    let observed: Element | null = null;
    const resize = new ResizeObserver(update);
    function update() {
      const media = previewContainer.querySelector('video, iframe');
      if (!media) { setBox(current => current.width === 0 ? current : { x: 0, y: 0, width: 0, height: 0 }); return; }
      if (observed !== media) { if (observed) resize.unobserve(observed); observed = media; resize.observe(media); }
      const bounds = media.getBoundingClientRect(), parent = previewContainer.getBoundingClientRect();
      const content = containedMediaBox(bounds.width, bounds.height, displayWidth, displayHeight);
      const next = { x: bounds.left - parent.left + content.x, y: bounds.top - parent.top + content.y, width: content.width, height: content.height };
      setBox(current => Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    }
    resize.observe(previewContainer);
    const mutation = new MutationObserver(update); mutation.observe(previewContainer, { childList: true, subtree: true });
    previewContainer.addEventListener('loadedmetadata', update, true); window.addEventListener('resize', update); update();
    return () => { resize.disconnect(); mutation.disconnect(); previewContainer.removeEventListener('loadedmetadata', update, true); window.removeEventListener('resize', update); };
  }, [previewContainer, displayWidth, displayHeight]);

  function begin(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    if (event.button !== 0 || !box.width || !box.height) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { x: event.clientX, y: event.clientY, crop, mode, boxWidth: box.width, boxHeight: box.height }; onBeginChange?.();
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current; if (!current) return;
    event.preventDefault(); event.stopPropagation();
    const dx = (event.clientX - current.x) / current.boxWidth, dy = (event.clientY - current.y) / current.boxHeight;
    if (current.mode === 'move') onChange(moveCrop(current.crop, dx, dy));
    else { const change = Math.abs(dx / current.crop.width) > Math.abs(dy / current.crop.height) ? dx / current.crop.width : dy / current.crop.height; onChange(scaleCrop(current.crop, 1 + 2 * change, displayWidth, displayHeight)); }
  }
  function end(event: ReactPointerEvent<HTMLElement>) {
    if (!gesture.current) return;
    event.stopPropagation(); gesture.current = null; onEndChange?.();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return createPortal(<div className="crop-overlay" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
    <div className="crop-selection" role="group" aria-label={t.move} tabIndex={0} style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
      onPointerDown={event => begin(event, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1; onBeginChange?.();
        onChange(moveCrop(crop, (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) / displayWidth, (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) / displayHeight)); onEndChange?.();
      }}>
      <button type="button" className="crop-resize" aria-label={t.resize} onPointerDown={event => begin(event, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); onBeginChange?.(); onChange(scaleCrop(crop, 1 + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? .1 : .01), displayWidth, displayHeight)); onEndChange?.(); }} />
    </div>
  </div>, previewContainer);
}
