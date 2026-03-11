/**
 * imageFilters.ts
 * @deprecated — Production now uses ocrWorker.ts which runs OpenCV WASM filters.
 * This pure-TS implementation is kept for unit tests (which run in Node/Vitest
 * where OpenCV WASM is not available) and as a readable reference.
 *
 * Pure TS port of OcrServiceBase.cs filter pipelines (V1 and V2).
 * Operates on { data: Uint8Array, width, height } grayscale buffers.
 * Canvas returns RGBA (not BGR) — grayscale uses 0.299*R + 0.587*G + 0.114*B.
 */

interface GrayBuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Internal gray buffer helpers
// ---------------------------------------------------------------------------

/** Convert RGBA ImageData to grayscale { data, width, height } */
export function rgbaToGray(imageData: ImageData): GrayBuffer {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    out[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return { data: out, width, height };
}

/** Convert grayscale { data, width, height } back to ImageData (RGBA) */
export function grayToImageData(gray: GrayBuffer): ImageData {
  const { data, width, height } = gray;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const v = data[i];
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return new ImageData(out, width, height);
}

// ---------------------------------------------------------------------------
// Pixel operations
// ---------------------------------------------------------------------------

/**
 * BINARY threshold: pixel >= thresh → maxval, else 0
 * BINARY_INV threshold: pixel >= thresh → 0, else maxval
 */
export function threshold(src: GrayBuffer, thresh: number, maxval: number, invert = false): GrayBuffer {
  const out = new Uint8Array(src.data.length);
  for (let i = 0; i < src.data.length; i++) {
    const v = src.data[i];
    if (invert) {
      out[i] = v >= thresh ? 0 : maxval;
    } else {
      out[i] = v >= thresh ? maxval : 0;
    }
  }
  return { data: out, width: src.width, height: src.height };
}

/** Per-pixel bitwise OR */
export function bitwiseOr(a: GrayBuffer, b: GrayBuffer): GrayBuffer {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) {
    out[i] = a.data[i] | b.data[i];
  }
  return { data: out, width: a.width, height: a.height };
}

/** Per-pixel bitwise NOT (255 - pixel) */
export function bitwiseNot(src: GrayBuffer): GrayBuffer {
  const out = new Uint8Array(src.data.length);
  for (let i = 0; i < src.data.length; i++) {
    out[i] = 255 - src.data[i];
  }
  return { data: out, width: src.width, height: src.height };
}

/** Saturating subtract: max(0, a - b) per pixel */
export function subtract(a: GrayBuffer, b: GrayBuffer): GrayBuffer {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) {
    out[i] = Math.max(0, a.data[i] - b.data[i]);
  }
  return { data: out, width: a.width, height: a.height };
}

// ---------------------------------------------------------------------------
// Morphological operations
// ---------------------------------------------------------------------------

/**
 * Dilation (max-filter) with rectangular kernel of size kw × kh.
 * Matches OpenCV GetStructuringElement(Rect, Size(kw, kh)) with default anchor.
 * OpenCV anchor = (kw/2, kh/2) (integer division).
 * Kernel covers x offsets [-anchorX, kw - anchorX - 1] and y offsets [-anchorY, kh - anchorY - 1].
 * e.g. Size(2,2) → anchor=(1,1) → offsets [-1, 0] in both axes → exactly 2×2 kernel.
 * e.g. Size(40,1) → anchor=(20,0) → x offsets [-20, 19], y offset [0, 0] → exactly 40×1 kernel.
 */
export function dilate(src: GrayBuffer, kw: number, kh: number): GrayBuffer {
  const { data, width, height } = src;
  const out = new Uint8Array(data.length);
  const anchorX = Math.floor(kw / 2);
  const anchorY = Math.floor(kh / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxVal = 0;
      for (let dy = -anchorY; dy < kh - anchorY; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -anchorX; dx < kw - anchorX; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          const v = data[ny * width + nx];
          if (v > maxVal) maxVal = v;
        }
      }
      out[y * width + x] = maxVal;
    }
  }
  return { data: out, width, height };
}

/**
 * Erosion (min-filter) with rectangular kernel of size kw × kh.
 * Same anchor/offset logic as dilate — matches OpenCV exactly.
 */
