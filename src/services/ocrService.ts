/**
 * ocrService.ts
 * Main-thread wrapper around the ocrWorker Web Worker.
 *
 * Features:
 * - Promise queue: requests are serialized, no messages dropped
 * - Timeout per request (10s) — on timeout, restarts worker, resolves with []
 * - Memory-pressure restarts delegated to worker internals
 * - Debug log callback for ring buffer integration
 */

export interface OcrLine {
  text: string;
  confidence: number;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface WorkerStats {
  recognitionCount: number;
  restartCount: number;
  heapUsedMB: number;
}

type LogCallback = (level: 'info' | 'warn' | 'error', cat: string, msg: string, data?: unknown) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let nextId = 1;
let recreating = false; // guard against concurrent recreateWorker calls
let logCallback: LogCallback = () => {};
let latestStats: WorkerStats = { recognitionCount: 0, restartCount: 0, heapUsedMB: 0 };

// Promise queue — ensures only one recognition is in-flight at a time
let queueTail: Promise<void> = Promise.resolve();

// Pending request callbacks keyed by request id
const pending = new Map<number, {
  resolve: (lines: OcrLine[]) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

function createWorkerInstance(): Worker {
  const w = new Worker(
    new URL('../workers/ocrWorker.ts', import.meta.url),
    { type: 'module' },
  );

  w.onmessage = (e) => {
    const msg = e.data;

    switch (msg.type) {
      case 'ready':
        logCallback('info', 'WORKER', 'Worker ready');
        break;

      case 'result': {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve(msg.lines);
        }
        break;
      }

      case 'error': {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          // On error, resolve with empty array (don't break the pipeline)
          logCallback('error', 'WORKER', `Worker error id=${msg.id}: ${msg.message}`);
          p.resolve([]);
        }
        break;
      }

      case 'log':
        logCallback(msg.level, msg.cat, msg.msg, msg.data);
        // Also echo to browser console for DevTools visibility
        if (msg.level === 'error') {
          console.error(`[${msg.cat}] ${msg.msg}`, ...(msg.data != null ? [msg.data] : []));
        } else if (msg.level === 'warn') {
          console.warn(`[${msg.cat}] ${msg.msg}`, ...(msg.data != null ? [msg.data] : []));
        } else {
          console.log(`[${msg.cat}] ${msg.msg}`, ...(msg.data != null ? [msg.data] : []));
        }
        break;

      case 'stats':
        latestStats = {
          recognitionCount: msg.recognitionCount,
          restartCount: msg.restartCount,
          heapUsedMB: msg.heapUsedMB,
        };
        break;

      case 'restarting':
        logCallback('warn', 'WORKER', `Worker restarting: ${msg.reason}`);
        break;
    }
  };

  w.onerror = (err) => {
    logCallback('error', 'WORKER', `Worker onerror: ${err.message}`);
    console.error('[ocrService] Worker onerror:', err);
    // Worker is in an unknown state — recreate it so requests don't hang until timeout
    recreateWorker().catch((e) => console.error('[ocrService] recreateWorker after onerror failed:', e));
  };

  return w;
}

/**
 * Fully terminate and recreate the worker (for unrecoverable errors).
 */
async function recreateWorker(): Promise<void> {
  if (recreating) {
    logCallback('warn', 'WORKER', 'Worker recreation already in progress, skipping');
    return;
  }
  recreating = true;
  try {
    logCallback('warn', 'WORKER', 'Recreating entire worker...');

    // Reject all pending requests
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve([]); // resolve with empty to avoid breaking pipeline
      pending.delete(id);
    }

    if (worker) {
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }

    initPromise = null;
    await initOcr();
  } finally {
    recreating = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the callback for debug log messages from the worker.
 * Call before initOcr() so init logs are captured.
 */
export function setLogCallback(cb: LogCallback): void {
  logCallback = cb;
}

/**
 * Initialize the OCR worker (idempotent — safe to call multiple times).
 */
export async function initOcr(): Promise<void> {
  if (worker) return;
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = createWorkerInstance();

      const onReady = (e: MessageEvent) => {
        if (e.data.type === 'ready') {
          worker!.removeEventListener('message', onReady);
          resolve();
        }
      };
      worker.addEventListener('message', onReady);

      // Send init command
      worker.postMessage({ type: 'init' });

      // Init timeout — OpenCV WASM decodes a ~10MB base64 blob + Tesseract loads
      // language data, so allow up to 90s for the combined init
      setTimeout(() => {
        worker?.removeEventListener('message', onReady);
        reject(new Error('OCR worker init timeout'));
      }, 90_000);
    } catch (err) {
      reject(err);
    }
  }).catch((err) => {
    // Clear cached state so a subsequent initOcr() call can retry
    initPromise = null;
    worker = null;
    throw err;
  });

  return initPromise;
}

/**
 * Run OCR on RGBA pixel data. Requests are serialized (queued, no drops).
 *
 * @param rgba       RGBA pixel data (Uint8ClampedArray from ImageData.data)
 * @param width      Image width
 * @param height     Image height
 * @param useV2      Use V2 filter pipeline (primary), false = V1 fallback
 * @param useUpscale 2× nearest-neighbor upscale before filtering (recommended)
 * @param useRaw     Skip threshold filtering — grayscale + border only (best for colored text)
 * @returns          Array of OCR lines
 */
export function recognizeFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  useV2: boolean,
  useUpscale: boolean,
  useRaw = false,
): Promise<OcrLine[]> {
  // Chain onto queue tail — ensures serial execution, no drops
  const result = new Promise<OcrLine[]>((outerResolve) => {
    queueTail = queueTail.then(() => {
      return new Promise<void>((doneWithSlot) => {
        if (!worker) {
          logCallback('warn', 'OCR', 'Worker not initialized, returning empty');
          outerResolve([]);
          doneWithSlot();
          return;
        }

        const id = nextId++;

        // Copy the ArrayBuffer so it can be transferred
        const buf = rgba.buffer.slice(
          rgba.byteOffset,
          rgba.byteOffset + rgba.byteLength,
        );

        const timer = setTimeout(async () => {
          logCallback('error', 'OCR', `Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`);
          pending.delete(id);
          outerResolve([]);
          doneWithSlot();

          // Recreate worker on timeout
          try { await recreateWorker(); } catch { /* best effort */ }
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
          resolve: (lines) => {
            outerResolve(lines);
            doneWithSlot();
          },
          timer,
        });

        worker.postMessage(
          { type: 'process', id, rgba: buf, width, height, useV2, useUpscale, useRaw },
          [buf], // transfer ownership
        );
      });
    });
  });

  return result;
}

/**
 * Get latest worker stats (recognition count, restart count, heap usage).
 */
export function getWorkerStats(): WorkerStats {
  return { ...latestStats };
}

/**
 * Terminate the OCR worker (called when capture stops or app unmounts).
 */
export async function terminateOcr(): Promise<void> {
  if (worker) {
    // Reject all pending requests
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve([]);
    }
    pending.clear();

    try {
      worker.postMessage({ type: 'terminate' });
      // Give worker a moment to clean up, then hard-terminate
      await new Promise((r) => setTimeout(r, 500));
      worker.terminate();
    } catch { /* ignore */ }

    worker = null;
    initPromise = null;
    queueTail = Promise.resolve();
  }
}
