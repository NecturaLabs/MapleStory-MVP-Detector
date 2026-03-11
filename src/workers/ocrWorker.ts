/**
 * ocrWorker.ts
 * Web Worker that runs both OpenCV (image filters) and Tesseract (OCR)
 * in a single thread, keeping the main thread free.
 *
 * Message protocol (main → worker):
 *   { type: 'init' }
 *   { type: 'process', id, rgba, width, height, useUpscale, useMultiFilter }
 *   { type: 'setChatRegion', rect }
 *   { type: 'clearChatRegion' }
 *   { type: 'restart' }
 *   { type: 'terminate' }
 *
 * Message protocol (worker → main):
 *   { type: 'ready' }
 *   { type: 'result', id, v2Lines, rawLines }
 *   { type: 'error', id, message }
 *   { type: 'log', level, cat, msg, data? }
 *   { type: 'stats', recognitionCount, restartCount, heapUsedMB }
 *   { type: 'restarting', reason }
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
  useUpscale: boolean;
  useMultiFilter: boolean;
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
// Tesseract workers (embedded in this web worker)
// tessWorker  — V2 filter pass (always used)
// tessWorker2 — Raw filter pass (used when useMultiFilter=true)
// Both are initialized eagerly so they're warm before capture starts.
// Running both recognize() calls concurrently on separate workers gives true
// parallelism since each is its own nested worker on a separate OS thread.
// ---------------------------------------------------------------------------

let tessWorker: any  = null;
let tessWorker2: any = null;
let tessReady  = false;
let tessReady2 = false;
let tessRestarting = false; // guard against concurrent restarts

async function createTessWorkerInstance(): Promise<any> {
  const { createWorker } = await import('tesseract.js');
  // Load eng model from app's own public/ directory (not CDN).
  // langPath must NOT have a trailing slash — tesseract.js appends /{lang}.traineddata.gz itself.
  const langPath = self.location.origin + (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return createWorker(
    'eng',
    1, // OEM 1 = LSTM_ONLY
    {
      langPath,
      // Self-host the worker script to avoid importScripts from a nested blob
      // worker, which browsers block under CSP even when the CDN is whitelisted.
      workerPath: `${self.location.origin}/tesseract/worker.min.js`,
      workerBlobURL: false,
    },
    {
      load_system_dawg: '0',
      load_freq_dawg: '0',
    },
  );
}

async function ensureTesseract(): Promise<void> {
  if (tessReady && tessWorker && tessReady2 && tessWorker2) return;

  log('info', 'TESS', 'Initializing Tesseract workers (parallel)…');

  // Init both workers concurrently — they share cached WASM + traineddata
  // so concurrent init ≈ the same wall-clock time as a single init.
  const [w1, w2] = await Promise.all([
    (!tessReady || !tessWorker)
      ? createTessWorkerInstance()
      : Promise.resolve(tessWorker),
    (!tessReady2 || !tessWorker2)
      ? createTessWorkerInstance()
      : Promise.resolve(tessWorker2),
  ]);

  tessWorker  = w1; tessReady  = true;
  tessWorker2 = w2; tessReady2 = true;
  log('info', 'TESS', 'Both Tesseract workers ready');
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

    // Terminate both workers in parallel
    await Promise.all([
      tessWorker  ? tessWorker.terminate().catch(() => {})  : Promise.resolve(),
      tessWorker2 ? tessWorker2.terminate().catch(() => {}) : Promise.resolve(),
    ]);
    tessWorker = null; tessWorker2 = null;
    tessReady  = false; tessReady2  = false;

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
  const perf = self.performance as any;
  if (perf?.memory) {
    return Math.round(perf.memory.usedJSHeapSize / (1024 * 1024));
  }
  return 0;
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
// Chat region
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
 * Raw Pipeline (unfiltered grayscale):
 * Converts to grayscale and adds a 20px white border — no thresholding.
 * Best for colored chat text (orange item drops, green GL messages)
 * that V2 misses due to threshold constraints.
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

// ---------------------------------------------------------------------------
// BMP encoding — synchronous alternative to OffscreenCanvas → convertToBlob()
//
// Tesseract.js v7 accepts Uint8Array image data. Passing a BMP avoids the
// async OffscreenCanvas.convertToBlob() call that was adding ~100-500ms per
// pass. Leptonica reads BMP in microseconds (no decompression needed).
// DPI is encoded in the BMP header so user_defined_dpi is not required.
// ---------------------------------------------------------------------------

/**
 * Convert a single-channel (grayscale) cv.Mat to an 8-bit BMP Uint8Array.
 * BMP is uncompressed: Leptonica reads it with a memcpy, no decode overhead.
 * 300 DPI is encoded in the BITMAPINFOHEADER (11811 pixels/meter).
 */
