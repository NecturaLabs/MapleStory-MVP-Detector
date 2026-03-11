import type { OcrLine } from './ocrService.ts';

/**
 * User instruction sent alongside the image in the VLM user message.
 * Kept minimal — game/context-specific words actively hurt VLM OCR accuracy
 * per empirical testing. Each crop contains exactly one chat message.
 */
export const VLM_USER_INSTRUCTION =
  'This image contains a single chat message. Read the text exactly as shown. Output only one line starting with [HH:MM].';

/**
 * Parse the VLM's raw text output into an OcrLine array.
 * Splits on newlines, trims whitespace, drops blank lines.
 * Confidence is fixed at 50 — the VLM reads directly from the image,
 * so there is no original Tesseract confidence score to inherit.
 *
 * Each VLM frame is a single chat-message crop, so we cap at 3 lines
 * (timestamp line + possible continuation). More than that is hallucination.
 */
export function parseCorrectionOutput(rawOutput: string): OcrLine[] {
  const trimmed = rawOutput.trim();
  if (!trimmed) return [];

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((text) => ({ text, confidence: 50 }));
}
