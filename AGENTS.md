# MapleStory MVP Detector

## What Is This
A fully client-side React + Vite + TypeScript web app that captures a MapleStory window via the browser Screen Capture API, OCRs the chat box region every 2 seconds using OpenCV.js (WASM) + tesseract.js v7 in a Web Worker, and alerts (visual + audio) when MVP announcements are detected. No backend. No secrets. Deployable to any static host (Netlify, GitHub Pages, etc.).

## Tech Stack
- **Frontend:** React 19 + TypeScript + Vite (uses **bun** as package manager)
- **State:** Zustand (`src/store/appStore.ts`)
- **OCR:** tesseract.js v7 — LSTM engine, tessdata auto-fetched from jsDelivr CDN and cached in IndexedDB
- **Image Processing:** OpenCV.js WASM (`@techstark/opencv-js`) running inside a Web Worker (`src/workers/ocrWorker.ts`). Frames captured as TIFF (`utif` library) matching the C# pipeline format.
- **Audio:** Web Audio API tone generator (`src/services/soundService.ts`) — no audio files
- **Persistence:** IndexedDB (`src/services/dbService.ts`) for chat history; localStorage for settings, region, MVP dedup codes
- **Testing:** Vitest (`bun run test`) — unit tests colocated as `*.test.ts`. OCR integration and golden regression tests skip gracefully when fixture images are not present.
- **Build:** Vite (`bun run build`)
- **Deployment:** Netlify (configured via `netlify.toml`)
- **COOP/COEP:** Dev/preview server sends `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers for SharedArrayBuffer support (OpenCV WASM)

## Architecture
```
src/
  main.tsx
  App.tsx
  components/
    Header.tsx              # Logo, title, GitHub link, Settings gear, help button
    CapturePanel.tsx        # Video preview + region overlay + presets dropdown
    ConsolePanel.tsx        # Real-time OCR log, MVP highlights, auto-scroll, chronological sort, debug log download
    StatusBar.tsx           # Filter mode, OCR duration, match count, capture state
    SettingsModal.tsx       # All configurable values
    OnboardingOverlay.tsx   # 3-step first-time user guide
  workers/
    ocrWorker.ts            # Web Worker: OpenCV WASM filters + Tesseract OCR, memory-monitored restart
    onnxWorker.ts           # Web Worker: ONNX runtime for VLM inference (experimental)
  services/
    captureService.ts       # getDisplayMedia (window-only) + track.onended handler
    ocrService.ts           # Main-thread wrapper around ocrWorker, promise queue (no drops), timeout + restart
    imageFilters.ts         # Pure JS V1 + V2 filter pipelines (used by unit tests in Node)
    chatParserService.ts    # Full regex port + line combiner + MVP analysis + location
    chatParserService.test.ts  # 66 unit tests for chatParserService
    chatCropService.test.ts    # Unit tests for VLM crop logic
    onnxCorrectionHelpers.test.ts  # Unit tests for VLM token correction
    ocrIntegration.test.ts  # Integration test: TIFF → filters → Tesseract → parser (skips if no fixture)
    goldenRegression.test.ts   # Golden regression tests (skips if no fixtures in __fixtures__/golden/)
    dbService.ts            # IndexedDB wrapper (db: "msmvp", store: "messages")
    soundService.ts         # Web Audio API — 880Hz sine/triangle/square for 300ms
    discordService.ts       # Discord webhook integration
    chatCropService.ts      # VLM chat region extraction from timestamp bboxes
    onnxCorrectionHelpers.ts   # VLM token correction logic
    onnxService.ts          # Main-thread VLM worker wrapper
  hooks/
    useCapture.ts           # Stream lifecycle
    useOcr.ts               # Frame → worker (OpenCV+OCR) → parser → store pipeline
    useChatParser.ts        # React wrapper for chatParserService
  store/
    appStore.ts             # Zustand store + MVP dedup + debug ring buffer
  utils/
    regexPatterns.ts        # All 9 regex patterns + MAP_DICTIONARY (38 entries)
    persistence.ts          # localStorage helpers + first-visit detection
  styles/                   # CSS

public/
  mvp.png                   # Favicon / logo
  opencv.js                 # OpenCV WASM JS binding (pre-built)
  opencv_js.wasm            # OpenCV WASM binary
```

## Worker Architecture (ocrWorker.ts)
```
Main thread                         ocrWorker.ts (Web Worker)
────────────────────────            ─────────────────────────────────
useOcr.ts                           OpenCV.js (WASM) — loaded once
  │ postMessage(RGBA pixels)  →     applyFiltersV2/V1 via cv.Mat
  │                                 cv.Mat → TIFF (via UTIF)
  │ ← postMessage(OcrLine[])        Tesseract.js worker (inside same worker)
  │                                 Memory monitoring + auto-restart
ocrService.ts
  Promise queue (serial, no drops)
  Timeout (10s) → recreate worker
