/**
 * ConsolePanel.tsx
 * Real-time scrolling log of all OCR'd chat lines.
 * - 3-tier row styles: dim / known-mvp / new-mvp
 * - Badges: Ch · Time · Loc · NEW
 * - Auto-scrolls to bottom; pauses when user scrolls up
 * - Clear button wipes console + MVP dedup codes
 * - Lines sorted chronologically by in-game [HH:MM] timestamp
 * - Download Debug Log button
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import useAppStore from '../store/appStore.ts';
import type { ConsoleLine } from '../store/appStore.ts';

function formatUsedAt(ms: number): string {
  if (ms === 0) return 'now';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface RowProps {
  line: ConsoleLine;
}

const ConsoleRow = React.memo(function ConsoleRow({ line }: RowProps) {
  const { text, isMvpMatch, isNewMvp: isNew, details } = line;

  const rowClass = isNew
    ? 'console-row console-row--mvp-new'
    : isMvpMatch
      ? 'console-row console-row--mvp-known'
      : 'console-row console-row--dim';

  const vlmBadge = line.vlmStatus === 'processing'
    ? <span className="badge badge--vlm-processing" title="VLM is verifying this message">Verifying</span>
    : line.vlmStatus === 'pending'
      ? <span className="badge badge--vlm-pending" title="Waiting for VLM verification">Pending</span>
      : (!line.vlmStatus && line.source === 'onnx')
        ? <span className="badge badge--ai" title="Verified by AI">Verified</span>
        : null;

  return (
    <div className={rowClass} role="listitem">
      <div className="console-row__body">
        <div className="console-row__main">
          {vlmBadge}
          <span className="console-row__text">{text}</span>
        </div>

        {isMvpMatch && details && (
          <div className="console-row__badges" role="group" aria-label="Message details">
            {isNew && (
              <span className="badge badge--new" aria-label="New MVP">
                NEW
              </span>
            )}

            {details.channel !== null && (
              <span className="badge badge--ch" aria-label={`Channel ${details.channel}`}>
                Ch {details.channel}
              </span>
            )}

            {details.willBeUsedAt !== null && (
              details.willBeUsedAt === 0 ? (
                <span className="badge badge--now" aria-label="Available now">
                  NOW
                </span>
              ) : (
                <span className="badge badge--time" aria-label={`Available at ${formatUsedAt(details.willBeUsedAt)}`}>
                  :{String(new Date(details.willBeUsedAt).getMinutes()).padStart(2, '0')}
                </span>
              )
            )}

            {details.location && (
              <span className="badge badge--loc" aria-label={`Location: ${details.location.mapName}`}>
                {details.location.mapName}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default function ConsolePanel() {
  const consoleLines  = useAppStore((s) => s.consoleLines);
  const isPaused      = useAppStore((s) => s.isPaused);
  const setPaused     = useAppStore((s) => s.setPaused);
  const clearConsole  = useAppStore((s) => s.clearConsole);
  const currentFilter = useAppStore((s) => s.currentFilter);
  const isCapturing   = useAppStore((s) => s.isCapturing);
  const showMvpOnly   = useAppStore((s) => s.settings.showMvpOnly);
  const lineCount = useAppStore((s) => s.consoleLines.length);
  const downloadChatLog = useAppStore((s) => s.downloadChatLog);

  const bodyRef       = useRef<HTMLDivElement>(null);
  const atBottomRef   = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Auto-scroll to bottom when new lines arrive, unless paused
  // Store maintains chronological order via sorted insert in addConsoleLine.
  useEffect(() => {
    if (!isPaused && atBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [consoleLines, isPaused]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 40;
    atBottomRef.current = atBottom;

    if (!atBottom && !isPaused) {
      setPaused(true);
      setShowScrollBtn(true);
    } else if (atBottom && isPaused) {
      setPaused(false);
      setShowScrollBtn(false);
    }
  }, [isPaused, setPaused]);

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPaused(false);
    setShowScrollBtn(false);
    atBottomRef.current = true;
  }, [setPaused]);

  return (
    <section className="console-panel" aria-label="Chat OCR console">
      {/* Toolbar */}
      <div className="console-toolbar">
        <span className="console-toolbar__label">
          Console
          {isPaused && (
            <span
              style={{ marginLeft: 'var(--sp-2)', color: 'var(--c-gold)', fontWeight: 600 }}
              aria-live="polite"
            >
              · Paused
            </span>
          )}
        </span>

        {isCapturing && currentFilter && (
          <span className={`filter-pill filter-pill--${currentFilter}`} aria-label={`Using filter ${currentFilter.toUpperCase()}`}>
            {currentFilter.toUpperCase()}
          </span>
        )}

        <button
          className="btn btn--ghost btn--sm"
          onClick={() => downloadChatLog()}
          disabled={lineCount === 0}
          aria-label={`Download chat log (${lineCount} messages)`}
          title="Download chat messages as text file"
        >
          Export ({lineCount})
        </button>

        <button
          className="btn btn--ghost btn--sm"
          onClick={clearConsole}
          aria-label="Clear console and reset MVP dedup"
          title="Clear all lines and reset MVP deduplication"
        >
          Clear
        </button>
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        className="console-body"
        onScroll={handleScroll}
        role="list"
        aria-label="OCR output lines"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
      >
        {consoleLines.length === 0 ? (
          <div className="console-empty" role="status" aria-label="No lines yet">
            <span className="console-empty__icon" aria-hidden="true">📋</span>
            <span className="console-empty__text">
              No lines yet. Start capture and draw the chat region to begin.
            </span>
          </div>
        ) : (
          consoleLines
            .filter((line) => !line.onnxRejected && (!showMvpOnly || line.isMvpMatch))
            .map((line, i) => (
              <ConsoleRow key={line.id ?? `${line.capturedAt}-${i}`} line={line} />
            ))
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollBtn && (
        <button
          className="btn btn--ghost btn--sm"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom and resume auto-scroll"
          style={{
            position: 'absolute',
            bottom: 'calc(var(--status-h) + var(--sp-4))',
            right: 'var(--sp-4)',
            zIndex: 20,
            background: 'var(--c-surface-3)',
            border: '1px solid var(--c-border-2)',
            borderRadius: 'var(--r-md)',
            padding: 'var(--sp-2) var(--sp-4)',
            boxShadow: '0 4px 16px #00000060',
          }}
        >
          ↓ Resume
        </button>
      )}
    </section>
  );
}
