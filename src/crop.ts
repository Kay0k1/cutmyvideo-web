export interface CropRect { x: number; y: number; width: number; height: number; }
export const CROP_PRESETS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'] as const;
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export function validCrop(value: unknown): value is CropRect {
  if (!value || typeof value !== 'object') return false;
  const r = value as CropRect;
  return [r.x, r.y, r.width, r.height].every(v => typeof v === 'number' && Number.isFinite(v))
    && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1 && r.y + r.height <= 1;
}

export function parseAspect(value: string): number | null {
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

export function cropForAspect(ratio: number, displayWidth: number, displayHeight: number, previous?: CropRect): CropRect | undefined {
  if (![ratio, displayWidth, displayHeight].every(v => Number.isFinite(v) && v > 0)) return;
  const normalizedRatio = ratio / (displayWidth / displayHeight);
  const width = Math.min(1, normalizedRatio), height = Math.min(1, 1 / normalizedRatio);
  if (width * displayWidth < 2 || height * displayHeight < 2) return;
  const centerX = previous ? previous.x + previous.width / 2 : .5;
  const centerY = previous ? previous.y + previous.height / 2 : .5;
  return { x: Math.max(0, Math.min(1 - width, centerX - width / 2)), y: Math.max(0, Math.min(1 - height, centerY - height / 2)), width, height };
}

export function moveCrop(crop: CropRect, dx: number, dy: number): CropRect {
  return { ...crop, x: Math.max(0, Math.min(1 - crop.width, crop.x + dx)), y: Math.max(0, Math.min(1 - crop.height, crop.y + dy)) };
}

// Scale around the current center without changing the chosen aspect ratio.
export function scaleCrop(crop: CropRect, factor: number, displayWidth: number, displayHeight: number): CropRect {
  const centerX = crop.x + crop.width / 2, centerY = crop.y + crop.height / 2;
  const minimum = Math.max(2 / displayWidth / crop.width, 2 / displayHeight / crop.height);
  const maximum = Math.min(2 * Math.min(centerX, 1 - centerX) / crop.width, 2 * Math.min(centerY, 1 - centerY) / crop.height);
  const f = Math.min(maximum, Math.max(minimum, factor));
  const width = crop.width * f, height = crop.height * f;
  return { x: Math.max(0, centerX - width / 2), y: Math.max(0, centerY - height / 2), width, height };
}

// This is object-fit:contain geometry, not the surrounding 16:9 player box.
export function containedMediaBox(boxWidth: number, boxHeight: number, imageWidth: number, imageHeight: number) {
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = imageWidth * scale, height = imageHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}
