/**
 * Header.tsx
 * App header: branding left, actions right (settings, help/onboarding).
 */

import React from 'react';
import useAppStore from '../store/appStore.ts';

export default function Header() {
  const setSettingsOpen  = useAppStore((s) => s.setSettingsOpen);
  const showOnboarding   = useAppStore((s) => s.showOnboarding);
  const matchCount       = useAppStore((s) => s.matchCount);

  return (
    <header className="header" role="banner">
      <div className="header__brand">
        <img
          src="/mvp.png"
          alt="MVP Detector logo"
          className="header__logo"
          width={32}
          height={32}
        />
        <div className="header__titles">
          <span className="header__name">MVP Detector</span>
          <span className="header__sub">MapleStory · Real-time chat OCR</span>
        </div>

        {matchCount > 0 && (
          <span
            className="badge badge--new"
            aria-label={`${matchCount} MVP match${matchCount !== 1 ? 'es' : ''} found`}
            style={{ marginLeft: 'var(--sp-3)', fontSize: 'var(--text-xs)' }}
          >
            {matchCount} MVP{matchCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="header__actions">
        <button
          className="btn-icon"
          onClick={showOnboarding}
          title="Show setup guide"
          aria-label="Show setup guide"
        >
          {/* Help / question mark icon */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
          </svg>
        </button>

        <button
          className="btn-icon"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Open settings"
        >
          {/* Gear icon */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
