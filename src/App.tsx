/**
 * App.tsx
 * Root layout shell: header + main body (capture panel + console panel) + status bar.
 * Mounts all overlays (onboarding, settings modal).
 */

import React, { useEffect } from 'react';
import Header from './components/Header.tsx';
import StatusBar from './components/StatusBar.tsx';
import CapturePanel from './components/CapturePanel.tsx';
import ConsolePanel from './components/ConsolePanel.tsx';
import SettingsModal from './components/SettingsModal.tsx';
import OnboardingOverlay from './components/OnboardingOverlay.tsx';
import { scheduleVlmCropExport } from './hooks/useOcr.ts';

export default function App() {
  // Ctrl+Shift+V: save the next VLM crop as a PNG download for debugging.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'V') scheduleVlmCropExport();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="app">
      {/* Top bar */}
      <Header />

      {/* Main split: capture panel (left) + console (right) */}
      <main className="main-body" role="main">
        <CapturePanel />
        <ConsolePanel />
      </main>

      {/* Bottom status bar */}
      <StatusBar />

      {/* Floating overlays */}
      <SettingsModal />
      <OnboardingOverlay />
    </div>
  );
}
