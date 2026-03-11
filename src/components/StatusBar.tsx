/**
 * StatusBar.tsx
 * Bottom status bar: capture state, OCR status, filter version, timing, match count.
 */

import React from 'react';
import useAppStore from '../store/appStore.ts';

export default function StatusBar() {
  const isCapturing     = useAppStore((s) => s.isCapturing);
  const stream          = useAppStore((s) => s.stream);
  const isProcessing    = useAppStore((s) => s.isProcessing);
  const currentFilter   = useAppStore((s) => s.currentFilter);
  const lastOcrDuration = useAppStore((s) => s.lastOcrDuration);
  const matchCount      = useAppStore((s) => s.matchCount);
  const consoleLines    = useAppStore((s) => s.consoleLines);
  const captureLostMessage = useAppStore((s) => s.captureLostMessage);

  // 3 states: capturing (OCR running), window selected (stream but no OCR), idle/disconnected
  const hasWindow = stream !== null;

  const dotClass = isCapturing
    ? isProcessing
      ? 'status-bar__dot status-bar__dot--processing'
      : 'status-bar__dot status-bar__dot--live'
    : captureLostMessage
      ? 'status-bar__dot status-bar__dot--error'
      : hasWindow
        ? 'status-bar__dot status-bar__dot--ready'
        : 'status-bar__dot';

  const statusLabel = isCapturing
    ? isProcessing ? 'Processing' : 'Live'
    : captureLostMessage ? 'Disconnected'
    : hasWindow ? 'Ready' : 'Idle';

  const statusValClass = isCapturing
    ? isProcessing ? 'status-bar__val status-bar__val--gold' : 'status-bar__val status-bar__val--green'
    : captureLostMessage ? 'status-bar__val status-bar__val--red'
    : hasWindow ? 'status-bar__val status-bar__val--blue' : 'status-bar__val';

  return (
    <footer className="status-bar" role="contentinfo" aria-label="Status bar">
      {/* Status dot + label */}
      <div className="status-bar__seg">
        <span className={dotClass} aria-hidden="true" />
        <span className={statusValClass}>{statusLabel}</span>
      </div>

      {captureLostMessage ? (
        <span className="status-bar__error">{captureLostMessage}</span>
      ) : (
        <>
          {/* Filter version */}
          {isCapturing && currentFilter && (
            <>
              <span className="status-bar__sep" aria-hidden="true" />
              <div className="status-bar__seg">
                <span>Filter</span>
                <span className={`filter-pill filter-pill--${currentFilter}`}>
                  {currentFilter.toUpperCase()}
                </span>
              </div>
            </>
          )}

          {/* OCR timing */}
          {isCapturing && lastOcrDuration > 0 && (
            <>
              <span className="status-bar__sep" aria-hidden="true" />
              <div className="status-bar__seg">
                <span>OCR</span>
                <span className="status-bar__val">{lastOcrDuration}ms</span>
              </div>
            </>
          )}

          <span className="status-bar__sep" aria-hidden="true" />

          {/* Line count */}
          <div className="status-bar__seg" style={{ marginLeft: 'auto' }}>
            <span>{consoleLines.length} line{consoleLines.length !== 1 ? 's' : ''}</span>
            {matchCount > 0 && (
              <>
                <span className="status-bar__sep" aria-hidden="true" />
                <span className="status-bar__val status-bar__val--gold">
                  {matchCount} MVP match{matchCount !== 1 ? 'es' : ''}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </footer>
  );
}
