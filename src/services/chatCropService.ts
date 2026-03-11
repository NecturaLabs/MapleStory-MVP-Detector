// Matches the V2 and Raw filter pipelines in ocrWorker.ts (copyMakeBorder with 20px).
// V1 uses 10px — if V1 is ever re-enabled, this constant must be passed dynamically.
const BORDER_PX = 20;

/**
 * Map a Tesseract bbox (processed-image space: after upscale + 20px border)
 * back to raw-frame pixel coordinates.
 */
export function mapBboxToRaw(
  bbox: { x: number; y: number; w: number; h: number },
  useUpscale: boolean,
): { x: number; y: number; w: number; h: number } {
  const scale = useUpscale ? 2 : 1;
  return {
    x: Math.max(0, (bbox.x - BORDER_PX) / scale),
    y: Math.max(0, (bbox.y - BORDER_PX) / scale),
    w: bbox.w / scale,
    h: bbox.h / scale,
  };
}

/**
 * Compute the union of all rects, add padding on each side, clamp to frame.
 * Returns null if rects is empty or the clamped result is degenerate.
 */
export function unionRect(
  rects: { x: number; y: number; w: number; h: number }[],
  padPx: number,
  frameW: number,
  frameH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (rects.length === 0) return null;

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }

  x1 = Math.max(0, Math.floor(x1 - padPx));
  y1 = Math.max(0, Math.floor(y1 - padPx));
  x2 = Math.min(frameW, Math.ceil(x2 + padPx));
  y2 = Math.min(frameH, Math.ceil(y2 + padPx));

  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Remove rects whose width exceeds 2× the median width across all input rects.
 * Tesseract sometimes groups a chat line with distant UI elements on the same
 * screen row, producing an anomalously wide bbox that stretches the union rect
 * to full frame width. Returns the input array unchanged if it has < 3 elements
 * (not enough data for a reliable median) or if filtering would leave nothing.
 */
export function filterOutlierWidths(
  rects: { x: number; y: number; w: number; h: number }[],
): { x: number; y: number; w: number; h: number }[] {
  if (rects.length < 3) return rects;
  const sorted = [...rects].sort((a, b) => a.w - b.w);
  const medianW = sorted[Math.floor(sorted.length / 2)]!.w;
  const filtered = rects.filter((r) => r.w <= medianW * 2);
  return filtered.length > 0 ? filtered : rects;
}

/**
 * Copy a rectangular RGBA region out of a flat pixel buffer.
 * Row-by-row copy — no canvas required.
 */
export function cropRgba(
  pixels: Uint8ClampedArray,
  frameW: number,
  crop: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(crop.w * crop.h * 4);
  for (let row = 0; row < crop.h; row++) {
    const srcStart = ((crop.y + row) * frameW + crop.x) * 4;
    const dstStart = row * crop.w * 4;
    out.set(pixels.subarray(srcStart, srcStart + crop.w * 4), dstStart);
  }
  return out;
}
