/**
 * ocrWorker.ts
 * Web Worker that runs both OpenCV (image filters) and Tesseract (OCR)
 * in a single thread, keeping the main thread free.
 *
 * Message protocol (main → worker):
 *   { type: 'init' }
 *   { type: 'process', id, rgba, width, height, useV2, useUpscale }
 *   { type: 'detectChatRegion', id, rgba, width, height }
 *   { type: 'setChatRegion', rect }
 *   { type: 'clearChatRegion' }
 *   { type: 'restart' }
 *   { type: 'terminate' }
 *
 * Message protocol (worker → main):
 *   { type: 'ready' }
 *   { type: 'result', id, lines: { text, confidence }[] }
 *   { type: 'error', id, message }
 *   { type: 'log', level, cat, msg, data? }
 *   { type: 'stats', recognitionCount, restartCount, heapUsedMB }
 *   { type: 'restarting', reason }
 *   { type: 'chatRegionResult', id, rect }
 */

/// <reference types="vite/client" />
/* eslint-disable no-restricted-globals */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OcrLine {
  text: string;
  confidence: number;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface ChatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ProcessMessage {
  type: 'process';
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  useV2: boolean;
  useUpscale: boolean;
  useRaw?: boolean; // if true, skip threshold filtering (grayscale + border only)
}

type InboundMessage =
  | { type: 'init' }
  | ProcessMessage
  | { type: 'setChatRegion'; rect: ChatRect | null }
  | { type: 'clearChatRegion' }
  | { type: 'restart' }
  | { type: 'terminate' };

// ---------------------------------------------------------------------------
// Logging helper — sends debug logs to main thread
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', cat: string, msg: string, data?: unknown) {
  self.postMessage({ type: 'log', level, cat, msg, data: data ?? null });
}

// ---------------------------------------------------------------------------
// OpenCV loading (lazy, once)
// ---------------------------------------------------------------------------

let cv: any = null;
let cvReady = false;

async function ensureOpenCV(): Promise<void> {
  if (cvReady) return;

  // We can't use importScripts in a module worker (Vite uses type:'module').
  // Instead, fetch the 225KB patched opencv.js and evaluate it via new Function,
  // binding `self` as `this` so the UMD wrapper's `root.cv = factory()` works.
  // This requires 'unsafe-eval' in the CSP, which is acceptable for a client-side
  // OCR tool — there's no alternative for loading UMD scripts in module workers.
  const w = self as any;

  const resp = await fetch('/opencv.js');
  if (!resp.ok) throw new Error(`Failed to fetch /opencv.js: ${resp.status}`);
  const scriptText = await resp.text();

  // eslint-disable-next-line no-new-func
  const run = new Function(scriptText);
  run.call(w);

  const mod = w.cv;
  if (!mod) {
    throw new Error('OpenCV failed to load — self.cv is undefined after eval');
  }

  // The Emscripten module's WASM compilation is async (fetch + compile).
  // Wait for onRuntimeInitialized via thenable, poll, or direct callback.
  cv = await new Promise<any>((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('OpenCV WASM init timed out after 30s'));
    }, 30_000);

    const done = (val: any) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      // CRITICAL: val is the Emscripten Module which has a .then() method,
      // making it a "thenable". If we pass it directly to resolve(), the
      // Promise spec recursively calls .then() on it, creating an infinite
      // loop. Delete .then() so resolve() treats it as a plain object.
      if (val && typeof val.then === 'function') {
        delete val.then;
      }
      resolve(val);
    };

    // Fast path: already initialized
    if (mod.Mat) { done(mod); return; }

    // Hook the thenable
    if (typeof mod.then === 'function') {
      mod.then((ready: any) => done(ready));
    }

    // Hook onRuntimeInitialized directly as fallback
    const origCb = mod.onRuntimeInitialized;
    mod.onRuntimeInitialized = () => {
      if (origCb) origCb();
      done(mod);
    };

    // Poll fallback — check periodically
    const poll = setInterval(() => {
      if (mod.Mat) { clearInterval(poll); done(mod); }
    }, 100);
    setTimeout(() => clearInterval(poll), 31_000);
  });

  cvReady = !!cv?.Mat;
  if (!cvReady) {
    throw new Error('OpenCV loaded but cv.Mat is not available');
  }
}

// ---------------------------------------------------------------------------
// Tesseract worker (embedded in this web worker)
// ---------------------------------------------------------------------------

let tessWorker: any = null;
let tessReady = false;
let tessRestarting = false; // guard against concurrent restarts

