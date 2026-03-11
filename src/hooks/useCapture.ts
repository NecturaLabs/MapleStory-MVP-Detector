/**
 * useCapture.ts
 * Manages stream lifecycle: start/stop screen capture.
 */

import { useCallback, useRef } from 'react';
import useAppStore from '../store/appStore.ts';
import { startCapture, stopCapture } from '../services/captureService.ts';

export function useCapture() {
  const setStream = useAppStore((s) => s.setStream);
  const handleCaptureLost = useAppStore((s) => s.handleCaptureLost);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const newStream = await startCapture(() => {
        handleCaptureLost();
        streamRef.current = null;
      });
      streamRef.current = newStream;
      setStream(newStream);
      return newStream;
    } catch (err) {
      console.warn('[useCapture] getDisplayMedia cancelled or denied:', err);
      return null;
    }
  }, [setStream, handleCaptureLost]);

  const stop = useCallback(() => {
    if (streamRef.current) {
      stopCapture(streamRef.current);
      streamRef.current = null;
    }
    setStream(null);
  }, [setStream]);

  return { start, stop };
}