export function erode(src: GrayBuffer, kw: number, kh: number): GrayBuffer {
  const { data, width, height } = src;
  const out = new Uint8Array(data.length);
  const anchorX = Math.floor(kw / 2);
  const anchorY = Math.floor(kh / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255;
      for (let dy = -anchorY; dy < kh - anchorY; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -anchorX; dx < kw - anchorX; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          const v = data[ny * width + nx];
          if (v < minVal) minVal = v;
        }
      }
      out[y * width + x] = minVal;
    }
  }
  return { data: out, width, height };
}

/** Morphological open: erode then dilate */
export function morphOpen(src: GrayBuffer, kw: number, kh: number): GrayBuffer {
  return dilate(erode(src, kw, kh), kw, kh);
}

/** Add constant-value border around image */
export function copyMakeBorder(src: GrayBuffer, top: number, bottom: number, left: number, right: number, value = 255): GrayBuffer {
  const { data, width, height } = src;
  const newWidth = width + left + right;
  const newHeight = height + top + bottom;
  const out = new Uint8Array(newWidth * newHeight).fill(value);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(y + top) * newWidth + (x + left)] = data[y * width + x];
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

// ---------------------------------------------------------------------------
// Upscaling
// ---------------------------------------------------------------------------

/**
 * 2× nearest-neighbor upscale of a grayscale buffer.
 * Each pixel becomes a 2×2 block — preserves sharp pixel-font edges.
 */
export function upscale2x(src: GrayBuffer): GrayBuffer {
  const { data, width, height } = src;
  const newWidth = width * 2;
  const newHeight = height * 2;
  const out = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const ny = y * 2;
      const nx = x * 2;
      out[ny * newWidth + nx] = v;
      out[ny * newWidth + nx + 1] = v;
      out[(ny + 1) * newWidth + nx] = v;
      out[(ny + 1) * newWidth + nx + 1] = v;
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

// ---------------------------------------------------------------------------
// Filter Pipelines
// ---------------------------------------------------------------------------

/**
 * V2 Pipeline (primary):
 * 1. rgbaToGray
 * 2. threshold(100, 255, invert=true)  → darkText
 * 3. threshold(160, 255, invert=false) → lightText
 * 4. bitwiseOr(darkText, lightText)
 * 5. morphOpen(hKernelW, 1) → hLines; subtract(combined, hLines)
 * 6. bitwiseNot → black text on white
 * 7. copyMakeBorder(20px white)
 *
 * Note: dilate(2,2) removed — upscaling handles subpixel gaps better.
 */
export function applyFiltersV2(imageData: ImageData): ImageData {
  const gray = rgbaToGray(imageData);
  const darkText = threshold(gray, 100, 255, true);
  const lightText = threshold(gray, 160, 255, false);
  const combined = bitwiseOr(darkText, lightText);

  // Horizontal line removal: morphOpen(40, 1)
  const hLines = morphOpen(combined, 40, 1);
  const cleaned = subtract(combined, hLines);

  const inverted = bitwiseNot(cleaned);
  const bordered = copyMakeBorder(inverted, 20, 20, 20, 20, 255);
  return grayToImageData(bordered);
}

/**
 * V1 Pipeline (fallback):
 * 1. rgbaToGray
 * 2. bitwiseNot
 * 3. threshold(210, 230, invert=false)
 * 4. copyMakeBorder(10, 10, 10, 10, 255)
 */
export function applyFiltersV1(imageData: ImageData): ImageData {
  const gray = rgbaToGray(imageData);
  const inverted = bitwiseNot(gray);
  const thresholded = threshold(inverted, 210, 230, false);
  const bordered = copyMakeBorder(thresholded, 10, 10, 10, 10, 255);
  return grayToImageData(bordered);
}

/**
 * Raw Pipeline (unfiltered grayscale):
 * Converts to grayscale and adds a border — no thresholding.
 * Best for colored chat text (orange item drops, green GL messages)
 * that V1/V2 struggle with due to threshold requirements.
 * 1. rgbaToGray
 * 2. copyMakeBorder(20px white)
 */
export function applyFiltersRaw(imageData: ImageData): ImageData {
  const gray = rgbaToGray(imageData);
  const bordered = copyMakeBorder(gray, 20, 20, 20, 20, 255);
  return grayToImageData(bordered);
}
