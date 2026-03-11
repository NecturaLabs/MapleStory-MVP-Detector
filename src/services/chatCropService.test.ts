import { describe, it, expect } from 'vitest';
import { mapBboxToRaw, unionRect, cropRgba, filterOutlierWidths } from './chatCropService.ts';

describe('mapBboxToRaw', () => {
  it('reverses 2× upscale and 20px border', () => {
    expect(mapBboxToRaw({ x: 60, y: 60, w: 200, h: 40 }, true))
      .toEqual({ x: 20, y: 20, w: 100, h: 20 });
  });

  it('reverses 20px border only when no upscale', () => {
    expect(mapBboxToRaw({ x: 60, y: 60, w: 200, h: 40 }, false))
      .toEqual({ x: 40, y: 40, w: 200, h: 40 });
  });

  it('clamps negative coords to zero', () => {
    const r = mapBboxToRaw({ x: 10, y: 10, w: 40, h: 20 }, true);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});

describe('unionRect', () => {
  it('returns null for empty input', () => {
    expect(unionRect([], 20, 1000, 1000)).toBeNull();
  });

  it('unions two rects and applies padding', () => {
    const rects = [
      { x: 100, y: 200, w: 400, h: 30 },
      { x: 100, y: 240, w: 400, h: 30 },
    ];
    // union: x1=100 y1=200 x2=500 y2=270 → pad 20 → x1=80 y1=180 x2=520 y2=290
    expect(unionRect(rects, 20, 2872, 1584))
      .toEqual({ x: 80, y: 180, w: 440, h: 110 });
  });

  it('clamps padding to frame bounds', () => {
    const rects = [{ x: 5, y: 5, w: 100, h: 30 }];
    const result = unionRect(rects, 20, 200, 100);
    expect(result?.x).toBe(0);
    expect(result?.y).toBe(0);
    expect(result?.w).toBeLessThanOrEqual(200);
    expect(result?.h).toBeLessThanOrEqual(100);
  });

  it('returns null when clamped rect is degenerate', () => {
    const rects = [{ x: 300, y: 300, w: 10, h: 10 }];
    expect(unionRect(rects, 20, 50, 50)).toBeNull();
  });
});

describe('filterOutlierWidths', () => {
  it('removes rects wider than 2× the median', () => {
    const rects = [
      { x: 0, y: 0, w: 100, h: 30 },
      { x: 0, y: 30, w: 110, h: 30 },
      { x: 0, y: 60, w: 105, h: 30 },
      { x: 0, y: 90, w: 900, h: 30 }, // outlier: 900 > 2×105 = 210
    ];
    const result = filterOutlierWidths(rects);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.w <= 110)).toBe(true);
  });

  it('returns input unchanged when fewer than 3 rects', () => {
    const rects = [{ x: 0, y: 0, w: 5000, h: 30 }];
    expect(filterOutlierWidths(rects)).toBe(rects);
  });

  it('returns input unchanged when all rects would be filtered', () => {
    // Degenerate: all widths are equal — median * 2 = same, none excluded
    const rects = [
      { x: 0, y: 0, w: 100, h: 30 },
      { x: 0, y: 30, w: 100, h: 30 },
      { x: 0, y: 60, w: 100, h: 30 },
    ];
    expect(filterOutlierWidths(rects)).toEqual(rects);
  });
});

describe('cropRgba', () => {
  it('extracts the correct pixel region', () => {
    // 4×2 RGBA frame; red pixel at x=2, y=1 → byte index (1*4+2)*4 = 24
    const pixels = new Uint8ClampedArray(4 * 2 * 4);
    pixels[24] = 255; // R
    const crop = cropRgba(pixels, 4, { x: 2, y: 1, w: 1, h: 1 });
    expect(crop.length).toBe(4);
    expect(crop[0]).toBe(255);
  });

  it('returns a buffer of the correct size', () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4);
    const crop = cropRgba(pixels, 10, { x: 2, y: 2, w: 5, h: 3 });
    expect(crop.length).toBe(5 * 3 * 4);
  });
});
