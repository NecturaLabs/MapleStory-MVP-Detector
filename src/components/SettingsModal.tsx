/**
 * SettingsModal.tsx
 * Full settings modal with sections: CAPTURE, HISTORY, SOUND, DISCORD, EXPERIMENTAL.
 * Tag inputs for keyword lists, toggles, sliders, number inputs.
 */

import React, { useState, useCallback } from 'react';
import useAppStore from '../store/appStore.ts';
import type { AppSettings } from '../utils/persistence.ts';
import { clearAll } from '../services/dbService.ts';
import { testDiscordWebhook, isValidWebhookUrl } from '../services/discordService.ts';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  id,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id: string;
  label: string;
  description?: string;
}) {
  return (
    <div className="settings-row">
      <label htmlFor={id} className="settings-row__label" style={{ cursor: 'pointer' }}>
        {label}
        {description && <div className="settings-row__desc">{description}</div>}
      </label>
      <div className="settings-row__control">
        <label className="toggle" htmlFor={id} aria-label={label}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="toggle__track" />
          <span className="toggle__thumb" />
        </label>
      </div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  id,
  description,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  id: string;
  description?: string;
  suffix?: string;
}) {
  return (
    <div className="settings-row">
      <label htmlFor={id} className="settings-row__label">
        {label}
        {description && <div className="settings-row__desc">{description}</div>}
      </label>
      <div className="settings-row__control">
        <input
          id={id}
          type="number"
          className="form-input form-input--num"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!isNaN(n)) onChange(n);
          }}
          aria-label={label}
        />
        {suffix && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--c-text-3)' }}>{suffix}</span>}
      </div>
    </div>
  );
}

function VolumeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings-row">
      <label htmlFor="sound-volume" className="settings-row__label">Volume</label>
      <div className="settings-row__control">
        <input
          id="sound-volume"
          type="range"
          className="form-range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          aria-label="Sound volume"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={value}
        />
        <span className="form-range-val">{Math.round(value * 100)}%</span>
      </div>
    </div>
  );
}

