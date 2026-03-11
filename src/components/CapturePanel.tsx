/**
 * CapturePanel.tsx
 * Left panel: 2-step capture flow.
 *   1. Pick Window — calls getDisplayMedia, shows live preview
 *   2. Start Capture — begins OCR loop on the full captured window/monitor
 */

import React, { useRef, useEffect } from 'react';
import useAppStore from '../store/appStore.ts';
import { useCapture } from '../hooks/useCapture.ts';
import { useOcr } from '../hooks/useOcr.ts';

export default function CapturePanel() {
  const stream         = useAppStore((s) => s.stream);
  const isCapturing    = useAppStore((s) => s.isCapturing);
  const workersReady   = useAppStore((s) => s.workersReady);
  const workerError    = useAppStore((s) => s.workerError);
  const startCapturing = useAppStore((s) => s.startCapturing);
  const stopCapturing  = useAppStore((s) => s.stopCapturing);

  const videoRef = useRef<HTMLVideoElement>(null);
  const { start: pickWindow, stop: releaseWindow } = useCapture();

  // Wire OCR polling to this video element
  useOcr(videoRef);

  // Connect stream to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    } else {
      video.srcObject = null;
    }
  }, [stream]);

  const handlePickWindow = async () => {
    if (stream) {
      stopCapturing();
      releaseWindow();
    } else {
      await pickWindow();
    }
  };

  const handleToggleCapture = () => {
    if (isCapturing) {
      stopCapturing();
    } else {
      startCapturing();
    }
  };

  return (
    <aside className="capture-panel" aria-label="Capture controls">
      {/* Panel header */}
      <div className="panel-header">
        <span className="panel-header__label">Capture</span>
      </div>

      {/* Video preview */}
      <div className="video-wrap">
        <div className="video-wrap__inner">
          {stream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="MapleStory window capture preview"
            />
          ) : (
            <>
              {/* Hidden video still needed for OCR even when no preview */}
              <video ref={videoRef} autoPlay muted playsInline style={{ display: 'none' }} />
              <div className="video-wrap__empty" aria-label="No capture active">
                <span className="video-wrap__empty-icon" aria-hidden="true">1</span>
                <p className="video-wrap__empty-text">
                  Click <strong>Pick Window</strong> and select your MapleStory window.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Timestamp reminder */}
      <div className="capture-notice" role="note">
        <span className="capture-notice__icon" aria-hidden="true">&#9200;</span>
        <div className="capture-notice__text">
          <strong>Chat timestamps</strong> must be enabled in MapleStory.
          <span className="capture-notice__path">Options &gt; Community &gt; Chat Timestamps</span>
        </div>
      </div>

      {/* Controls bar */}
      <div className="capture-controls">
        {/* Step 1: Pick Window */}
        <div className="capture-controls__row">
          <button
            className={`capture-controls__btn-pick${stream ? ' is-active' : ''}`}
            onClick={handlePickWindow}
            disabled={isCapturing}
            aria-label={stream ? 'Release window' : 'Pick a window to capture'}
            title={isCapturing ? 'Stop capture first to change window' : undefined}
          >
            {stream ? (
              <>
                <WindowIcon />
                Release Window
              </>
            ) : (
              <>
                <WindowIcon />
                Pick Window
              </>
            )}
          </button>
        </div>

        {/* Step 2: Start / Stop Capture */}
        <div className="capture-controls__row">
          <button
            className={`capture-controls__btn-start${isCapturing ? ' is-active' : ''}${!workersReady && !workerError && !isCapturing ? ' is-loading' : ''}${workerError && !isCapturing ? ' is-error' : ''}`}
            onClick={workerError ? () => window.location.reload() : handleToggleCapture}
            disabled={(!stream || !workersReady) && !isCapturing && !workerError}
            aria-pressed={isCapturing}
            aria-label={isCapturing ? 'Stop OCR capture' : (workerError ? 'OCR init failed — click to reload' : (!workersReady ? 'Initializing OCR engine...' : 'Start OCR capture'))}
            title={workerError ? `Error: ${workerError}` : (!stream && !isCapturing ? 'Pick a window first' : (!workersReady && !isCapturing ? 'OCR engine is loading...' : undefined))}
          >
            {isCapturing ? (
              <>
                <StopIcon />
                Stop Capture
              </>
            ) : workerError ? (
              <>
                <ErrorIcon />
                Init Failed — Reload
              </>
            ) : !workersReady ? (
              <>
                <SpinnerIcon />
                Initializing...
              </>
            ) : (
              <>
                <StartIcon />
                Start Capture
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function WindowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function StartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
    </svg>
  );
}
