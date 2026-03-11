/**
 * onnxWorker.ts
 * Web Worker: loads Qwen3.5-0.8B (Vision-Language Model) via
 * @huggingface/transformers and reads MapleStory chat text directly from
 * raw screen-capture frames — no Tesseract preprocessing required.
 *
 * The model is fetched from HuggingFace on first init and cached by the
 * browser's Cache API — subsequent page loads are instant.
 */

/// <reference types="vite/client" />
/* eslint-disable no-restricted-globals */

import {
  parseCorrectionOutput,
  VLM_USER_INSTRUCTION,
} from '../services/onnxCorrectionHelpers.ts';

const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';

function log(level: 'info' | 'warn' | 'error', cat: string, msg: string) {
  self.postMessage({ type: 'log', level, cat, msg });
}

// ---------------------------------------------------------------------------
// Model + processor (loaded once)
// ---------------------------------------------------------------------------

let vlmModel: any = null;
let vlmProcessor: any = null;
let RawImageClass: any = null;

async function ensureModel(): Promise<void> {
  if (vlmModel) return;

  log('info', 'ONNX', 'Importing @huggingface/transformers...');
  const {
    AutoModelForImageTextToText,
    AutoProcessor,
    RawImage,
    env,
  } = await import('@huggingface/transformers');
  RawImageClass = RawImage;

  // Cache downloaded model files in the browser Cache API
  env.useBrowserCache = true;
  env.allowLocalModels = false;

  // Prefer WebGPU (GPU-accelerated, no cross-origin isolation required, 5–20× faster
  // than single-threaded WASM).  Fall back to WASM when WebGPU is unavailable.
  let device: string = 'wasm';
  try {
    const gpu = (self as any).navigator?.gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      if (adapter) device = 'webgpu';
    }
  } catch { /* WebGPU unavailable — stay on wasm */ }
  log('info', 'ONNX', `Compute device: ${device}`);

  const setupWasmThreads = () => {
    const cores = (self as any).navigator?.hardwareConcurrency ?? 4;
    const isolated = (self as any).crossOriginIsolated ?? false;
    const numThreads = isolated ? Math.min(8, Math.max(2, Math.round(cores * 0.75))) : 1;
    (env as any).backends.onnx.wasm.numThreads = numThreads;
    log('info', 'ONNX', `WASM: crossOriginIsolated=${isolated}, numThreads=${numThreads} (cores=${cores})`);
  };

  if (device === 'wasm') setupWasmThreads();

  log('info', 'ONNX', `Loading ${MODEL_ID} (${device})...`);

  // dtype depends on device:
  //   WebGPU — fp16 for all parts (GPU handles fp16 natively)
  //   WASM   — q4 decoder to minimise heap; vision/embed stay fp16 for accuracy
  const webgpuDtype = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' } as const;
  const wasmDtype   = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4'  } as const;

  // A JSON parse error during from_pretrained means the browser Cache API has a
  // corrupt or partial entry from a previous interrupted download.  Clear all caches
  // and retry once without browser caching so fresh files are fetched from HuggingFace.
  const isJsonError = (err: any): boolean =>
    err instanceof SyntaxError || /json/i.test(err?.message ?? '');

  const clearModelCache = async () => {
    env.useBrowserCache = false;
    vlmProcessor = null;
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      log('info', 'ONNX', `Cleared ${names.length} cache(s) — corrupt entries removed`);
    } catch { /* ignore — cache clearing is best-effort */ }
  };

  try {
    [vlmProcessor, vlmModel] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID),
      AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
        dtype: device === 'webgpu' ? webgpuDtype : wasmDtype,
        device: device as 'webgpu' | 'wasm',
      }),
    ]);
  } catch (primaryErr: any) {
    const wasWebGpu = device === 'webgpu';
    if (!wasWebGpu && !isJsonError(primaryErr)) throw primaryErr;

    if (wasWebGpu) {
      log('warn', 'ONNX', `WebGPU load failed (${primaryErr.message}), falling back to WASM`);
      setupWasmThreads();
    }
    if (isJsonError(primaryErr)) {
      log('warn', 'ONNX', 'JSON parse error — browser cache corrupt, clearing and retrying');
      await clearModelCache();
    }

    [vlmProcessor, vlmModel] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID),
      AutoModelForImageTextToText.from_pretrained(MODEL_ID, { dtype: wasmDtype, device: 'wasm' }),
    ]);
  }

  log('info', 'ONNX', 'VLM ready');
}

