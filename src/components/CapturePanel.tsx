/**
 * CapturePanel.tsx
 * Left panel: 2-step capture flow.
 *   1. Pick Window — calls getDisplayMedia, shows live preview
 *   2. Start Capture — begins OCR loop on the full captured window/monitor
 *
 * "Set Crop Region" opens a modal where the user drags over a canvas snapshot
 * of the current video frame to define the chat area.
 * The crop is stored as percentages so it works across resolutions.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import useAppStore from '../store/appStore.ts';
import { useCapture } from '../hooks/useCapture.ts';
import { useOcr } from '../hooks/useOcr.ts';

// ---------------------------------------------------------------------------
// CropModal — full-screen modal with a canvas snapshot of the video frame.
// User drags to select a region; Confirm saves it as percentages.
// ---------------------------------------------------------------------------

interface CropModalProps {
  video: HTMLVideoElement;
  initial: { xPct: number; yPct: number; wPct: number; hPct: number } | null;
  onConfirm: (region: { xPct: number; yPct: number; wPct: number; hPct: number }) => void;
  onCancel: () => void;
}

function CropModal({ video, initial, onConfirm, onCancel }: CropModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);

  // Snapshot dimensions (native video resolution)
  const vW = video.videoWidth;
  const vH = video.videoHeight;

  // Drag state (in canvas-display-pixel coords)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd,   setDragEnd]   = useState<{ x: number; y: number } | null>(null);

  // Convert initial pct region → saved selection for display
  const [saved, setSaved] = useState<{ xPct: number; yPct: number; wPct: number; hPct: number } | null>(initial);

  // Draw video snapshot onto canvas once on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vW || !vH) return;
    canvas.width  = vW;
    canvas.height = vH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, vW, vH);
  }, [video, vW, vH]);

  // Map mouse event → percentage within the canvas display area
  const mouseToCanvasPct = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
    const yPct = Math.max(0, Math.min(1, (e.clientY - rect.top)   / rect.height));
    return { x: xPct, y: yPct }; // stored directly as percentages
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    const pt = mouseToCanvasPct(e);
    if (!pt) return;
    e.preventDefault();
    setDragStart(pt);
    setDragEnd(pt);
    setSaved(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStart) return;
    const pt = mouseToCanvasPct(e);
    if (pt) setDragEnd(pt);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!dragStart) return;
    const pt  = mouseToCanvasPct(e) ?? dragEnd ?? dragStart;
    const xPct = Math.min(dragStart.x, pt.x);
    const yPct = Math.min(dragStart.y, pt.y);
    const wPct = Math.abs(pt.x - dragStart.x);
    const hPct = Math.abs(pt.y - dragStart.y);
    if (wPct >= 0.02 && hPct >= 0.02) {
      setSaved({ xPct, yPct, wPct, hPct });
    }
    setDragStart(null);
    setDragEnd(null);
  };

  // Compute current drag rect for overlay (as % strings for CSS)
  const getDragStyle = (): React.CSSProperties | null => {
    if (!dragStart || !dragEnd) return null;
    return {
      position: 'absolute',
      left:   `${Math.min(dragStart.x, dragEnd.x) * 100}%`,
      top:    `${Math.min(dragStart.y, dragEnd.y) * 100}%`,
      width:  `${Math.abs(dragEnd.x - dragStart.x) * 100}%`,
      height: `${Math.abs(dragEnd.y - dragStart.y) * 100}%`,
      border: '2px dashed #ffcc00',
      background: 'rgba(255, 204, 0, 0.10)',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    };
  };

  const getSavedStyle = (): React.CSSProperties | null => {
    if (!saved || dragStart) return null;
    return {
      position: 'absolute',
      left:   `${saved.xPct * 100}%`,
      top:    `${saved.yPct * 100}%`,
      width:  `${saved.wPct * 100}%`,
      height: `${saved.hPct * 100}%`,
      border: '2px solid #ffcc00',
      background: 'rgba(255, 204, 0, 0.08)',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    };
  };

  const dragStyle  = getDragStyle();
  const savedStyle = getSavedStyle();

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 16,
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <p style={{ color: '#fff', margin: 0, fontSize: 14 }}>
        Drag to select your chat region, then click <strong>Confirm</strong>.
      </p>

      {/* Canvas wrapper — fills available space but keeps aspect ratio */}
      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          maxWidth: '90vw',
          maxHeight: '75vh',
          lineHeight: 0,
          cursor: 'crosshair',
          userSelect: 'none',
        }}
        onMouseDown={handleMouseDown}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            maxWidth: '90vw',
            maxHeight: '75vh',
            objectFit: 'contain',
          }}
        />

        {/* Overlay rects — positioned relative to canvas using % */}
        {dragStyle  && <div style={dragStyle}  aria-hidden="true" />}
        {savedStyle && <div style={savedStyle} aria-hidden="true" />}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <button
          className="capture-controls__btn-pick"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className={`capture-controls__btn-start${saved ? '' : ' is-loading'}`}
          disabled={!saved}
          onClick={() => saved && onConfirm(saved)}
          aria-label="Confirm crop region"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapturePanel
// ---------------------------------------------------------------------------

export default function CapturePanel() {
  const stream         = useAppStore((s) => s.stream);
  const isCapturing    = useAppStore((s) => s.isCapturing);
  const workersReady   = useAppStore((s) => s.workersReady);
  const workerError    = useAppStore((s) => s.workerError);
  const settings       = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const startCapturing = useAppStore((s) => s.startCapturing);
  const stopCapturing  = useAppStore((s) => s.stopCapturing);

  const videoRef = useRef<HTMLVideoElement>(null);
  const { start: pickWindow, stop: releaseWindow } = useCapture();

  const [cropModalOpen, setCropModalOpen] = useState(false);

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

  const handleCropConfirm = (region: { xPct: number; yPct: number; wPct: number; hPct: number }) => {
    updateSettings({ chatRegion: region });
    setCropModalOpen(false);
  };

  return (
    <aside className="capture-panel" aria-label="Capture controls">
      {/* Panel header */}
      <div className="panel-header">
        <span className="panel-header__label">Capture</span>
      </div>

      {/* Video preview (display only — no drag interaction) */}
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

        {/* Crop region controls (only available when a stream is active) */}
        {stream && (
          <div className="capture-controls__row">
            <button
              className="capture-controls__btn-pick"
              onClick={() => setCropModalOpen(true)}
              aria-label="Set chat crop region"
              title="Open the crop editor to select your chat area"
            >
              <CropIcon />
              {settings.chatRegion ? 'Edit Crop Region' : 'Set Crop Region'}
            </button>

            {settings.chatRegion && (
              <button
                className="capture-controls__btn-pick"
                onClick={() => updateSettings({ chatRegion: null })}
                aria-label="Clear chat region crop"
                title="Remove crop region — OCR will process the full frame"
                style={{ marginLeft: 6 }}
              >
                <ClearIcon />
                Clear
              </button>
            )}
          </div>
        )}

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

      {/* Crop region modal */}
      {cropModalOpen && videoRef.current && videoRef.current.videoWidth > 0 && (
        <CropModal
          video={videoRef.current}
          initial={settings.chatRegion}
          onConfirm={handleCropConfirm}
          onCancel={() => setCropModalOpen(false)}
        />
      )}
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

function CropIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 2 6 6 2 6" />
      <polyline points="18 22 18 18 22 18" />
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
