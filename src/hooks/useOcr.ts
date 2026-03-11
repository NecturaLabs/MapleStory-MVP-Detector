/**
 * useOcr.ts
 * Main processing loop: frame → TIFF → worker (OpenCV filters + Tesseract OCR) → parse → store.
 *
 * Architecture:
 * - Self-rescheduling async loop (no setInterval races)
 * - Promise queue in ocrService ensures no frames are dropped
 * - settingsRef pattern: processFrame is stable across settings changes
 * - Generation counter: OCR stops cleanly when Stop Capture is pressed
 * - wasCapturingRef: dedup cache only clears on true capture start (false→true)
 * - All pipeline steps emit debug logs to the store ring buffer
 */

import { useEffect, useRef, useCallback } from 'react';
import useAppStore from '../store/appStore.ts';
import { initOcr, recognizeFrame, terminateOcr, setLogCallback, setChatRegion, clearChatRegion } from '../services/ocrService.ts';
import type { OcrLine } from '../services/ocrService.ts';
import {
  initOnnx,
  dispatchFrame,
  clearOnnxQueue,
  setOnnxLogCallback,
  setOnnxResultCallback,
  setOnnxProcessingCallback,
  setOnnxErrorCallback,
  terminateOnnx,
  isOnnxBusy,
} from '../services/onnxService.ts';
import { extractFrame } from '../services/captureService.ts';
import { mapBboxToRaw, unionRect, cropRgba } from '../services/chatCropService.ts';
import { combineLines, analyzeMvp } from '../services/chatParserService.ts';
import { playPing } from '../services/soundService.ts';
import { sendMvpToDiscord } from '../services/discordService.ts';
import { insertMessage, trimToMax, loadRecentMessages, updateMessage } from '../services/dbService.ts';
import type { ConsoleLine } from '../store/appStore.ts';

/**
 * Compute the dedup key for a chat message: minute bucket + 4-char body stem.
 * Shared between Tesseract and ONNX upsert paths so they always agree on keys.
 */
function computeDedupKey(text: string, rawTimestamp: string | null): string {
  const bodyWords = text
    .replace(/\[?\d{2}[:.]\d{2}\]?/g, '')
    .replace(/[^a-zA-Z\s]/g, '')
    .trim().split(/\s+/).filter((w) => w.length >= 3);
  const tsDigits = (rawTimestamp || '').replace(/[^0-9]/g, '');
  const mm = tsDigits.length === 4 ? parseInt(tsDigits.slice(2, 4), 10) : -1;
  const mmBucket = mm >= 0 ? Math.round(mm / 5) * 5 : -1;
  const stem = (bodyWords[0] || '').slice(0, 4).toLowerCase();
  return mmBucket + ':' + stem;
}

const TIMESTAMP_RE = /\d{2}[:.]\d{2}/;

// Set to true via scheduleVlmCropExport() to save the next crop as PNG download.
let _exportNextVlmCrop = false;
export function scheduleVlmCropExport(): void { _exportNextVlmCrop = true; }