async function ensureTesseract(): Promise<void> {
  if (tessReady && tessWorker) return;
  log('info', 'TESS', 'Importing tesseract.js...');
  const { createWorker } = await import('tesseract.js');

  // Load eng model from app's own public/ directory (not CDN).
  // langPath must NOT have a trailing slash — tesseract.js appends /{lang}.traineddata.gz itself.
  // Use BASE_URL (Vite's base path, e.g. "/" or "/subpath") so this works for subpath deployments.
  const langPath = self.location.origin + (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  log('info', 'TESS', `Creating Tesseract worker with langPath=${langPath}`);
  try {
    tessWorker = await createWorker(
      'eng',
      1, // OEM 1 = LSTM_ONLY
      {
        langPath,
        // Self-host the worker script to avoid importScripts from a nested blob
        // worker, which browsers block under CSP even when the CDN is whitelisted.
        workerPath: `${self.location.origin}/tesseract/worker.min.js`,
        workerBlobURL: false,
        // gzip: true is the default — fetches eng.traineddata.gz and decompresses in-browser
      },
      {
        load_system_dawg: '0',
        load_freq_dawg: '0',
      },
    );
    log('info', 'TESS', 'Tesseract worker created successfully');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'TESS', `Tesseract worker creation FAILED: ${msg}`);
    throw err;
  }
  tessReady = true;
}

async function restartTesseract(reason: string): Promise<void> {
  if (tessRestarting) {
    log('warn', 'TESS', 'Restart already in progress, dropping concurrent request');
    return;
  }
  tessRestarting = true;
  try {
    self.postMessage({ type: 'restarting', reason });
    restartCount++;

    if (tessWorker) {
      try { await tessWorker.terminate(); } catch { /* ignore */ }
      tessWorker = null;
      tessReady = false;
    }
    await ensureTesseract();
  } finally {
    tessRestarting = false;
  }
}

// ---------------------------------------------------------------------------
// Memory monitoring
// ---------------------------------------------------------------------------

let recognitionCount = 0;
let restartCount = 0;

const RESTART_EVERY_N = 50; // restart Tesseract every N recognitions as preventive maintenance
const HEAP_LIMIT_MB = 512; // restart if WASM heap exceeds this

function getHeapUsedMB(): number {
  // performance.memory is Chrome-only, non-standard
  const perf = self.performance as any;
  if (perf?.memory) {
    return Math.round(perf.memory.usedJSHeapSize / (1024 * 1024));
  }
  return 0; // unknown
}

function shouldRestart(): string | null {
  if (recognitionCount > 0 && recognitionCount % RESTART_EVERY_N === 0) {
    return `scheduled restart after ${recognitionCount} recognitions`;
  }
  const heapMB = getHeapUsedMB();
  if (heapMB > HEAP_LIMIT_MB) {
    return `heap exceeded ${HEAP_LIMIT_MB}MB (currently ${heapMB}MB)`;
  }
  return null;
}

function postStats() {
  self.postMessage({
    type: 'stats',
    recognitionCount,
    restartCount,
    heapUsedMB: getHeapUsedMB(),
  });
}

// ---------------------------------------------------------------------------
// Chat region auto-detection
// ---------------------------------------------------------------------------

let chatRegion: ChatRect | null = null;

/**
 * Crop RGBA pixel data to a sub-rectangle.
 */
function cropRgbaData(
  src: Uint8ClampedArray,
  srcWidth: number,
  rect: ChatRect,
): { data: Uint8ClampedArray; width: number; height: number } {
  const dst = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    const srcOff = ((rect.y + row) * srcWidth + rect.x) * 4;
    dst.set(src.subarray(srcOff, srcOff + rect.w * 4), row * rect.w * 4);
  }
  return { data: dst, width: rect.w, height: rect.h };
}


// ---------------------------------------------------------------------------
// OpenCV filter pipelines — 1:1 port of OcrServiceBase.cs
// All cv.Mat objects are explicitly deleted to prevent WASM heap leak.
// ---------------------------------------------------------------------------

/**
 * V2 Pipeline (primary):
 * 1. cvtColor RGBA2GRAY
 * 2. threshold(100, 255, BINARY_INV) → darkText
 * 3. threshold(160, 255, BINARY) → lightText
 * 4. bitwiseOr(darkText, lightText)
 * 5. morphOpen(40, 1) → hLines; subtract(combined, hLines)
 * 6. bitwiseNot → black text on white
 * 7. copyMakeBorder(20px white)
 *
 * Note: dilate(2,2) removed — upscaling handles subpixel gaps better.
 */
