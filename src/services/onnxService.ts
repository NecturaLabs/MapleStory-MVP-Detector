/**
 * onnxService.ts
 * Main-thread wrapper around the onnxWorker Web Worker.
 *
 * Drop-stale queue: only one pending frame at a time. When the worker is
 * busy and a new frame arrives, it replaces the queued one — the old frame
 * is silently discarded. This ensures ONNX always processes the freshest
 * available frame rather than falling behind indefinitely.
 *
 * Message protocol (main → worker):
 *   { type: 'init' }
 *   { type: 'correct', frameId: number, imageData: ArrayBuffer, width: number, height: number }
 *   { type: 'terminate' }
 *
 * Per-message crops are sent at their native resolution (no resize).
 *
 * Message protocol (worker → main):
 *   { type: 'ready' }
 *   { type: 'processing', frameId: number }
 *   { type: 'result', frameId: number, lines: OcrLine[] }
 *   { type: 'error', frameId: number, message: string }
 *   { type: 'log', level: 'info'|'warn'|'error', cat: string, msg: string }
 */

import type { OcrLine } from './ocrService.ts';

type LogCallback = (level: 'info' | 'warn' | 'error', cat: string, msg: string) => void;
type ResultCallback = (frameId: number, lines: OcrLine[]) => void;
type ProcessingCallback = (frameId: number) => void;
type ErrorCallback = (frameId: number) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let workerBusy = false;
// FIFO queue — each entry is one individual message crop (not drop-stale).
// All pending messages are processed in order so none are silently skipped.
let frameQueue: Array<{ frameId: number; pixels: Uint8ClampedArray; width: number; height: number }> = [];
let logCb: LogCallback = () => {};
let resultCb: ResultCallback = () => {};
let processingCb: ProcessingCallback = () => {};
let errorCb: ErrorCallback = () => {};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sendPendingIfIdle(): void {
  if (workerBusy || frameQueue.length === 0 || !worker) return;
  workerBusy = true;
  const { frameId, pixels, width, height } = frameQueue.shift()!;
  // Clone the pixel buffer into a plain ArrayBuffer so we can transfer it
  // to the worker without detaching the caller's Uint8ClampedArray.
  const imageData = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
  worker.postMessage({ type: 'correct', frameId, imageData, width, height }, [imageData]);
}

function createWorkerInstance(): Worker {
  const w = new Worker(
    new URL('../workers/onnxWorker.ts', import.meta.url),
    { type: 'module' },
  );

  w.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        logCb('info', 'ONNX', 'Worker ready');
        break;
      case 'processing':
        processingCb(msg.frameId);
        break;
      case 'result':
        workerBusy = false;
        resultCb(msg.frameId, msg.lines);
        sendPendingIfIdle();
        break;
      case 'error':
        workerBusy = false;
        logCb('error', 'ONNX', `Worker error frameId=${msg.frameId}: ${msg.message}`);
        if (msg.frameId !== -1) errorCb(msg.frameId);
        sendPendingIfIdle();
        break;
      case 'log':
        logCb(msg.level, msg.cat, msg.msg);
        // Echo to DevTools console so it's visible without opening the debug overlay
        if (msg.level === 'error') {
          console.error(`[${msg.cat}] ${msg.msg}`);
        } else if (msg.level === 'warn') {
          console.warn(`[${msg.cat}] ${msg.msg}`);
        } else {
          console.log(`[${msg.cat}] ${msg.msg}`);
        }
        break;
    }
  };

  w.onerror = (err) => {
    logCb('error', 'ONNX', `Worker onerror: ${err.message}`);
    workerBusy = false;
    sendPendingIfIdle();
  };

  return w;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setOnnxLogCallback(cb: LogCallback): void {
  logCb = cb;
}

export function setOnnxResultCallback(cb: ResultCallback): void {
  resultCb = cb;
}

export function setOnnxProcessingCallback(cb: ProcessingCallback): void {
  processingCb = cb;
}

export function setOnnxErrorCallback(cb: ErrorCallback): void {
  errorCb = cb;
}

export async function initOnnx(): Promise<void> {
  if (worker) return;
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = createWorkerInstance();
      const onReady = (e: MessageEvent) => {
        if (e.data.type === 'ready') {
          worker!.removeEventListener('message', onReady);
          resolve();
        } else if (e.data.type === 'error' && e.data.frameId === -1) {
          // init-phase error — model failed to load
          worker!.removeEventListener('message', onReady);
          reject(new Error(`ONNX model load failed: ${e.data.message}`));
        }
      };
      worker.addEventListener('message', onReady);
      worker.postMessage({ type: 'init' });
      // 5 minutes — first-time model download can be slow
      setTimeout(() => {
        worker?.removeEventListener('message', onReady);
        reject(new Error('ONNX worker init timeout'));
      }, 300_000);
    } catch (err) {
      reject(err);
    }
  }).catch((err) => {
    initPromise = null;
    worker = null;
    throw err;
  });

  return initPromise;
}

/**
 * Enqueue a single-message crop for VLM verification.
 * Frames are processed FIFO — one at a time, in the order they were queued.
 * Results arrive via the callback registered with setOnnxResultCallback.
 */
export function dispatchFrame(
  frameId: number,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  if (!worker) return false;
  frameQueue.push({ frameId, pixels, width, height });
  sendPendingIfIdle();
  return true;
}

/** Drain the queue without processing remaining items (call on capture stop). */
export function clearOnnxQueue(): void {
  frameQueue = [];
}

export function isOnnxBusy(): boolean {
  return workerBusy;
}

export function terminateOnnx(): void {
  frameQueue = [];
  if (worker) {
    try { worker.postMessage({ type: 'terminate' }); } catch { /* ignore */ }
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  initPromise = null;
  workerBusy = false;
}
