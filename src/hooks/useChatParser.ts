/**
 * useChatParser.ts
 * React wrapper around chatParserService — memoized to avoid re-creating on each render.
 */

import { useCallback } from 'react';
import { combineLines, analyzeMvp } from '../services/chatParserService.ts';
import type { OcrLine } from '../services/ocrService.ts';

export function useChatParser() {
  const parseLines = useCallback(
    (ocrLines: OcrLine[]) => combineLines(ocrLines),
    []
  );

  const analyzeMessage = useCallback(
    (text: string) => analyzeMvp(text),
    []
  );

  return { parseLines, analyzeMessage };
}