// ---------------------------------------------------------------------------
// Frame processing
// ---------------------------------------------------------------------------

async function correctFrame(
  frameId: number,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<void> {
  await ensureModel();

  const t0 = Date.now();
  log('info', 'ONNX', `Frame ${frameId}: ${width}×${height} crop`);

  // Convert RGBA → RGB: vision models expect 3-channel input.
  const rgbPixels = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgbPixels[j]     = pixels[i];     // R
    rgbPixels[j + 1] = pixels[i + 1]; // G
    rgbPixels[j + 2] = pixels[i + 2]; // B
    // alpha channel discarded
  }
  const image = new RawImageClass(rgbPixels, width, height, 3);

  // Build the conversation — keep prompt minimal per tested guidance.
  // Game-specific context words actively hurt VLM accuracy.
  const conversation = [
    {
      role: 'user',
      content: [
        { type: 'image' },
        { type: 'text', text: VLM_USER_INSTRUCTION },
      ],
    },
  ];

  // Apply chat template to get the text encoding (with image token placeholders)
  const text: string = vlmProcessor.apply_chat_template(conversation, {
    add_generation_prompt: true,
  });

  // Process text + image together → input_ids, pixel_values, attention_mask, etc.
  const inputs = await vlmProcessor(text, image);
  const inputLen: number = inputs.input_ids.dims.at(-1) ?? 0;
  const MAX_NEW_TOKENS = 80;
  log('info', 'ONNX', `Frame ${frameId}: prompt tokens=${inputLen}, generating (max_new_tokens=${MAX_NEW_TOKENS})`);

  const tGen = Date.now();

  // Generate — enable_thinking MUST be false: with thinking on, OCR quality
  // drops from ~96% to ~14% charSim (friend's testing). do_sample=false for
  // deterministic greedy decode.
  const outputIds = await vlmModel.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
    repetition_penalty: 1.1,
    enable_thinking: false,
  });

  const genMs = Date.now() - tGen;

  // Slice off the prompt tokens, keeping only newly generated tokens.
  const newTokens = outputIds.slice(null, [inputLen, null]);

  let rawText: string = vlmProcessor.batch_decode(newTokens, {
    skip_special_tokens: true,
  })[0] ?? '';

  // Safety: strip any residual <think>…</think> blocks
  rawText = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const newTokenCount = (outputIds.dims.at(-1) ?? 0) - inputLen;
  log('info', 'ONNX', `Frame ${frameId}: generated ${newTokenCount} tokens in ${genMs}ms (total ${Date.now() - t0}ms)`);
  log('info', 'ONNX', `Frame ${frameId} raw output: ${JSON.stringify(rawText.slice(0, 300))}`);

  const corrected = parseCorrectionOutput(rawText);
  log('info', 'ONNX', `Frame ${frameId}: parsed ${corrected.length} lines`);
  self.postMessage({ type: 'result', frameId, lines: corrected });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      try {
        await ensureModel();
        self.postMessage({ type: 'ready' });
      } catch (err: any) {
        self.postMessage({ type: 'error', frameId: -1, message: err.message });
      }
      break;
    }
    case 'correct': {
      // Signal immediately — before ensureModel() — so the 'Verifying' badge
      // appears as soon as the frame enters the queue, not only after model load.
      self.postMessage({ type: 'processing', frameId: msg.frameId });
      try {
        const pixels = new Uint8ClampedArray(msg.imageData);
        await correctFrame(msg.frameId, pixels, msg.width, msg.height);
      } catch (err: any) {
        log('error', 'ONNX', `correctFrame failed: ${err.message}`);
        self.postMessage({ type: 'error', frameId: msg.frameId, message: err.message });
      }
      break;
    }
    case 'terminate': {
      self.close();
      break;
    }
  }
};