function applyFiltersV2(src: any): any {
  const gray = new cv.Mat();
  const darkText = new cv.Mat();
  const lightText = new cv.Mat();
  const combined = new cv.Mat();
  const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(40, 1));
  const hLines = new cv.Mat();
  const cleaned = new cv.Mat();
  const inverted = new cv.Mat();
  let result: any = null;
  try {
    result = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, darkText, 100, 255, cv.THRESH_BINARY_INV);
    cv.threshold(gray, lightText, 160, 255, cv.THRESH_BINARY);
    cv.bitwise_or(darkText, lightText, combined);
    // Remove horizontal lines: morphOpen(40, 1)
    cv.morphologyEx(combined, hLines, cv.MORPH_OPEN, hKernel);
    cv.subtract(combined, hLines, cleaned);
    // Invert so text is black on white
    cv.bitwise_not(cleaned, inverted);
    // Add 20px white border for Tesseract (text near edges is often missed)
    cv.copyMakeBorder(inverted, result, 20, 20, 20, 20, cv.BORDER_CONSTANT, new cv.Scalar(255));
    return result;
  } catch (e) {
    result?.delete();
    throw e;
  } finally {
    gray.delete(); darkText.delete(); lightText.delete(); combined.delete();
    hKernel.delete(); hLines.delete(); cleaned.delete(); inverted.delete();
  }
}

/**
 * V1 Pipeline (fallback):
 * 1. bitwiseNot
 * 2. cvtColor BGR2GRAY
 * 3. threshold(210, 230, BINARY)
 * 4. copyMakeBorder(10, 10, 10, 10, white)
 */
function applyFiltersV1(src: any): any {
  const inverted = new cv.Mat();
  const gray = new cv.Mat();
  const threshed = new cv.Mat();
  let bordered: any = null;
  try {
    bordered = new cv.Mat();
    cv.bitwise_not(src, inverted);
    cv.cvtColor(inverted, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, threshed, 210, 230, cv.THRESH_BINARY);
    cv.copyMakeBorder(threshed, bordered, 10, 10, 10, 10, cv.BORDER_CONSTANT, new cv.Scalar(255));
    return bordered;
  } catch (e) {
    bordered?.delete();
    throw e;
  } finally {
    inverted.delete(); gray.delete(); threshed.delete();
  }
}

/**
 * Raw Pipeline (unfiltered grayscale):
 * Converts to grayscale and adds a 20px white border — no thresholding.
 * Best for colored chat text (orange item drops, green GL messages)
 * that V1/V2 miss due to threshold constraints.
 * 1. cvtColor RGBA2GRAY
 * 2. copyMakeBorder(20px white)
 */
function applyFiltersRaw(src: any): any {
  const gray = new cv.Mat();
  let bordered: any = null;
  try {
    bordered = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.copyMakeBorder(gray, bordered, 20, 20, 20, 20, cv.BORDER_CONSTANT, new cv.Scalar(255));
    return bordered;
  } catch (e) {
    bordered?.delete();
    throw e;
  } finally {
    gray.delete();
  }
}

/**
 * Convert a filtered cv.Mat (grayscale or RGBA) to an OffscreenCanvas for Tesseract.
 *
 * Tesseract.js v7 does NOT support ImageData — it was temporarily added then reverted.
 * OffscreenCanvas is the correct Worker-compatible format: tesseract.js calls
 * canvas.convertToBlob() internally to produce a PNG that Leptonica can read.
 */
