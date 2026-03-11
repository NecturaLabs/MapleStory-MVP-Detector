/**
 * useChatParser.ts
 * React wrapper around chatParserService — memoized to avoid re-creating on each render.
 */

import { useCallback } from 'react';
import useAppStore from '../store/appStore.ts';
import { combineLines, analyzeMvp } from '../services/chatParserService.ts';
import type { OcrLine } from '../services/ocrService.ts';

export function useChatParser() {
  const settings = useAppStore((s) => s.settings);

  const parseLines = useCallback(
    (ocrLines: OcrLine[]) => combineLines(ocrLines, settings),
    [settings]
  );

  const analyzeMessage = useCallback(
    (text: string) => analyzeMvp(text, settings),
    [settings]
  );

  return { parseLines, analyzeMessage };
}