```

### Memory Management
- **Preventive restart:** Tesseract worker is terminated and recreated every 50 recognitions
- **Heap monitoring:** If `performance.memory.usedJSHeapSize` exceeds 512MB, worker restarts
- **Error recovery:** Any processing error triggers a Tesseract restart
- **Timeout recovery:** If a request takes >10s, the entire Web Worker is terminated and recreated
- **cv.Mat cleanup:** Every OpenCV Mat is explicitly `.delete()`'d after use to prevent WASM heap leaks

## Frame Pipeline (useOcr.ts)
1. `extractFrame()` — canvas `drawImage` + `getImageData` → RGBA pixels
2. RGBA transferred to Web Worker via `postMessage` with `Transferable`
3. Worker: `cv.matFromImageData()` → OpenCV filter pipeline → `matToTiffBuffer()` → Tesseract `recognize()`
4. Worker returns `OcrLine[]` to main thread
5. `combineLines()` → `analyzeMvp()` → dedup → persist to IndexedDB → emit to console

### Frame Queue Behavior
- Self-rescheduling async loop (not setInterval — prevents parallel inflight requests)
- Promise queue in ocrService serializes requests — **no frames are dropped**
- Generation counter prevents stale in-flight requests from emitting after Stop Capture

## Key Fixes Implemented

### useOcr.ts Stability
- **settingsRef pattern:** `settings` is read from a ref, not a useCallback dep. `processFrame` is stable across settings changes — no more polling loop restarts.
- **Generation counter (genRef):** Incremented on stop; checked at every `await` boundary. OCR stops cleanly when Stop Capture is pressed.
- **wasCapturingRef:** Dedup cache only clears on true capture start (false→true transition), not on settings change.
- **Stable dedup key:** `rawTimestamp + ":" + normalizedBody` — tolerates single-char OCR variance.

### ConsolePanel.tsx
- Lines sorted chronologically by in-game `[HH:MM]` timestamp before rendering
- Download Debug Log button in toolbar

## Debug Logging
- Ring buffer in Zustand store (max 500 entries)
- Every pipeline step logged: FRAME, FILTER, OCR, PARSE, DEDUP, EMIT, WORKER, DB
- Download as `.txt` file via toolbar button
- Worker logs forwarded to main thread via postMessage and also echoed to browser console

## Color Palette (MapleStory themed)
| Token | Hex | Usage |
|---|---|---|
| Background | `#1a1a2e` | deep navy |
| Surface | `#16213e` | card/panel background |
| Surface raised | `#0f3460` | slightly lighter surface |
| Accent | `#e8a000` | gold/amber (MVP trophy) |
| Accent light | `#ffd700` | NEW MVP highlight |
| Text primary | `#e2e8f0` | off-white |
| Text dim | `#64748b` | non-MVP OCR lines |
| Border | `#2d3748` | |
| Green | `#48bb78` | active/live indicator |
| Red | `#fc8181` | error/lost capture |

## Key Concepts

### Image Filter Pipeline (OpenCV WASM in Worker)
Mirrors C# `OcrServiceBase.cs` exactly using OpenCV.js API calls.

**V2 (primary):**
1. `cv.cvtColor(RGBA2GRAY)` → `cv.threshold(120, BINARY_INV)` → `cv.threshold(180, BINARY)` → `cv.bitwise_or`
2. `cv.dilate(2,2)` → `cv.morphologyEx(MORPH_OPEN, 40x1)` → `cv.subtract` (removes UI dividers)
3. `cv.bitwise_not` → black text on white for Tesseract

**V1 (fallback, used when V2 yields no valid MVP results and `useMultiFilter` is on):**
1. `cv.bitwise_not` → `cv.cvtColor(RGBA2GRAY)` → `cv.threshold(210, 230, BINARY)` → `cv.copyMakeBorder(10px, white)`

**Frame format:** Filtered output encoded to TIFF via UTIF.js before passing to Tesseract, matching the C# pipeline's `.tiff` format.

### OCR Worker
Single Web Worker containing both OpenCV WASM and a Tesseract.js worker. `load_system_dawg` and `load_freq_dawg` MUST be set in the **4th argument** of `createWorker` (init-only config). PSM 6 is already the default.

### Chat Parser (`chatParserService.ts`)
Port of the original C# `OcrServiceBase.cs` / `RegexPatterns.cs`:
- `combineLines()` — groups OCR lines into messages using leading timestamps
- `analyzeMvp()` — extracts channel, time, location, builds dedup key `"YYYY-MM-DD_HH_mm"`
- `extractChannelAndTime()` — CHANNEL_1/2 patterns then TIME/SPECIAL_TIME/VERBAL_TIME
- `getLocation()` — word-boundary match against MAP_DICTIONARY (38 maps)
- `isValid = hasMvpKeyword && (channel > 0 || willBeUsedAt !== null)`
- Verbal time sentinel: `willBeUsedAt = new Date(0)` (epoch) means "now/soon"

