/**
 * appStore.ts
 * Zustand store for global application state.
 * Settings and region are persisted to localStorage.
 */

import { create } from 'zustand';
import {
  loadSettings,
  saveSettings,
  hasCompletedOnboarding,
  setOnboardingComplete,
  resetOnboarding,
  isNewMvp as checkIsNewMvp,
  clearMvpCodes,
  DEFAULT_SETTINGS,
  type AppSettings,
} from '../utils/persistence.ts';
import { clearAll as clearAllMessages } from '../services/dbService.ts';
import type { DbMessage } from '../services/dbService.ts';

export type ConsoleLine = DbMessage & {
  id?: number;
  confidence?: number;
  source?: 'tesseract' | 'onnx';
  onnxRejected?: boolean;
  /** Transient VLM pipeline state — not persisted to IndexedDB. */
  vlmStatus?: 'pending' | 'processing';
};

export type FilterVersion = 'v1' | 'v2' | 'raw';

// ---------------------------------------------------------------------------
// Debug log types
// ---------------------------------------------------------------------------

export interface DebugEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  cat: string;
  msg: string;
  data?: unknown;
}

const DEBUG_LOG_MAX = 500;

// ---------------------------------------------------------------------------
// Timestamp sorting helper
// ---------------------------------------------------------------------------

/**
 * Parse a rawTimestamp string (e.g. "09:12", "0912") into a sortable
 * integer: HH * 60 + MM.  Returns -1 if not parseable.
 */
function timestampToMinutes(raw: string | null | undefined): number {
  if (!raw) return -1;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length !== 4) return -1;
  const hh = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  if (hh > 23 || mm > 59) return -1;
  return hh * 60 + mm;
}

/**
 * Compare two ConsoleLine entries chronologically:
 * 1. By in-game timestamp (HH:MM) if both have one
 * 2. Fall back to capturedAt
 */
