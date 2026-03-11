/**
 * Download eng.traineddata.gz from the jsDelivr CDN to public/.
 * Runs as npm prebuild so the file is present in dist/ on every build.
 * The file is gitignored (*.traineddata.gz) — it must be fetched at build time.
 *
 * This is the same URL tesseract.js uses internally for LSTM_ONLY (OEM 1) English:
 *   https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
 */

import { createWriteStream, mkdirSync, statSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const TESSDATA_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const DEST = 'public/eng.traineddata.gz';
const MIN_SIZE_BYTES = 1_000_000; // guard against truncated partial downloads

mkdirSync('public', { recursive: true });

// Skip if already downloaded and complete (avoids re-downloading on every local build)
try {
  const { size } = statSync(DEST);
  if (size > MIN_SIZE_BYTES) {
    console.log(`[prebuild] eng.traineddata.gz already present (${(size / 1024 / 1024).toFixed(1)} MB), skipping download.`);
    process.exit(0);
  }
} catch { /* file doesn't exist yet — fall through to download */ }

console.log('[prebuild] Downloading eng.traineddata.gz from jsDelivr...');

const response = await fetch(TESSDATA_URL);
if (!response.ok) {
  throw new Error(`Failed to download tessdata: ${response.status} ${response.statusText}`);
}

const writer = createWriteStream(DEST);
try {
  await pipeline(Readable.fromWeb(response.body), writer);
} catch (err) {
  // Clean up partial download so the next build attempt re-downloads
  try { unlinkSync(DEST); } catch { /* ignore */ }
  throw err;
}

const { size } = statSync(DEST);
console.log(`[prebuild] eng.traineddata.gz saved to ${DEST} (${(size / 1024 / 1024).toFixed(1)} MB)`);