function TagInput({
  tags,
  onChange,
  placeholder,
  label,
  id,
  description,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  label: string;
  id: string;
  description?: string;
}) {
  const [input, setInput] = useState('');

  const addTag = useCallback(() => {
    const val = input.trim().toLowerCase();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput('');
  }, [input, tags, onChange]);

  const removeTag = (tag: string) => onChange(tags.filter((t) => t !== tag));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="settings-section" style={{ gap: 'var(--sp-2)' }}>
      <label htmlFor={`${id}-input`} className="settings-row__label">
        {label}
        {description && <div className="settings-row__desc">{description}</div>}
      </label>
      <div className="tag-list" role="list" aria-label={`${label} list`}>
        {tags.map((tag) => (
          <span key={tag} className="tag-item" role="listitem">
            {tag}
            <button
              className="tag-item__remove"
              onClick={() => removeTag(tag)}
              aria-label={`Remove ${tag}`}
              title={`Remove "${tag}"`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          id={`${id}-input`}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Type and press Enter…'}
          aria-label={`Add ${label}`}
        />
        <button className="btn btn--ghost btn--sm" onClick={addTag} aria-label={`Add tag to ${label}`}>
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export default function SettingsModal() {
  const isOpen       = useAppStore((s) => s.isSettingsOpen);
  const setOpen      = useAppStore((s) => s.setSettingsOpen);
  const settings     = useAppStore((s) => s.settings);
  const update       = useAppStore((s) => s.updateSettings);
  const resetAll     = useAppStore((s) => s.resetSettings);

  const [clearingDb, setClearingDb] = useState(false);
  const [discordTesting, setDiscordTesting] = useState(false);
  const [discordTestResult, setDiscordTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (!isOpen) return null;

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    update({ [key]: value } as Partial<AppSettings>);

  const handleClearHistory = async () => {
    setClearingDb(true);
    try {
      await clearAll();
    } finally {
      setClearingDb(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset all settings to defaults?')) resetAll();
  };

  const handleClose = () => setOpen(false);

  const handleDiscordTest = async () => {
    setDiscordTestResult(null);
    setDiscordTesting(true);
    try {
      const err = await testDiscordWebhook(settings.discordWebhookUrl);
      setDiscordTestResult(err ? { ok: false, msg: err } : { ok: true, msg: 'Message sent successfully!' });
    } finally {
      setDiscordTesting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="modal" role="document">
        {/* Header */}
        <div className="modal__header">
          <h2 id="settings-title" className="modal__title">Settings</h2>
          <button
            className="btn-icon"
            onClick={handleClose}
            aria-label="Close settings"
            title="Close"
            autoFocus
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="modal__body">

          {/* ── CAPTURE ── */}
          <section className="settings-section" aria-labelledby="s-capture">
            <h3 id="s-capture" className="settings-section__title">Capture</h3>

            <NumberInput
              id="polling-interval"
              label="Polling Interval"
              description="How often to OCR the chat region (ms)"
              value={settings.pollingInterval}
              onChange={(v) => set('pollingInterval', Math.max(500, v))}
              min={500}
              max={10000}
              step={500}
              suffix="ms"
            />
          </section>

          {/* ── HISTORY ── */}
          <section className="settings-section" aria-labelledby="s-history">
            <h3 id="s-history" className="settings-section__title">History</h3>

            <NumberInput
              id="max-messages"
              label="Max Messages"
              description="Maximum lines kept in console and IndexedDB"
              value={settings.maxMessages}
              onChange={(v) => set('maxMessages', Math.max(10, v))}
              min={10}
              max={5000}
            />

            <Toggle
              id="auto-cleanup"
              label="Auto-cleanup"
              description="Automatically trim old messages when limit is reached"
              checked={settings.autoCleanup}
              onChange={(v) => set('autoCleanup', v)}
            />

            <div className="settings-row">
              <span className="settings-row__label">
                Clear History
                <div className="settings-row__desc">Delete all messages from IndexedDB</div>
              </span>
              <div className="settings-row__control">
                <button
                  className="btn btn--danger btn--sm"
                  onClick={handleClearHistory}
                  disabled={clearingDb}
                  aria-label="Clear all stored message history"
                >
                  {clearingDb ? 'Clearing…' : 'Clear'}
                </button>
              </div>
            </div>
          </section>

          {/* ── SOUND ── */}
          <section className="settings-section" aria-labelledby="s-sound">
            <h3 id="s-sound" className="settings-section__title">Sound</h3>

            <Toggle
              id="sound-enabled"
              label="Sound Alerts"
              description="Play a ping when a new MVP is detected"
              checked={settings.soundEnabled}
              onChange={(v) => set('soundEnabled', v)}
            />

            <VolumeSlider
              value={settings.soundVolume}
              onChange={(v) => set('soundVolume', v)}
            />

            <div className="settings-row">
              <label htmlFor="sound-tone" className="settings-row__label">Tone</label>
              <div className="settings-row__control">
                <select
                  id="sound-tone"
                  className="form-select"
                  value={settings.soundTone}
                  onChange={(e) => set('soundTone', e.target.value as OscillatorType)}
                  aria-label="Sound tone type"
                >
                  <option value="sine">Sine</option>
                  <option value="triangle">Triangle</option>
                  <option value="square">Square</option>
                  <option value="sawtooth">Sawtooth</option>
                </select>
              </div>
            </div>
          </section>

          {/* ── DISCORD ── */}
          <section className="settings-section" aria-labelledby="s-discord">
            <h3 id="s-discord" className="settings-section__title">Discord Notifications</h3>

            <Toggle
              id="discord-enabled"
              label="Discord Alerts"
              description="Post new MVP detections to a Discord channel via webhook"
              checked={settings.discordEnabled}
              onChange={(v) => set('discordEnabled', v)}
            />

            <div className="settings-section" style={{ gap: 'var(--sp-2)' }}>
              <label htmlFor="discord-webhook-url" className="settings-row__label">
                Webhook URL
                <div className="settings-row__desc">
                  Discord channel → Edit Channel → Integrations → Webhooks → Copy URL
                </div>
              </label>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                <input
                  id="discord-webhook-url"
                  type="url"
                  className="form-input"
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}
                  value={settings.discordWebhookUrl}
                  onChange={(e) => {
                    set('discordWebhookUrl', e.target.value);
                    setDiscordTestResult(null);
                  }}
                  placeholder="https://discord.com/api/webhooks/…"
                  aria-label="Discord webhook URL"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={handleDiscordTest}
                  disabled={discordTesting || !isValidWebhookUrl(settings.discordWebhookUrl)}
                  aria-label="Test Discord webhook"
                  title={
                    isValidWebhookUrl(settings.discordWebhookUrl)
                      ? 'Send a test message to this webhook'
                      : 'Enter a valid Discord webhook URL first'
                  }
                >
                  {discordTesting ? 'Sending…' : 'Test'}
                </button>
              </div>
              {discordTestResult && (
                <div
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: discordTestResult.ok ? 'var(--c-green)' : 'var(--c-red)',
                    marginTop: 'var(--sp-1)',
                  }}
                  role="status"
                  aria-live="polite"
                >
              {discordTestResult.ok ? '✓ ' : '✗ '}{discordTestResult.msg}
                </div>
              )}
            </div>

            <div className="settings-section" style={{ gap: 'var(--sp-2)' }}>
              <label htmlFor="discord-role-id" className="settings-row__label">
                Role ID (optional)
                <div className="settings-row__desc">
                  Mention a role when MVP is detected. Right-click role → Copy Role ID.
                </div>
              </label>
              <input
                id="discord-role-id"
                type="text"
                className="form-input"
                style={{ fontFamily: 'monospace', fontSize: 'var(--text-xs)' }}
                value={settings.discordRoleId}
                onChange={(e) => set('discordRoleId', e.target.value.replace(/\D/g, ''))}
                placeholder="e.g. 123456789012345678"
                aria-label="Discord role ID for mentions"
                spellCheck={false}
                autoComplete="off"
                inputMode="numeric"
                pattern="\d*"
              />
            </div>
          </section>

          {/* ── EXPERIMENTAL ── */}
          <section className="settings-section" aria-labelledby="s-experimental">
            <h3 id="s-experimental" className="settings-section__title">Experimental</h3>

            <Toggle
              id="vlm-enabled"
              label="Vision Language Model (VLM)"
              description="Use an on-device AI model to verify and correct OCR results. Downloads ~800MB model on first enable. Requires WebGPU for best performance."
              checked={settings.vlmEnabled}
              onChange={(v) => set('vlmEnabled', v)}
            />
          </section>

        </div>

        {/* Footer */}
        <div className="modal__footer">
          <button className="btn btn--danger btn--sm" onClick={handleReset}>
            Reset Defaults
          </button>
          <button className="btn btn--primary" onClick={handleClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
