[![CI](https://github.com/NecturaLabs/MapleStory-MVP-Detector/actions/workflows/ci.yml/badge.svg)](https://github.com/NecturaLabs/MapleStory-MVP-Detector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# MapleStory MVP Detector

Real-time MapleStory MVP announcement detector. Captures your game window via the browser Screen Capture API, OCRs the chat region using OpenCV.js (WASM) + Tesseract.js, and alerts you when MVP announcements are detected.

**Fully client-side** — no backend, no accounts, no data collection. Everything runs in your browser.

## Features

- **Real-time OCR** — OpenCV.js WASM + Tesseract.js v7 running in a Web Worker
- **Smart detection** — Regex pattern matching extracts channel, time, and location from MVP messages
- **Dual filter pipeline** — V2 primary + V1 fallback for maximum detection accuracy
- **Audio alerts** — Web Audio API tone (sine/triangle/square) on new MVP detections
- **Discord notifications** — Optional webhook integration for instant alerts
- **Visual Language Model** — Optional on-device AI verification (experimental, requires WebGPU)
- **Deduplication** — Same MVP won't alert twice within a 30-minute window
- **Persistent history** — Chat history saved to IndexedDB, settings saved to localStorage
- **Configurable** — Polling interval, confidence thresholds, keywords, sound, and more
- **Deployable anywhere** — Static site, works on Netlify, GitHub Pages, Vercel, etc.

## Quick Start

```bash
# Install dependencies
bun install

# Start dev server
bun run dev

# Run tests
bun run test

# Build for production
bun run build
```

> **Note:** You can also use `npm` or `pnpm` instead of `bun`.

## How It Works

1. Click **Start Capture** and select your MapleStory window from the browser picker
2. Draw a box over your chat area (or use a resolution preset)
3. The app captures frames from the chat region every 2 seconds
4. Each frame is processed through an OpenCV filter pipeline, then OCR'd via Tesseract
5. Chat text is parsed for MVP announcements using regex pattern matching
6. New MVPs trigger a visual highlight + audio ping + optional Discord notification

## Configuration

All settings are accessible via the gear icon in the app header. Settings are saved to `localStorage` and persist across sessions.

### Capture

| Setting | Default | Description |
|---|---|---|
| Polling Interval | 2s | How often to capture and OCR a frame (1–10s) |
| Multi-filter Fallback | On | Try V1 filter if V2 yields no MVP results |

### History

| Setting | Default | Description |
|---|---|---|
| Max Messages | 500 | Maximum chat lines to keep in history |
| Auto Cleanup | On | Automatically trim old messages |
| Show MVP Only | Off | Filter console to only show MVP matches |

### Sound

| Setting | Default | Description |
|---|---|---|
| MVP Alert Sound | On | Play a tone on new MVP detection |
| Volume | 50% | Alert volume (0–100%) |
| Tone | Sine | Waveform: sine, triangle, or square |

### Discord Webhook

| Setting | Default | Description |
|---|---|---|
| Enable Discord | Off | Send MVP alerts to a Discord channel |
| Webhook URL | — | Your Discord webhook URL |
| Role ID | — | Optional role ID to ping on alerts |

To set up Discord notifications:
1. In your Discord server, go to **Channel Settings > Integrations > Webhooks**
2. Create a new webhook and copy the URL
3. Paste the URL in the app settings
4. Optionally add a Role ID to ping a specific role

### Experimental

| Setting | Default | Description |
|---|---|---|
| Vision Language Model | Off | On-device AI for OCR verification (requires WebGPU, ~800MB model download) |

## Technology Stack

| Technology | Purpose |
|---|---|
| React 19 + TypeScript | UI framework |
| Vite | Build tool and dev server |
| Zustand | State management |
| Tesseract.js v7 | OCR engine (LSTM, WASM) |
| OpenCV.js | Image preprocessing (WASM, Web Worker) |
| Web Audio API | Alert sound generation |
| IndexedDB | Chat history persistence |
| localStorage | Settings and MVP dedup persistence |

## Project Structure

```
src/
  main.tsx                        # App entry point
  App.tsx                         # Root component + keyboard shortcuts
  components/
    Header.tsx                    # Logo, title, GitHub link, settings, help
    CapturePanel.tsx              # Video preview + region overlay + presets
    ConsolePanel.tsx              # Real-time OCR log with MVP highlights
    StatusBar.tsx                 # Filter mode, OCR duration, match count
    SettingsModal.tsx             # All configurable settings
    OnboardingOverlay.tsx         # First-time user guide
  workers/
    ocrWorker.ts                  # Web Worker: OpenCV WASM + Tesseract OCR
    onnxWorker.ts                 # Web Worker: ONNX runtime for VLM inference
  services/
    captureService.ts             # Screen Capture API (getDisplayMedia)
    ocrService.ts                 # Main-thread OCR worker wrapper
    chatParserService.ts          # Regex patterns + MVP analysis + location
    discordService.ts             # Discord webhook integration
    dbService.ts                  # IndexedDB wrapper
    soundService.ts               # Web Audio API tone generator
    imageFilters.ts               # Pure JS filter pipelines (for tests)
    chatCropService.ts            # VLM chat region extraction
    onnxCorrectionHelpers.ts      # VLM token correction
    onnxService.ts                # Main-thread VLM worker wrapper
  hooks/
    useCapture.ts                 # Stream lifecycle management
    useOcr.ts                     # Frame capture → worker → parser → store
    useChatParser.ts              # React wrapper for chat parser
  store/
    appStore.ts                   # Zustand store
  utils/
    regexPatterns.ts              # 9 regex patterns + 38-entry map dictionary
    persistence.ts                # localStorage/settings serialization
  styles/
    index.css                     # MapleStory-themed dark CSS
public/
  mvp.png                         # Favicon
  opencv.js + opencv_js.wasm      # OpenCV WASM (pre-built)
```

## Testing

### Unit Tests (Vitest)

```bash
bun run test          # Run once
bun run test:watch    # Watch mode
```

The test suite includes:
- **66 chat parser tests** — regex patterns, line combining, MVP analysis, location matching
- **7 OCR integration tests** — full pipeline from TIFF to parsed MVP results (skipped if no test image)
- **Golden regression tests** — validates OCR quality across diverse screenshots (skipped if no fixtures)

### Adding Test Fixtures

The OCR integration and golden regression tests require image files that are not included in the repository (they contain in-game screenshots). To run these tests:

**OCR integration test:**
1. Take a screenshot of your MapleStory chat region containing an MVP announcement
2. Save it as `TEST-SUBJECT.tiff` in the project root
3. Run `bun run test` — the OCR integration suite will now execute

**Golden regression tests:**
1. Place TIFF screenshots in `src/services/__fixtures__/golden/` named `golden_01.tiff`, `golden_02.tiff`, etc.
2. Create a `ground_truth.json` in the same directory with expected results per image:
   ```json
   {
     "golden_01.tiff": {
       "description": "Chat with MVP announcement",
       "minRawLines": 5,
       "minV2Lines": 2,
       "hasMvpContent": true,
       "requiredFragments": ["MVP"]
     }
   }
   ```
3. Run `bun run test` — the golden regression suite will now execute

> Tests that require fixture files **skip gracefully** when fixtures are not present. The CI pipeline runs all non-fixture tests successfully.

## Deployment

The app is a static site. Build and deploy to any static host:

```bash
bun run build    # Output in dist/
```

The build automatically downloads the Tesseract LSTM model (`eng.traineddata.gz`) from jsDelivr CDN.

### Netlify

The included `netlify.toml` handles:
- Build command and publish directory
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options)
- COOP/COEP headers for SharedArrayBuffer (required by OpenCV WASM)
- SPA fallback routing
- Asset caching

### Other Hosts

If deploying elsewhere, ensure these response headers are set for all pages:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```
These are required for SharedArrayBuffer support (used by OpenCV WASM).

## Browser Support

Requires a modern browser with:
- Screen Capture API (`getDisplayMedia`)
- Web Workers + SharedArrayBuffer
- WebAssembly
- IndexedDB

Tested on Chrome/Edge 120+. Firefox support is limited due to SharedArrayBuffer restrictions.

## License

[MIT](LICENSE)
