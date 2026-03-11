/**
 * OnboardingOverlay.tsx
 * Multi-step first-time setup guide displayed on first visit.
 * Shows only if hasCompletedOnboarding is false.
 */

import React, { useState } from 'react';
import useAppStore from '../store/appStore.ts';

interface Step {
  icon: string;
  label: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    icon: '🍁',
    label: 'Welcome',
    title: 'Welcome to MVP Detector',
    body: (
      <>
        Automatically detects <strong>MVP announcements</strong> in MapleStory's chat box using
        real-time OCR. Never miss a free MVP coupon again.
      </>
    ),
  },
  {
    icon: '⏱️',
    label: 'Timestamps',
    title: 'Enable chat timestamps',
    body: (
      <>
        This tool requires <strong>chat timestamps</strong> to be enabled in MapleStory.
        Go to <strong>Options &gt; Community &gt; Chat Timestamps</strong> and make sure
        it is turned on. Without timestamps, messages cannot be parsed or detected.
      </>
    ),
  },
  {
    icon: '🖥️',
    label: 'Capture',
    title: 'Pick your game window',
    body: (
      <>
        Click <strong>Pick Window</strong> and select your <strong>MapleStory window</strong>{' '}
        from the browser's screen picker. Only window capture is needed — no full-screen required.
      </>
    ),
  },
  {
    icon: '✏️',
    label: 'Region',
    title: 'Draw the chat region',
    body: (
      <>
        Click <strong>Draw Region</strong> to open the region overlay. Drag over your{' '}
        <strong>chat box area</strong> in the live preview. The gold selection marks exactly
        what gets OCR'd every 2 seconds.
      </>
    ),
  },
  {
    icon: '🔔',
    label: 'Ready',
    title: "You're all set!",
    body: (
      <>
        MVP announcements will appear highlighted in the console with channel, time, and location
        badges. A <strong>ping sound</strong> plays on new (not-yet-seen) MVPs. Use{' '}
        <strong>Settings</strong> to tune keywords, sound, and more.
      </>
    ),
  },
];

export default function OnboardingOverlay() {
  const hasCompleted     = useAppStore((s) => s.hasCompletedOnboarding);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);

  if (hasCompleted) return null;

  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      completeOnboarding();
    } else {
      setStep((s) => s + 1);
    }
  };

  const handleSkip = () => completeOnboarding();

  return (
    <div
      className="onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-body"
    >
      <div className="onboarding-card">
        <div className="onboarding-card__icon" aria-hidden="true">
          {current.icon}
        </div>

        <span className="onboarding-card__step">
          Step {step + 1} of {STEPS.length} — {current.label}
        </span>

        <h1 id="onboarding-title" className="onboarding-card__title">
          {current.title}
        </h1>

        <p id="onboarding-body" className="onboarding-card__body">
          {current.body}
        </p>

        {/* Progress dots */}
        <div className="onboarding-dots" role="tablist" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === step}
              aria-label={`Step ${i + 1}: ${s.label}`}
              className={`onboarding-dot${i === step ? ' is-active' : ''}`}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="onboarding-card__actions">
          {!isLast && (
            <button className="btn btn--ghost btn--sm" onClick={handleSkip}>
              Skip
            </button>
          )}
          <button className="btn btn--primary btn--lg" onClick={handleNext} autoFocus>
            {isLast ? 'Get Started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