export function useOcr(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const isCapturing   = useAppStore((s) => s.isCapturing);
  const isPaused      = useAppStore((s) => s.isPaused);
  const settings      = useAppStore((s) => s.settings);

  // --- Refs for stable processFrame (no useCallback dep on settings) ---
  const settingsRef     = useRef(settings);
  const genRef          = useRef(0);        // generation counter — incremented on stop
  const wasCapturingRef = useRef(false);     // track false→true transition for dedup reset
  const loopActiveRef   = useRef(false);     // is the self-rescheduling loop running?

  // Rolling map of recently-seen message texts to deduplicate across poll cycles.
  // Key = normalised dedup string. Value tracks last-seen wall time, confidence,
  // and a direct reference to the ConsoleLine object (avoids stale-index bugs when
  // sorted inserts shift the array).
  interface SeenEntry { wallTs: number; confidence: number; lineRef: ConsoleLine; source?: 'tesseract' | 'onnx' }
  const seenTextsRef = useRef<Map<string, SeenEntry>>(new Map());
  const DEDUP_TTL_MS = 30_000;

  const frameCounterRef = useRef(0);

  // Tracks dedup keys that have already been sent to and processed by the VLM.
  // NOT cleared on capture start — intentionally cross-session.
  const vlmProcessedKeysRef = useRef<Set<string>>(new Set());

  // Maps frameId → single dedup key dispatched to VLM for that frame.
  // Per-message dispatch: each VLM frame processes exactly one chat message crop.
  const vlmFrameKeysRef = useRef<Map<number, string>>(new Map());

  // Promise ref used to pause processFrame during periodic worker restarts.
  const workerRestartPromiseRef = useRef<Promise<void>>(Promise.resolve());
  // Set to true when a periodic restart fires while ONNX is busy.
  // The ONNX result callback will restart ONNX after the current inference finishes.
  const deferredOnnxRestartRef = useRef(false);

  // Keep settingsRef in sync
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // React to vlmEnabled toggle changes at runtime: init or teardown ONNX
  useEffect(() => {
    if (settings.vlmEnabled) {
      initOnnx().catch((err) =>
        console.warn('[useOcr] ONNX init failed (correction disabled):', err),
      );
    } else {
      clearOnnxQueue();
      terminateOnnx();
    }
  }, [settings.vlmEnabled]);

  // Wire up the worker log callback to the store debug ring buffer
  useEffect(() => {
    setLogCallback((level, cat, msg, data) => {
      useAppStore.getState().addDebugLog(level, cat, msg, data);
    });
    setOnnxLogCallback((level, cat, msg) => {
      useAppStore.getState().addDebugLog(level, cat, msg);
    });
  }, []);

  // VLM processing callback: transitions the message row 'pending' → 'processing'
  // once the worker begins active inference on this single-message frame.
  useEffect(() => {
    setOnnxProcessingCallback((frameId) => {
      const key = vlmFrameKeysRef.current.get(frameId);
      if (!key) return;
      const existing = seenTextsRef.current.get(key);
      if (!existing) return;
      const idx = useAppStore.getState().consoleLines.indexOf(existing.lineRef);
      if (idx >= 0) {
        useAppStore.getState().updateConsoleLine(idx, { vlmStatus: 'processing' });
        existing.lineRef = useAppStore.getState().consoleLines[idx];
      }
    });
  }, []);

  // ONNX error callback: cleans up the frame so the message stays 'pending' and
  // gets re-dispatched on the next OCR cycle automatically.
  useEffect(() => {
    setOnnxErrorCallback((frameId) => {
      vlmFrameKeysRef.current.delete(frameId);
    });
  }, []); // all state accessed via stable refs

  // ONNX result callback: per-message dispatch — each frameId maps to exactly one
  // dedup key. Update the existing Tesseract row with the VLM-corrected text, or
  // clear the pending badge if VLM couldn't read the crop.
  useEffect(() => {
    setOnnxResultCallback((frameId, correctedLines) => {
      const s = settingsRef.current;
      const store = useAppStore.getState();
      const now = Date.now();

      const key = vlmFrameKeysRef.current.get(frameId);
      vlmFrameKeysRef.current.delete(frameId);
      if (!key) return;

      const existing = seenTextsRef.current.get(key);
      if (!existing) return;

      // Mark as VLM-settled so this message won't be re-dispatched
      existing.wallTs = now;
      existing.source = 'onnx';
      vlmProcessedKeysRef.current.add(key);

      // Extract the first valid (timestamped) line from VLM output
      const messages = combineLines(correctedLines, s);
      const validMsg = messages.find((m) => m.rawTimestamp?.includes(':'));

      const liveIdx = useAppStore.getState().consoleLines.indexOf(existing.lineRef);

      if (validMsg) {
        const mvp = analyzeMvp(validMsg.text, s);
        if (liveIdx >= 0) {
          store.updateConsoleLine(liveIdx, {
            text: validMsg.text,
            source: 'onnx',
            onnxRejected: false,
            vlmStatus: undefined,
            // Preserve existing isMvpMatch — VLM text correction can cause analyzeMvp
            // to miss keywords that Tesseract already validated.
            isMvpMatch: mvp.isValid || mvp.hasMvpKeyword || existing.lineRef.isMvpMatch,
            details: {
              channel: mvp.isValid ? mvp.channel : (existing.lineRef.details?.channel ?? null),
              willBeUsedAt: mvp.isValid && mvp.willBeUsedAt
                ? mvp.willBeUsedAt.getTime()
                : (existing.lineRef.details?.willBeUsedAt ?? null),
              location: mvp.isValid ? mvp.location : (existing.lineRef.details?.location ?? null),
              rawTimestamp: validMsg.rawTimestamp ?? mvp.rawTimestamp ?? null,
              dedupKey: mvp.isValid ? mvp.dedupKey : (existing.lineRef.details?.dedupKey ?? null),
            },
          });
          existing.lineRef = useAppStore.getState().consoleLines[liveIdx];
          const lineId = existing.lineRef.id;
          if (lineId !== undefined) {
            updateMessage(lineId, { source: 'onnx', text: validMsg.text }).catch(() => {});
          }
        }
      } else {
        // VLM couldn't read this crop — clear the pending badge and leave the row as-is
        if (liveIdx >= 0) {
          store.updateConsoleLine(liveIdx, { vlmStatus: undefined });
          existing.lineRef = useAppStore.getState().consoleLines[liveIdx];
        }
      }

      // If a periodic restart was deferred, execute it once the queue drains
      if (deferredOnnxRestartRef.current && vlmFrameKeysRef.current.size === 0) {
        deferredOnnxRestartRef.current = false;
        if (settingsRef.current.vlmEnabled) {
          useAppStore.getState().addDebugLog('info', 'WORKER', 'Executing deferred ONNX restart…');
          terminateOnnx();
          initOnnx().then(() => {
            useAppStore.getState().addDebugLog('info', 'WORKER', 'Deferred ONNX restart complete');
          }).catch((err) => {
            useAppStore.getState().addDebugLog('warn', 'WORKER', `Deferred ONNX restart failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // all state accessed via stable refs

  // Hydrate console from IndexedDB on mount
  useEffect(() => {
    const s = settingsRef.current;
    loadRecentMessages(s.maxMessages)
      .then((rows) => {
        const lines: ConsoleLine[] = rows.map((r) => ({
          id: r.id,
          capturedAt: r.capturedAt,
          text: r.text,
          isMvpMatch: r.isMvpMatch,
          isNewMvp: r.isNewMvp,
          details: r.details,
          source: r.source,
        }));
        useAppStore.getState().setConsoleLines(lines);
      })
      .catch((err) => console.warn('[useOcr] Failed to load history:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize workers eagerly on mount (page load) so OpenCV WASM + Tesseract
  // are warm before the user starts capturing — avoids cold-start delay.
  // Workers are long-lived singletons: they survive capture start/stop cycles
  // and are only terminated on page unload. This means WASM heaps and model data
  // stay resident in memory even when not capturing — an accepted tradeoff since
  // re-initializing (especially ONNX model download) takes minutes.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await initOcr();
        if (!cancelled) useAppStore.getState().setWorkersReady(true);
      } catch (err) {
        console.error('[useOcr] OCR init failed:', err);
        if (!cancelled) {
          useAppStore.getState().setWorkerError(
            err instanceof Error ? err.message : 'OCR engine failed to load',
          );
        }
      }
    };
    init();
    // ONNX/VLM is optional — only init when user has enabled VLM
    if (settingsRef.current.vlmEnabled) {
      initOnnx().catch((err) => console.warn('[useOcr] ONNX init failed (correction disabled):', err));
    }
    return () => { cancelled = true; };
  }, []);

  // ---------------------------------------------------------------------------
  // processFrame — stable useCallback, does NOT depend on settings
  // ---------------------------------------------------------------------------
  const processFrame = useCallback(async (myGen: number) => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    if (video.readyState < 2) return;

    // Generation guard — bail if capture was stopped
    if (genRef.current !== myGen) return;

    const s = settingsRef.current;
    const setProcessing = useAppStore.getState().setProcessing;
    const setFilterInfo = useAppStore.getState().setFilterInfo;
    const addConsoleLine = useAppStore.getState().addConsoleLine;
    const isNewMvp = useAppStore.getState().isNewMvp;

    const startTime = performance.now();
    setProcessing(true);

    try {
      // 1. Extract frame from video
      const rawFrame = extractFrame(video);
      if (!rawFrame) return;

      // Generation guard
      if (genRef.current !== myGen) return;

      // Pause here during periodic worker restarts to avoid calling a terminated worker
      await workerRestartPromiseRef.current;
      if (genRef.current !== myGen) return;

      // 2. Send to worker for V2 filter + OCR (primary)
      const v2Lines = await recognizeFrame(
        rawFrame.data,
        rawFrame.width,
        rawFrame.height,
        true, // useV2
        s.useUpscale,
      );

      // Generation guard
      if (genRef.current !== myGen) return;

      // 3. Combine lines + analyze MVP
      const v2Messages = combineLines(v2Lines, s);
      let results = v2Messages.map((m) => ({ msg: m, mvp: analyzeMvp(m.text, s) }));

      let usedFilter: 'v1' | 'v2' | 'raw' = 'v2';

      // 4. Supplementary raw pass: run unfiltered grayscale OCR to catch colored
      //    chat text (orange item drops, green GL messages) that V2's thresholding misses.
      //    V2 results are always kept. Raw results are merged in (dedup handles overlaps).
      let rawLines: OcrLine[] = [];
      if (s.useMultiFilter) {
        // Generation guard
        if (genRef.current !== myGen) return;

        rawLines = await recognizeFrame(
          rawFrame.data,
          rawFrame.width,
          rawFrame.height,
          false,  // useV2 (ignored when useRaw=true)
          s.useUpscale,
          true,   // useRaw
        );

        if (genRef.current !== myGen) return;

        const rawMessages = combineLines(rawLines, s);
        const rawResults = rawMessages.map((m) => ({ msg: m, mvp: analyzeMvp(m.text, s) }));

        // Append raw results — dedup logic downstream handles duplicates
        if (rawResults.length > 0) {
          results = results.concat(rawResults);
          usedFilter = 'raw'; // indicate both filters ran
        }
      }

      const duration = Math.round(performance.now() - startTime);
      setFilterInfo(usedFilter, duration);

      // 5. Drop messages without a valid in-game timestamp — all real chat messages
      //    start with [HH:MM]; orphan continuation lines (rawTimestamp=null) are
      //    OCR fragments. Also require a colon separator: [0249] without ':' is a
      //    garbled read and should be suppressed.
      results = results.filter(({ msg }) => msg.rawTimestamp !== null && msg.rawTimestamp.includes(':'));

      // Within-cycle dedup: V2 and RAW passes in the same poll cycle can produce
      // near-identical messages for the same timestamp that get different seenTextsRef
      // keys when OCR garbles the start of the line differently. Keep only the
      // higher-confidence version when ≥3 long words (≥4 chars) are shared.
      {
        const keep: boolean[] = new Array(results.length).fill(true);
        for (let i = 0; i < results.length; i++) {
          if (!keep[i]) continue;
          for (let j = i + 1; j < results.length; j++) {
            if (!keep[j]) continue;
            if (results[i].msg.rawTimestamp !== results[j].msg.rawTimestamp) continue;
            const wordsOf = (text: string) => new Set(
              text.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/)
                .filter((w) => w.length >= 4).map((w) => w.toLowerCase()),
            );
            const wi = wordsOf(results[i].msg.text);
            const wj = wordsOf(results[j].msg.text);
            let shared = 0;
            for (const w of wi) if (wj.has(w)) shared++;
            if (shared >= 3) {
              if (results[i].msg.confidence >= results[j].msg.confidence) {
                keep[j] = false;
              } else {
                keep[i] = false;
                break;
              }
            }
          }
        }
        results = results.filter((_, idx) => keep[idx]);
      }

      // Compute in-flight keys upfront so the dedup loop can skip re-dispatching
      // messages that are already queued or being processed by VLM.
      const inFlightKeys = new Set(vlmFrameKeysRef.current.values());

      // 6. Dedup + merge/update + persist + console emit
      const now = Date.now();
      const updateConsoleLine = useAppStore.getState().updateConsoleLine;

      // Expire old dedup entries
      for (const [k, entry] of seenTextsRef.current) {
        if (now - entry.wallTs > DEDUP_TTL_MS) seenTextsRef.current.delete(k);
      }

      for (const { msg, mvp } of results) {
        // Dedup key: minute bucket (rounded to nearest 5) + 4-char stem of first
        // significant body word.
        //
        // Design rationale:
        // - OCR frequently misreads the HOUR digit (e.g. "03" → "08") but rarely
        //   misreads the MINUTE digits, so we bucket only the minute and omit the
        //   hour entirely to tolerate hour misreads without creating duplicate entries.
        // - The minute bucket (±2 min tolerance) collapses minor OCR minute-digit
        //   variance (e.g. "19" → "21" both round to bucket 20).
        // - A 4-char body stem (vs old 2-char) makes accidental cross-hour collisions
        //   between genuinely different messages extremely unlikely, compensating for
        //   the lack of the hour component.
        const key = computeDedupKey(msg.text, msg.rawTimestamp);

        const existing = seenTextsRef.current.get(key);
        if (existing) {
          existing.wallTs = now; // always refresh TTL, even for onnx-settled entries
          // ONNX has settled this message — Tesseract must not overwrite it.
          // TTL is refreshed above so rejected entries don't expire and re-appear as duplicates.
          if (existing.source === 'onnx') continue;

          // Merge: if new detection has higher confidence and more info, update existing
          if (mvp.isValid && msg.confidence > existing.confidence) {
            const lines = useAppStore.getState().consoleLines;
            // Use a live index lookup — stored object ref is stable even after sorted inserts
            const currentIdx = lines.indexOf(existing.lineRef);
            if (currentIdx >= 0) {
              const existingDetails = existing.lineRef.details;
              const hasMoreInfo =
                (mvp.channel !== null && existingDetails?.channel === null) ||
                (mvp.willBeUsedAt !== null && existingDetails?.willBeUsedAt === null) ||
                (mvp.location !== null && existingDetails?.location === null);

              if (hasMoreInfo) {
                const mergedDetails = {
                  channel: mvp.channel ?? existingDetails?.channel ?? null,
                  willBeUsedAt: mvp.willBeUsedAt ? mvp.willBeUsedAt.getTime() : (existingDetails?.willBeUsedAt ?? null),
                  location: mvp.location ?? existingDetails?.location ?? null,
                  rawTimestamp: mvp.rawTimestamp ?? existingDetails?.rawTimestamp ?? null,
                  dedupKey: mvp.dedupKey ?? existingDetails?.dedupKey ?? null,
                };
                updateConsoleLine(currentIdx, {
                  details: mergedDetails,
                  confidence: msg.confidence,
                  isMvpMatch: true,
                });
                existing.confidence = msg.confidence;
                // Refresh lineRef — updateConsoleLine creates a new spread object at this index
                existing.lineRef = useAppStore.getState().consoleLines[currentIdx];
              }
            }
          }
          continue;
        }

        const newMvp = mvp.isValid ? isNewMvp(mvp.dedupKey!) : false;

        let entry: ConsoleLine = {
          capturedAt: now,
          text: msg.text,
          isMvpMatch: mvp.isValid || mvp.hasMvpKeyword,
          isNewMvp: newMvp,
          confidence: msg.confidence,
          source: 'tesseract',
          details: {
            channel: mvp.isValid ? mvp.channel : null,
            willBeUsedAt: mvp.isValid && mvp.willBeUsedAt ? mvp.willBeUsedAt.getTime() : null,
            location: mvp.isValid ? mvp.location : null,
            rawTimestamp: msg.rawTimestamp ?? mvp.rawTimestamp ?? null,
            dedupKey: mvp.isValid ? mvp.dedupKey : null,
          },
        };

        if (newMvp && s.soundEnabled) {
          playPing({ volume: s.soundVolume, tone: s.soundTone });
        }

        // Discord webhook notification — fire-and-forget, never blocks OCR loop
        if (newMvp && s.discordEnabled && s.discordWebhookUrl) {
          sendMvpToDiscord(s.discordWebhookUrl, {
            text: msg.text,
            channel: mvp.isValid ? mvp.channel : null,
            willBeUsedAt: mvp.isValid && mvp.willBeUsedAt ? mvp.willBeUsedAt.getTime() : null,
            location: mvp.isValid ? (mvp.location?.mapName ?? null) : null, // MvpDiscordPayload.location is string | null; extract mapName from LocationMatch
            rawTimestamp: msg.rawTimestamp ?? mvp.rawTimestamp ?? null,
          }, s.discordRoleId).then((err) => {
            if (err) {
              useAppStore.getState().addDebugLog('warn', 'DISCORD', `Webhook failed: ${err}`);
            }
          });
        }

        try {
          const dbId = await insertMessage(entry);
          entry = { ...entry, id: dbId };
          if (s.autoCleanup) {
            await trimToMax(s.maxMessages);
          }
        } catch (dbErr) {
          console.warn('[useOcr] DB insert failed:', dbErr);
        }

        addConsoleLine(entry);

        seenTextsRef.current.set(key, {
          wallTs: now,
          confidence: msg.confidence,
          lineRef: entry, // stable object reference — immune to sorted-insert index shifts
          source: 'tesseract',
        });
      }
      // Per-message VLM dispatch: each pending message gets its own individual
      // crop (just that line's bbox) sent as a separate VLM frame.
      // This keeps each inference tiny and gives every message a unique frameId.
      if (s.vlmEnabled) {
        const allRawLines = [...v2Lines, ...rawLines];
        let exportDone = false;

        for (const { msg } of results) {
          const key = computeDedupKey(msg.text, msg.rawTimestamp);
          // Skip if already VLM-processed or currently in-flight
          if (vlmProcessedKeysRef.current.has(key) || inFlightKeys.has(key)) continue;
          if (!msg.rawTimestamp) continue;

          // Find the single best OCR line matching this message's timestamp.
          // Multiple lines may match (V2 + raw passes, continuation fragments),
          // but we only need one bbox — pick the highest-confidence match.
          const matchingLine = allRawLines
            .filter((l) => l.bbox && l.text.includes(msg.rawTimestamp!))
            .sort((a, b) => b.confidence - a.confidence)[0];
          if (!matchingLine?.bbox) continue;
          const rawBbox = mapBboxToRaw(matchingLine.bbox, s.useUpscale);
          const msgRect = unionRect([rawBbox], 6, rawFrame.width, rawFrame.height);
          if (!msgRect) continue;

          const msgFrameId = frameCounterRef.current++;
          const msgPixels = cropRgba(rawFrame.data, rawFrame.width, msgRect);
          const dispatched = dispatchFrame(msgFrameId, msgPixels, msgRect.w, msgRect.h);
          if (!dispatched) continue;

          vlmFrameKeysRef.current.set(msgFrameId, key);

          // Set vlmStatus: 'pending' on this message's row
          const entry = seenTextsRef.current.get(key);
          if (entry) {
            const liveIdx = useAppStore.getState().consoleLines.indexOf(entry.lineRef);
            if (liveIdx >= 0) {
              useAppStore.getState().updateConsoleLine(liveIdx, { vlmStatus: 'pending' });
              entry.lineRef = useAppStore.getState().consoleLines[liveIdx];
            }
          }

          // Debug export: save the first dispatched crop as a PNG download
          if (_exportNextVlmCrop && !exportDone) {
            _exportNextVlmCrop = false;
            exportDone = true;
            const canvas = document.createElement('canvas');
            canvas.width = msgRect.w;
            canvas.height = msgRect.h;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const imageData = new ImageData(msgRect.w, msgRect.h);
              imageData.data.set(msgPixels);
              ctx.putImageData(imageData, 0, 0);
              canvas.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `vlm-crop-${Date.now()}.png`;
                a.click();
                URL.revokeObjectURL(url);
              }, 'image/png');
            }
          }
        }
      }
    } catch (err) {
      console.error('[useOcr] processFrame error:', err);
    } finally {
      setProcessing(false);
    }
  }, [videoRef]); // NOTE: no settings dep — read from settingsRef

  // ---------------------------------------------------------------------------
  // Self-rescheduling polling loop
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Not capturing or paused — stop the loop and drain the VLM queue.
    // Workers are NOT terminated here — they are long-lived singletons that
    // persist across capture start/stop to avoid cold-start delays.
    if (!isCapturing || isPaused) {
      loopActiveRef.current = false;
      genRef.current++; // invalidate any in-flight processFrame
      clearOnnxQueue();
      return;
    }

    // Handle capture start (false→true transition): seed the dedup map from
    // existing consoleLines so we don't re-append messages already on screen.
    // Only seed recent messages (within DEDUP_TTL_MS) — old history should not
    // block new detections of the same chat content in a new session.
    if (!wasCapturingRef.current) {
      seenTextsRef.current.clear();
      const existingLines = useAppStore.getState().consoleLines;
      const now = Date.now();
      for (let i = 0; i < existingLines.length; i++) {
        const line = existingLines[i];
        // Only seed messages captured within the dedup TTL window
        if (now - line.capturedAt > DEDUP_TTL_MS) continue;

        const key = computeDedupKey(line.text, line.details?.rawTimestamp ?? null);
        seenTextsRef.current.set(key, {
          wallTs: line.capturedAt, // use original capture time, not now
          confidence: line.confidence ?? 0,
          lineRef: line,
          source: line.source,
        });
      }

      // Rebuild VLM processed key set: only track messages already confirmed by VLM
      vlmProcessedKeysRef.current.clear();
      for (const line of existingLines) {
        if (line.source !== 'onnx') continue;
        if (now - line.capturedAt > DEDUP_TTL_MS) continue;
        vlmProcessedKeysRef.current.add(computeDedupKey(line.text, line.details?.rawTimestamp ?? null));
      }
    }
    wasCapturingRef.current = true;

    // Workers are already alive from eager mount init — no re-init needed.
    // Start the loop
    const myGen = genRef.current;
    loopActiveRef.current = true;

    const loop = async () => {
      while (loopActiveRef.current && genRef.current === myGen) {
        await processFrame(myGen);

        // Wait pollingInterval before next frame
        const interval = settingsRef.current.pollingInterval;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval);
          // If loop is stopped during the wait, clear the timer
          const check = setInterval(() => {
            if (!loopActiveRef.current || genRef.current !== myGen) {
              clearTimeout(timer);
              clearInterval(check);
              resolve();
            }
          }, 100);
        });
      }
    };

    void loop();

    return () => {
      loopActiveRef.current = false;
      genRef.current++;
    };
  }, [isCapturing, isPaused, processFrame]);

  // Update wasCapturingRef when capture stops
  useEffect(() => {
    if (!isCapturing) {
      wasCapturingRef.current = false;
    }
  }, [isCapturing]);

  // Periodic worker restart every 5 minutes to prevent memory leaks.
  // Sets workerRestartPromiseRef so processFrame naturally pauses during the restart.
  useEffect(() => {
    if (!isCapturing) return;

    const restartWorkers = async () => {
      // Skip ONNX restart if VLM is mid-inference — terminating it would lose the
      // result and the badge would never appear. OCR (Tesseract) is always safe to
      // restart between frames since it is a much faster synchronous pipeline.
      const onnxBusy = isOnnxBusy();
      const vlmOn = settingsRef.current.vlmEnabled;
      let resolve!: () => void;
      workerRestartPromiseRef.current = new Promise<void>((r) => { resolve = r; });
      useAppStore.getState().addDebugLog(
        'info', 'WORKER',
        onnxBusy && vlmOn
          ? 'Periodic restart (OCR only — VLM busy, ONNX restart deferred until inference completes)'
          : vlmOn
            ? 'Periodic restart (OCR + VLM)…'
            : 'Periodic restart (OCR only — VLM disabled)…',
      );
      try {
        if (onnxBusy && vlmOn) {
          deferredOnnxRestartRef.current = true;
          await terminateOcr();
          await initOcr();
        } else if (vlmOn) {
          terminateOnnx();
          await terminateOcr();
          await Promise.all([initOcr(), initOnnx()]);
        } else {
          await terminateOcr();
          await initOcr();
        }
        useAppStore.getState().addDebugLog('info', 'WORKER', 'Worker restart complete');
      } catch (err) {
        useAppStore.getState().addDebugLog('warn', 'WORKER', `Worker restart failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        resolve();
      }
    };

    const timer = setInterval(() => { void restartWorkers(); }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [isCapturing]);

  // Terminate OCR worker on actual page unload (not on React StrictMode remount).
  // In dev, StrictMode double-mounts: mount → unmount → remount.  Terminating on
  // the simulated unmount kills the worker mid-init.  The worker is a long-lived
  // singleton, so we only tear it down when the tab is actually closing.
  useEffect(() => {
    const onUnload = () => { terminateOcr().catch(() => {}); terminateOnnx(); };
    window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('beforeunload', onUnload); };
  }, []);

  // Sync the user-defined chat region (from settings) into the OCR worker.
  // Runs when capturing starts or when the user changes the crop region.
  // Converts percentage-based storage to pixel coordinates using the video dimensions.
  useEffect(() => {
    const video = videoRef.current;
    const region = settings.chatRegion;
    if (region && video && video.videoWidth && video.videoHeight) {
      setChatRegion({
        x: Math.round(region.xPct * video.videoWidth),
        y: Math.round(region.yPct * video.videoHeight),
        w: Math.round(region.wPct * video.videoWidth),
        h: Math.round(region.hPct * video.videoHeight),
      });
    } else {
      clearChatRegion();
    }
  }, [settings.chatRegion, isCapturing, videoRef]);
}