function compareLines(a: ConsoleLine, b: ConsoleLine): number {
  const aMin = timestampToMinutes(a.details?.rawTimestamp);
  const bMin = timestampToMinutes(b.details?.rawTimestamp);
  if (aMin >= 0 && bMin >= 0) {
    if (aMin !== bMin) return aMin - bMin;
    return a.capturedAt - b.capturedAt;
  }
  return a.capturedAt - b.capturedAt;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface AppState {
  // Capture
  isCapturing: boolean;
  stream: MediaStream | null;
  captureLostMessage: string | null;
  setStream: (stream: MediaStream | null) => void;
  startCapturing: () => void;
  stopCapturing: () => void;
  handleCaptureLost: () => void;
  clearCaptureLostMessage: () => void;

  // Worker readiness (eager init on page load)
  workersReady: boolean;
  workerError: string | null;
  setWorkersReady: (ready: boolean) => void;
  setWorkerError: (err: string | null) => void;

  // OCR / processing
  isProcessing: boolean;
  currentFilter: FilterVersion | null;
  lastOcrDuration: number;
  setProcessing: (isProcessing: boolean) => void;
  setFilterInfo: (currentFilter: FilterVersion, lastOcrDuration: number) => void;

  // Console
  consoleLines: ConsoleLine[];
  isPaused: boolean;
  matchCount: number;
  setConsoleLines: (lines: ConsoleLine[]) => void;
  addConsoleLine: (entry: ConsoleLine) => void;
  updateConsoleLine: (index: number, patch: Partial<ConsoleLine>) => void;
  clearConsole: () => void;
  setPaused: (isPaused: boolean) => void;

  // Settings
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;

  // Onboarding
  hasCompletedOnboarding: boolean;
  completeOnboarding: () => void;
  showOnboarding: () => void;

  // Settings modal
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  // MVP dedup
  isNewMvp: (dedupKey: string) => boolean;

  // Chat log download
  downloadChatLog: () => void;

  // Debug log (internal ring buffer)
  debugLog: DebugEntry[];
  addDebugLog: (level: DebugEntry['level'], cat: string, msg: string, data?: unknown) => void;
  clearDebugLog: () => void;
}

const useAppStore = create<AppState>((set, get) => ({
  // ---------------------------------------------------------------------------
  // Capture state
  // ---------------------------------------------------------------------------
  isCapturing: false,
  stream: null,
  captureLostMessage: null,

  setStream: (stream) => set({ stream, isCapturing: false, captureLostMessage: null }),

  startCapturing: () => {
    const { stream } = get();
    if (stream) {
      set({ isCapturing: true });
    }
  },

  stopCapturing: () => set({ isCapturing: false }),

  handleCaptureLost: () => {
    set({
      isCapturing: false,
      stream: null,
      captureLostMessage: 'Screen capture ended. Pick a window to reconnect.',
    });
  },

  clearCaptureLostMessage: () => set({ captureLostMessage: null }),

  // ---------------------------------------------------------------------------
  // Worker readiness
  // ---------------------------------------------------------------------------
  workersReady: false,
  workerError: null,
  setWorkersReady: (ready) => set({ workersReady: ready }),
  setWorkerError: (err) => set({ workerError: err }),

  // ---------------------------------------------------------------------------
  // OCR / processing state
  // ---------------------------------------------------------------------------
  isProcessing: false,
  currentFilter: null,
  lastOcrDuration: 0,

  setProcessing: (isProcessing) => set({ isProcessing }),
  setFilterInfo: (currentFilter, lastOcrDuration) => set({ currentFilter, lastOcrDuration }),

  // ---------------------------------------------------------------------------
  // Console
  // ---------------------------------------------------------------------------
  consoleLines: [],
  isPaused: false,
  matchCount: 0,

  setConsoleLines: (lines) => set({ consoleLines: lines }),

  addConsoleLine: (entry) => {
    set((state) => {
      const maxMessages = state.settings.maxMessages;
      const arr = state.consoleLines;

      // Binary search for insertion point to maintain chronological order
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareLines(arr[mid], entry) <= 0) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }

      const next = [...arr.slice(0, lo), entry, ...arr.slice(lo)];
      const trimmed = next.length > maxMessages ? next.slice(next.length - maxMessages) : next;
      return {
        consoleLines: trimmed,
        matchCount: entry.isMvpMatch ? state.matchCount + 1 : state.matchCount,
      };
    });
  },

  updateConsoleLine: (index, patch) => {
    set((state) => {
      if (index < 0 || index >= state.consoleLines.length) return state;
      const next = [...state.consoleLines];
      next[index] = { ...next[index], ...patch };
      return { consoleLines: next };
    });
  },

  clearConsole: () => {
    clearMvpCodes();
    set({ consoleLines: [], matchCount: 0 });
    // Wipe all messages from IndexedDB persistence
    clearAllMessages().catch((err) => console.warn('[appStore] clearAll failed:', err));
  },

  setPaused: (isPaused) => set({ isPaused }),

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  settings: loadSettings(),

  updateSettings: (partial) => {
    set((state) => {
      const next = { ...state.settings, ...partial };
      saveSettings(next);
      return { settings: next };
    });
  },

  resetSettings: () => {
    const fresh = { ...DEFAULT_SETTINGS };
    saveSettings(fresh);
    set({ settings: fresh });
  },

  // ---------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------
  hasCompletedOnboarding: hasCompletedOnboarding(),

  completeOnboarding: () => {
    setOnboardingComplete();
    set({ hasCompletedOnboarding: true });
  },

  showOnboarding: () => {
    resetOnboarding();
    set({ hasCompletedOnboarding: false });
  },

  // ---------------------------------------------------------------------------
  // Settings modal
  // ---------------------------------------------------------------------------
  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),

  // ---------------------------------------------------------------------------
  // MVP dedup (delegates to persistence.ts)
  // ---------------------------------------------------------------------------
  isNewMvp: (dedupKey) => checkIsNewMvp(dedupKey),

  // ---------------------------------------------------------------------------
  // Chat log download — exports all stored chat messages as a text file
  // ---------------------------------------------------------------------------
  downloadChatLog: () => {
    const { consoleLines } = get();
    if (consoleLines.length === 0) return;

    // Regex to find embedded timestamps mid-string — these are separate messages
    // that got batched together by old combineLines logic or OCR border artifacts.
    // Matches: optional junk chars (border misreads) + [HH:MM] pattern
    const embeddedTsRe = /\s+(?:[|lIJBb}\]]{1,2}\s*)?(\[?(?:[01]\d|2[0-3])(?:[.:\-])[0-5]\d\]?)/g;

    /**
     * Split a message text that may contain multiple batched messages
     * into individual lines, each starting with its own timestamp.
     */
    const splitBatched = (text: string): string[] => {
      // Find all timestamp positions after the first character
      const splits: number[] = [];
      embeddedTsRe.lastIndex = 1; // skip index 0 — the message's own timestamp
      let m: RegExpExecArray | null;
      while ((m = embeddedTsRe.exec(text)) !== null) {
        // Only split if the timestamp capture group looks like a real timestamp
        // and there's whitespace before it (not part of a word)
        splits.push(m.index);
      }

      if (splits.length === 0) return [text.trim()];

      const parts: string[] = [];
      let start = 0;
      for (const pos of splits) {
        const chunk = text.slice(start, pos).trim();
        if (chunk) parts.push(chunk);
        start = pos;
      }
      // Last segment
      const last = text.slice(start).trim();
      if (last) parts.push(last);

      // Clean leading border artifacts from each split part
      return parts.map((p) => p.replace(/^[|lIJBb}\]]{1,2}\s*/, '').trim()).filter(Boolean);
    };

    const outputLines: string[] = [];
    for (const line of consoleLines) {
      const parts = splitBatched(line.text);
      for (const part of parts) {
        outputLines.push(part);
      }
    }

    const text = outputLines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `msmvp-chatlog-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // ---------------------------------------------------------------------------
  // Debug log (internal ring buffer, max 500 entries)
  // ---------------------------------------------------------------------------
  debugLog: [],

  addDebugLog: (level, cat, msg, data?) => {
    set((state) => {
      const entry: DebugEntry = { ts: Date.now(), level, cat, msg, data };
      const next = [...state.debugLog, entry];
      return {
        debugLog: next.length > DEBUG_LOG_MAX ? next.slice(next.length - DEBUG_LOG_MAX) : next,
      };
    });
  },

  clearDebugLog: () => set({ debugLog: [] }),
}));

export default useAppStore;