function matToBmpBuffer(mat: any): Uint8Array {
  const w = mat.cols;
  const h = mat.rows;
  const gray = mat.data as Uint8Array; // single-channel after filtering

  const FILE_HDR  = 14;
  const DIB_HDR   = 40;
  const PALETTE   = 256 * 4;          // 256 grayscale RGBQUAD entries
  const rowStride = (w + 3) & ~3;     // each row padded to multiple of 4 bytes
  const pixBytes  = rowStride * h;
  const total     = FILE_HDR + DIB_HDR + PALETTE + pixBytes;

  const buf = new Uint8Array(total);   // zero-initialized
  const dv  = new DataView(buf.buffer);

  // ── BITMAPFILEHEADER ──
  buf[0] = 0x42; buf[1] = 0x4D;       // 'BM'
  dv.setUint32(2,  total,                       true); // bfSize
  // bfReserved1 + bfReserved2 = 0 (already zero)
  dv.setUint32(10, FILE_HDR + DIB_HDR + PALETTE, true); // bfOffBits

  // ── BITMAPINFOHEADER ──
  dv.setUint32(14, DIB_HDR, true); // biSize
  dv.setInt32 (18, w,       true); // biWidth
  dv.setInt32 (22, -h,      true); // biHeight (negative → top-down, no row reversal needed)
  dv.setUint16(26, 1,       true); // biPlanes
  dv.setUint16(28, 8,       true); // biBitCount (8-bit palette)
  // biCompression = 0 (BI_RGB, already zero)
  dv.setUint32(34, pixBytes, true); // biSizeImage
  dv.setInt32 (38, 11811,   true); // biXPelsPerMeter (300 DPI = 300/0.0254 ≈ 11811)
  dv.setInt32 (42, 11811,   true); // biYPelsPerMeter
  dv.setUint32(46, 256,     true); // biClrUsed
  // biClrImportant = 0 (already zero)

  // ── Grayscale color table ──
  const pOff = FILE_HDR + DIB_HDR;
  for (let i = 0; i < 256; i++) {
    const o = pOff + i * 4;
    buf[o] = buf[o + 1] = buf[o + 2] = i; // R=G=B=i, reserved=0
  }

  // ── Pixel data (top-down rows, each padded to rowStride) ──
  const dOff = pOff + PALETTE;
  if (rowStride === w) {
    buf.set(gray, dOff); // no padding — direct copy
  } else {
    for (let r = 0; r < h; r++) {
      buf.set(gray.subarray(r * w, r * w + w), dOff + r * rowStride);
    }
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

function parseOcrResult(result: any): OcrLine[] {
  if (!result?.data?.blocks) return [];
  const lines: OcrLine[] = [];
  for (const block of result.data.blocks) {
    if (!block.paragraphs) continue;
    for (const para of block.paragraphs) {
      if (!para.lines) continue;
      for (const line of para.lines) {
        const text = (line.text || '')
          .replace(/\n$/, '')
          .replace(/[|]+\s*$/, '')  // strip trailing | (OCR artifact from chat border)
          .replace(/^[|lIJBb}\]]{1,3}\s*(?=\[?\d)/, '')  // strip 1-3 leading border misreads before [timestamp]
          .replace(/\b(xx\s?[:.,;]\s?)(\d{2})\d+/gi, '$1$2')  // normalise xx:4515 → xx:45
          .trim();
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
  return lines;
}

// ---------------------------------------------------------------------------
// OCR execution
// ---------------------------------------------------------------------------

async function processImage(
  rgba: ArrayBuffer,
  width: number,
  height: number,
  useUpscale: boolean,
  useMultiFilter: boolean,
): Promise<{ v2Lines: OcrLine[]; rawLines: OcrLine[] }> {
  await ensureOpenCV();
  await ensureTesseract();

  // Crop to user-defined chat region first (before upscale — keeps upscale efficient)
  let pixelData = new Uint8ClampedArray(rgba);
  let imgWidth  = width;
  let imgHeight = height;

  if (chatRegion) {
    const cropped = cropRgbaData(pixelData, imgWidth, chatRegion);
    pixelData = cropped.data as Uint8ClampedArray<ArrayBuffer>;
    imgWidth  = cropped.width;
    imgHeight = cropped.height;
  }

  // Optional 2× nearest-neighbor upscale (on the cropped region)
  if (useUpscale) {
    const srcCanvas = new OffscreenCanvas(imgWidth, imgHeight);
    srcCanvas.getContext('2d')!.putImageData(new ImageData(pixelData, imgWidth, imgHeight), 0, 0);

    const dstW = imgWidth * 2;
    const dstH = imgHeight * 2;
    const dstCanvas = new OffscreenCanvas(dstW, dstH);
    const dstCtx = dstCanvas.getContext('2d')!;
    dstCtx.imageSmoothingEnabled = false; // nearest-neighbor
    dstCtx.drawImage(srcCanvas, 0, 0, dstW, dstH);

    const upscaled = dstCtx.getImageData(0, 0, dstW, dstH);
    pixelData = upscaled.data as unknown as Uint8ClampedArray<ArrayBuffer>;
    imgWidth  = dstW;
    imgHeight = dstH;
  }

  // Create cv.Mat from RGBA pixels (shared source for both filter passes)
  const src = cv.matFromImageData({ data: pixelData, width: imgWidth, height: imgHeight });

  // Apply V2 filter → BMP (synchronous, no PNG encoding overhead)
  let filteredV2: any;
  try {
    filteredV2 = applyFiltersV2(src);
  } catch (e) {
    src.delete();
    throw e;
  }
  const bmpV2 = matToBmpBuffer(filteredV2);
  filteredV2.delete();

  // Apply Raw filter → BMP (only when useMultiFilter)
  let bmpRaw: Uint8Array | null = null;
  if (useMultiFilter) {
    let filteredRaw: any;
    try {
      filteredRaw = applyFiltersRaw(src);
    } catch (e) {
      src.delete();
      throw e;
    }
    bmpRaw = matToBmpBuffer(filteredRaw);
    filteredRaw.delete();
  }

  src.delete();

  // Run both recognitions concurrently — tessWorker and tessWorker2 are separate
  // nested workers (each on its own OS thread), so this gives true parallelism.
  // Total wall-clock time = max(V2, Raw) instead of V2 + Raw.
  const tessOptions = { tessedit_pageseg_mode: '6' }; // DPI embedded in BMP header
  const tessOutput  = { blocks: true };

  const [v2Result, rawResult] = await Promise.all([
    tessWorker!.recognize(bmpV2, tessOptions, tessOutput),
    bmpRaw ? tessWorker2!.recognize(bmpRaw, tessOptions, tessOutput) : Promise.resolve(null),
  ]);

  // Count recognitions (2 if multiFilter, 1 otherwise) for restart scheduling
  recognitionCount += useMultiFilter ? 2 : 1;

  const reason = shouldRestart();
  if (reason) {
    await restartTesseract(reason);
  }

  postStats();

  return {
    v2Lines:  parseOcrResult(v2Result),
    rawLines: rawResult ? parseOcrResult(rawResult) : [],
  };
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
      const { id, rgba, width, height, useUpscale, useMultiFilter } = msg;
      try {
        const { v2Lines, rawLines } = await processImage(rgba, width, height, useUpscale, useMultiFilter);
        self.postMessage({ type: 'result', id, v2Lines, rawLines });
      } catch (err: any) {
        self.postMessage({ type: 'error', id, message: err.message });
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
      if (tessWorker)  { try { await tessWorker.terminate();  } catch { /* ignore */ } }
      if (tessWorker2) { try { await tessWorker2.terminate(); } catch { /* ignore */ } }
      tessWorker = null; tessWorker2 = null;
      tessReady  = false; tessReady2  = false;
      self.close();
      break;
    }

    case 'terminate': {
      if (tessWorker)  { try { await tessWorker.terminate();  } catch { /* ignore */ } }
      if (tessWorker2) { try { await tessWorker2.terminate(); } catch { /* ignore */ } }
      tessWorker = null; tessWorker2 = null;
      tessReady  = false; tessReady2  = false;
      self.close();
      break;
    }
  }
};