function matToOffscreenCanvas(mat: any): OffscreenCanvas {
  const width = mat.cols;
  const height = mat.rows;
  const channels = mat.channels();
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (channels === 1) {
    // Grayscale — expand to RGBA for ImageData / putImageData
    const gray = mat.data as Uint8Array;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      const v = gray[i];
      rgba[j] = v;
      rgba[j + 1] = v;
      rgba[j + 2] = v;
      rgba[j + 3] = 255;
    }
  } else {
    rgba.set(mat.data);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// OCR execution
// ---------------------------------------------------------------------------

async function processImage(
  rgba: ArrayBuffer,
  width: number,
  height: number,
  useV2: boolean,
  useUpscale: boolean,
  useRaw = false,
): Promise<OcrLine[]> {
  await ensureOpenCV();
  await ensureTesseract();

  // Crop to detected chat region first (before upscale — keeps upscale efficient)
  let pixelData = new Uint8ClampedArray(rgba);
  let imgWidth = width;
  let imgHeight = height;

  if (chatRegion) {
    const cropped = cropRgbaData(pixelData, imgWidth, chatRegion);
    pixelData = cropped.data as Uint8ClampedArray<ArrayBuffer>;
    imgWidth = cropped.width;
    imgHeight = cropped.height;
  }

  // Optional 2× nearest-neighbor upscale via OffscreenCanvas (on the cropped region)
  if (useUpscale) {
    const srcCanvas = new OffscreenCanvas(imgWidth, imgHeight);
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.putImageData(new ImageData(pixelData, imgWidth, imgHeight), 0, 0);

    const dstWidth = imgWidth * 2;
    const dstHeight = imgHeight * 2;
    const dstCanvas = new OffscreenCanvas(dstWidth, dstHeight);
    const dstCtx = dstCanvas.getContext('2d')!;
    dstCtx.imageSmoothingEnabled = false; // nearest-neighbor
    dstCtx.drawImage(srcCanvas, 0, 0, dstWidth, dstHeight);

    const upscaled = dstCtx.getImageData(0, 0, dstWidth, dstHeight);
    pixelData = upscaled.data as unknown as Uint8ClampedArray<ArrayBuffer>;
    imgWidth = dstWidth;
    imgHeight = dstHeight;
  }

  // Create cv.Mat from RGBA pixels
  const src = cv.matFromImageData({ data: pixelData, width: imgWidth, height: imgHeight });

  // Apply filter pipeline
  let filtered: any;
  try {
    filtered = useRaw ? applyFiltersRaw(src) : (useV2 ? applyFiltersV2(src) : applyFiltersV1(src));
  } finally {
    src.delete();
  }

  // Defensive: applyFilters returned null/undefined without throwing (should not happen in practice).
  if (!filtered) throw new Error('Filter pipeline produced no output');

  // Convert filtered Mat to OffscreenCanvas for Tesseract.
  // ImageData is NOT supported in tesseract.js v7 (support was reverted).
  // OffscreenCanvas is the correct Worker-compatible format — tesseract.js calls
  // canvas.convertToBlob() → PNG internally, which Leptonica can decode.
  // user_defined_dpi: '300' matches the DPI we previously embedded in TIFF headers,
  // ensuring Tesseract's font-size heuristics stay calibrated for small game text.
  const canvas = matToOffscreenCanvas(filtered);
  filtered.delete();

  // Run Tesseract recognition
  // PSM 6 = assume a single uniform block of text (best for chat regions)
  const result = await tessWorker!.recognize(
    canvas,
    { tessedit_pageseg_mode: '6', user_defined_dpi: '300' },
    { blocks: true },
  );
  const lines: OcrLine[] = [];
  if (result.data.blocks) {
    for (const block of result.data.blocks) {
      if (!block.paragraphs) continue;
      for (const para of block.paragraphs) {
        if (!para.lines) continue;
        for (const line of para.lines) {
          const text = (line.text || '')
            .replace(/\n$/, '')
            .replace(/[|]+\s*$/, '')  // strip trailing | (OCR artifact from chat border)
            .replace(/^[|lIJBb}\]]{1,3}\s*(?=\[?\d)/, '')  // strip 1-3 leading border misreads before [timestamp]
            .replace(/\b(xx\s?[:.,;]\s?)(\d{2})\d+/gi, '$1$2')  // normalise xx:4515 → xx:45 (OCR merges tokens)
            .trim();
          // Skip micro-fragments (< 4 alphanumeric chars) — OCR noise like "ars]" or "I"
          if (text && text.replace(/[^a-zA-Z0-9]/g, '').length >= 4) {
            const b = line.bbox;
            lines.push({
              text,
              confidence: line.confidence ?? 0,
              ...(b ? { bbox: { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } } : {}),
            });
          }
        }
      }
    }
  }

  recognitionCount++;

  // Check if we need a preventive restart
  const reason = shouldRestart();
  if (reason) {
    await restartTesseract(reason);
  }

  postStats();
  return lines;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<InboundMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      try {
        await ensureOpenCV();
        await ensureTesseract();
        self.postMessage({ type: 'ready' });
      } catch (err: any) {
        self.postMessage({ type: 'error', id: -1, message: err.message });
      }
      break;
    }

    case 'process': {
      const { id, rgba, width, height, useV2, useUpscale, useRaw = false } = msg;
      try {
        const lines = await processImage(rgba, width, height, useV2, useUpscale, useRaw);
        self.postMessage({ type: 'result', id, lines });
      } catch (err: any) {
        self.postMessage({ type: 'error', id, message: err.message });

        // Restart on any processing error
        try {
          await restartTesseract(`error during processing: ${err.message}`);
        } catch { /* best effort */ }
      }
      break;
    }


    case 'setChatRegion': {
      chatRegion = msg.rect;
      break;
    }

    case 'clearChatRegion': {
      chatRegion = null;
      break;
    }

    case 'restart': {
      if (tessWorker) {
        try { await tessWorker.terminate(); } catch { /* ignore */ }
        tessWorker = null;
        tessReady = false;
      }
      // OpenCV WASM can't be cleanly unloaded, but terminating the worker
      // (self.close()) will reclaim all memory
      self.close();
      break;
    }

    case 'terminate': {
      if (tessWorker) {
        try { await tessWorker.terminate(); } catch { /* ignore */ }
        tessWorker = null;
        tessReady = false;
      }
      self.close();
      break;
    }
  }
};
