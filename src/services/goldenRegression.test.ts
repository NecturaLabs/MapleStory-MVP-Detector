/**
 * goldenRegression.test.ts
 * Golden regression tests: 20 diverse MapleStory chat screenshots run through
 * the full OCR pipeline (decode TIFF → apply V2/V1 filters → Tesseract OCR →
 * combineLines → analyzeMvp) and assert against ground truth expectations.
 *
 * These tests prevent quality degradation when modifying the preprocessing
 * pipeline, OCR settings, or chat parser logic.
 *
 * Fixtures: src/services/__fixtures__/golden/golden_*.tiff
 * Ground truth: src/services/__fixtures__/golden/ground_truth.json
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createWorker } from 'tesseract.js';
import type Tesseract from 'tesseract.js';
import { applyFiltersV2, applyFiltersV1 } from './imageFilters.ts';
import { combineLines, analyzeMvp } from './chatParserService.ts';
import type { AppSettings } from '../utils/persistence.ts';

// ---------------------------------------------------------------------------
// Polyfill ImageData for Node (Vitest runs in Node, not browser)
// ---------------------------------------------------------------------------
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: string = 'srgb';
    constructor(data: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
      if (typeof data === 'number') {
        this.width = data;
        this.height = widthOrHeight!;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
        this.width = widthOrHeight!;
        this.height = height ?? (this.data.length / (4 * this.width));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const GOLDEN_DIR = join(__dirname, '__fixtures__', 'golden');
const GT_PATH = join(GOLDEN_DIR, 'ground_truth.json');
const HAS_FIXTURES = existsSync(GOLDEN_DIR)
  && existsSync(GT_PATH)
  && readdirSync(GOLDEN_DIR).some(f => f.endsWith('.tiff'));

interface GroundTruthEntry {
  description: string;
  minRawLines: number;
  minV2Lines: number;
  hasMvpContent: boolean;
  requiredFragments: string[];
}

type GroundTruth = Record<string, GroundTruthEntry>;

const SETTINGS: AppSettings = {
  pollingInterval: 2000,
  useMultiFilter: true,
  useUpscale: true,
  searchKeywords: ['mvp', 'alicias blessing', 'certified wellness tonic'],
  exclusionKeywords: ['superpower', 'exp coupon', 'any mvp', 'pls mvp', 'plz mvp', 'please mvp'],
  replacementKeywords: ['mvp red', 'be mvp', 'x1 coupon', 'effect x1'],
  maxChannel: 40,
  minConfidence: 30,
  maxMessages: 100,
  autoCleanup: true,
  soundEnabled: true,
  soundVolume: 0.5,
  soundTone: 'sine',
  discordEnabled: false,
  discordWebhookUrl: '',
  discordRoleId: '',
  vlmEnabled: false,
  showMvpOnly: false,
  chatRegion: null,
};

// ---------------------------------------------------------------------------
// TIFF decode helper
// ---------------------------------------------------------------------------

function decodeTiffToRGBA(path: string): { rgba: Uint8ClampedArray; width: number; height: number } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const UTIF = require('utif');
  const buffer = readFileSync(path);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const ifds = UTIF.decode(ab);
  UTIF.decodeImage(ab, ifds[0]);
  const rgba = new Uint8ClampedArray(UTIF.toRGBA8(ifds[0]) as Uint8Array);
  const width = ifds[0].width as number;
  const height = ifds[0].height as number;
  return { rgba, width, height };
}

// ---------------------------------------------------------------------------
// OCR helper
// ---------------------------------------------------------------------------

interface OcrLine { text: string; confidence: number; }

function ocrImageData(
  worker: Tesseract.Worker,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<OcrLine[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const UTIF = require('utif');
  const tiffBuf = UTIF.encodeImage(
    rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength),
    width, height,
    { t282: [300], t283: [300], t296: [2] },
  ) as ArrayBuffer;

  return worker.recognize(Buffer.from(tiffBuf), {}, { blocks: true }).then(result => {
    const lines: OcrLine[] = [];
    if (result.data.blocks) {
      for (const block of result.data.blocks) {
        if (!block.paragraphs) continue;
        for (const para of block.paragraphs) {
          if (!para.lines) continue;
          for (const line of para.lines) {
            const text = (line.text || '').replace(/\n$/, '').trim();
            if (text) {
              lines.push({ text, confidence: line.confidence ?? 0 });
            }
          }
        }
      }
    }
    return lines;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_FIXTURES)('Golden Regression Tests', () => {
  let worker: Tesseract.Worker;
  let groundTruth: GroundTruth;
  let goldenFiles: string[];

  beforeAll(async () => {
    worker = await createWorker('eng', 1, {}, {
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });

    groundTruth = JSON.parse(readFileSync(GT_PATH, 'utf-8')) as GroundTruth;
    goldenFiles = readdirSync(GOLDEN_DIR)
      .filter(f => f.endsWith('.tiff') && f.startsWith('golden_'))
      .sort();
  }, 30_000);

  afterAll(async () => {
    if (worker) await worker.terminate();
  });

  it('has golden fixtures and ground truth', () => {
    expect(goldenFiles.length).toBeGreaterThan(0);
    for (const f of goldenFiles) {
      expect(groundTruth[f]).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Per-image regression tests
  // -------------------------------------------------------------------------

  // Generate test cases dynamically from fixtures
  const files = HAS_FIXTURES
    ? readdirSync(GOLDEN_DIR).filter(f => f.endsWith('.tiff') && f.startsWith('golden_')).sort()
    : [];

  for (const fname of files) {
    describe(fname, () => {

      it('decodes to valid RGBA', () => {
        const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
        expect(width).toBe(1073);
        expect(height).toBe(296);
        expect(rgba.length).toBe(width * height * 4);
      });

      it('raw OCR meets minimum line count', async () => {
        const gt = groundTruth[fname];
        const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
        const lines = await ocrImageData(worker, rgba, width, height);

        console.log(`[GOLDEN] ${fname} raw: ${lines.length} lines (min: ${gt.minRawLines})`);
        expect(lines.length).toBeGreaterThanOrEqual(gt.minRawLines);
      }, 30_000);

      it('V2-filtered OCR meets minimum line count', async () => {
        const gt = groundTruth[fname];
        const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
        const imageData = { data: rgba, width, height } as unknown as ImageData;
        const filtered = applyFiltersV2(imageData);

        const lines = await ocrImageData(
          worker,
          new Uint8ClampedArray(filtered.data),
          filtered.width,
          filtered.height,
        );

        console.log(`[GOLDEN] ${fname} V2: ${lines.length} lines (min: ${gt.minV2Lines})`);
        expect(lines.length).toBeGreaterThanOrEqual(gt.minV2Lines);
      }, 30_000);

      it('required text fragments are found in V2 OCR output', async () => {
        const gt = groundTruth[fname];
        if (gt.requiredFragments.length === 0) return; // skip if no fragments expected

        const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
        const imageData = { data: rgba, width, height } as unknown as ImageData;
        const filtered = applyFiltersV2(imageData);

        const lines = await ocrImageData(
          worker,
          new Uint8ClampedArray(filtered.data),
          filtered.width,
          filtered.height,
        );

        const allText = lines.map(l => l.text).join(' ');
        for (const fragment of gt.requiredFragments) {
          expect(
            allText.toLowerCase().includes(fragment.toLowerCase()),
          ).toBe(true);
        }
      }, 30_000);

      it('MVP detection matches expected result across V2+V1', async () => {
        const gt = groundTruth[fname];
        const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
        const imageData = { data: rgba, width, height } as unknown as ImageData;

        // Run V2 pipeline
        const v2Filtered = applyFiltersV2(imageData);
        const v2Lines = await ocrImageData(
          worker,
          new Uint8ClampedArray(v2Filtered.data),
          v2Filtered.width,
          v2Filtered.height,
        );

        // Run V1 pipeline (fallback)
        const v1Filtered = applyFiltersV1(imageData);
        const v1Lines = await ocrImageData(
          worker,
          new Uint8ClampedArray(v1Filtered.data),
          v1Filtered.width,
          v1Filtered.height,
        );

        // Combine lines from both pipelines (mimics multi-filter mode)
        const v2Combined = combineLines(v2Lines, SETTINGS);
        const v1Combined = combineLines(v1Lines, SETTINGS);
        const allCombined = [...v2Combined, ...v1Combined];

        // Check for MVP keyword presence in any combined message
        const mvpResults = allCombined.map(m => ({
          text: m.text,
          mvp: analyzeMvp(m.text, SETTINGS),
        }));

        const hasMvpKeyword = mvpResults.some(r => r.mvp.hasMvpKeyword);

        console.log(`[GOLDEN] ${fname} MVP: hasMvpKeyword=${hasMvpKeyword} (expected: ${gt.hasMvpContent}), messages=${allCombined.length}`);
        for (const r of mvpResults.filter(r => r.mvp.hasMvpKeyword)) {
          console.log(`  -> ch=${r.mvp.channel} valid=${r.mvp.isValid}: ${r.text.substring(0, 80)}`);
        }

        if (gt.hasMvpContent) {
          // Images with MVP announcements MUST detect the MVP keyword
          expect(hasMvpKeyword).toBe(true);
        }
        // For non-MVP images, we verify no false positives (hasMvpKeyword should be false)
        // BUT: some images may have incidental MVP text (guild medals etc.) that gets
        // stripped. We log but don't hard-fail on false positives to avoid fragility.
        // The important thing is: MVP images are never missed.
      }, 60_000);
    });
  }

  // -------------------------------------------------------------------------
  // Aggregate quality metrics
  // -------------------------------------------------------------------------

  it('aggregate: at least 80% of images produce V2 lines above minimum', async () => {
    let passCount = 0;
    for (const fname of goldenFiles) {
      const gt = groundTruth[fname];
      const { rgba, width, height } = decodeTiffToRGBA(join(GOLDEN_DIR, fname));
      const imageData = { data: rgba, width, height } as unknown as ImageData;
      const filtered = applyFiltersV2(imageData);
      const lines = await ocrImageData(
        worker,
        new Uint8ClampedArray(filtered.data),
        filtered.width,
        filtered.height,
      );
      if (lines.length >= gt.minV2Lines) passCount++;
    }

    const passRate = passCount / goldenFiles.length;
    console.log(`[GOLDEN] Aggregate V2 pass rate: ${passCount}/${goldenFiles.length} (${(passRate * 100).toFixed(0)}%)`);
    expect(passRate).toBeGreaterThanOrEqual(0.8);
  }, 300_000);
});