### MVP Dedup
- Key format: `"YYYY-MM-DD_HH_mm"` (UTC date + normalized in-game timestamp)
- Stored in `localStorage` as `msmvp_mvp_codes` array with `capturedAt` epoch
- Entries older than 30 minutes are purged on every `isNewMvp()` check
- Manual "Clear" also wipes dedup codes so previously-seen MVPs ping again

### Capture Region
- Modes: `percent` (recommended) or `absolute` pixels
- Percent mode: multiply by `video.videoWidth` / `video.videoHeight` at extraction time
- Default presets cover 4K / 1440p / 1080p (all identical % — chat box is always proportional)
- `getDisplayMedia` must be called from a user-gesture handler (click). Cannot pre-select a window.

### Console Line Visual States
1. **NEW MVP** — gold background, "NEW" badge, ping triggered
2. **Known MVP** — amber text, MVP details row (Ch / Time / Location badges), no ping
3. **Non-MVP** — dimmed gray text

## localStorage Keys
| Key | Contents |
|---|---|
| `msmvp_settings` | Settings object (JSON) |
| `msmvp_region` | Capture region (JSON) |
| `msmvp_onboarded` | `"true"` after first-visit onboarding |
| `msmvp_mvp_codes` | `[{ code: "YYYY-MM-DD_HH_mm", capturedAt: epoch }]` |

## IndexedDB Schema
Database: `"msmvp"` | Object store: `"messages"` (autoincrement id)
```ts
{ id: number, capturedAt: number, text: string,
  isMvpMatch: boolean, isNewMvp: boolean, details: object | null }
```

## Zustand Store (`appStore.ts`) — Key State
```ts
{
  isCapturing, stream, captureRegion, captureLostMessage,
  isProcessing, currentFilter,   // 'v2' | 'v1' | null
  lastOcrDuration,
  consoleLines,                  // hydrated from IndexedDB on startup
  isPaused,
  debugLog,                      // ring buffer, max 500 entries
  settings: {
    pollingInterval: 2000,
    useMultiFilter: true,
    useUpscale: true,
    maxChannel: 40,
    minConfidence: 30,
    maxMessages: 500,
    autoCleanup: true,
    soundEnabled: true,
    soundVolume: 0.5,
    soundTone: 'sine',
    showMvpOnly: false,
    discordEnabled: false,
    discordWebhookUrl: '',
    discordRoleId: '',
    vlmEnabled: false,
    searchKeywords, exclusionKeywords, replacementKeywords,
  },
  hasCompletedOnboarding,
}
```

## Code Standards
- **Strict TypeScript** — no `any`. Use proper generics, `unknown` + type guards, or specific types.
- **Regex `g`/`i` flags** — reset `lastIndex` between calls or construct a fresh `RegExp` per call to avoid state bleed.
- **IndexedDB async** — all DB operations are async. Never block the UI thread.
- **No audio files** — all sound is generated via Web Audio API.
- **No secrets** — no API keys, credentials, or server-side code anywhere.
- **Tests** — Vitest unit tests colocated as `*.test.ts` next to the file under test.
- **cv.Mat cleanup** — every `cv.Mat` created in the worker MUST be `.delete()`'d in a try/finally to prevent WASM heap leaks.

## Token Efficiency
- Never re-read files you just wrote or edited. You know the contents.
- Never re-run commands to "verify" unless the outcome was uncertain.
- Don't echo back large blocks of code or file contents unless asked.
- Batch related edits into single operations. Don't make 5 edits when 1 handles it.
- Skip confirmations like "I'll continue..." Just do it.
- If a task needs 1 tool call, don't use 3. Plan before acting.
- Do not summarize what you just did unless the result is ambiguous or you need additional input.

## Important Notes
- **RGBA vs BGR**: Canvas gives RGBA. The original C# OpenCvSharp gave BGR. OpenCV.js in the worker receives RGBA and converts to grayscale internally — no channel swap needed.
- **tesseract.js init params**: `load_system_dawg` / `load_freq_dawg` MUST go in the 4th argument of `createWorker`, not `setParameters`. Getting this wrong causes dictionary correction to mangle game-chat tokens like "xx45", "ch5", "hene".
- **PSM 6 is default** in tesseract.js v7 — no explicit set needed.
- **Continuation line logic**: Only append to current message if buffer has an MVP keyword OR (line confidence >= minConfidence AND line has channel/time info). Matches original C# `CombineMessageLinesIntoMessages` exactly.
- **Verbal time sentinel**: `willBeUsedAt = new Date(0)` (epoch) means "now/soon" — check `getTime() === 0` in display logic, do not treat it as a normal date.
- **`getDisplayMedia` must be user-gesture triggered**: call only from a click handler.
- **TIFF frame format**: Frames are encoded to TIFF before passing to Tesseract, matching the C# pipeline's `.tiff` output format. This ensures Leptonica receives its preferred format.
