/**
 * persistence.ts
 * localStorage helpers for settings, onboarding, and MVP dedup codes.
 *
 * Keys:
 *   msmvp_settings   — settings object (JSON)
 *   msmvp_onboarded  — boolean first-visit flag
 *   msmvp_mvp_codes  — [{ code, capturedAt }] — dedup list, 30-min expiry
 */

export interface AppSettings {
  pollingInterval: number;
  useMultiFilter: boolean;
  useUpscale: boolean;
  searchKeywords: string[];
  exclusionKeywords: string[];
  replacementKeywords: string[];
  maxChannel: number;
  minConfidence: number;
  maxMessages: number;
  autoCleanup: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  soundTone: OscillatorType;
  // Console display
  showMvpOnly: boolean;
  // Discord webhook notifications
  discordEnabled: boolean;
  discordWebhookUrl: string;
  discordRoleId: string;
  // Experimental
  vlmEnabled: boolean;
}

interface MvpCode {
  code: string;
  capturedAt: number;
}

const KEYS = {
  settings: 'msmvp_settings',
  onboarded: 'msmvp_onboarded',
  mvpCodes: 'msmvp_mvp_codes',
} as const;

const MVP_CODE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  pollingInterval: 2000,
  useMultiFilter: true,
  useUpscale: true,
  searchKeywords: ['mvp', 'alicias blessing', 'certified wellness tonic'],
  exclusionKeywords: ['superpower', 'exp coupon', 'any mvp', 'pls mvp', 'plz mvp', 'please mvp'],
  replacementKeywords: ['mvp red', 'be mvp', 'x1 coupon', 'effect x1'],
  maxChannel: 40,
  minConfidence: 30,
  maxMessages: 500,
  autoCleanup: true,
  soundEnabled: true,
  soundVolume: 0.5,
  soundTone: 'sine',
  showMvpOnly: false,
  discordEnabled: false,
  discordWebhookUrl: '',
  discordRoleId: '',
  vlmEnabled: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEYS.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as AppSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export function hasCompletedOnboarding(): boolean {
  return localStorage.getItem(KEYS.onboarded) === 'true';
}

export function setOnboardingComplete(): void {
  localStorage.setItem(KEYS.onboarded, 'true');
}

export function resetOnboarding(): void {
  localStorage.removeItem(KEYS.onboarded);
}

// ---------------------------------------------------------------------------
// MVP dedup codes
// ---------------------------------------------------------------------------

function loadMvpCodes(): MvpCode[] {
  try {
    const raw = localStorage.getItem(KEYS.mvpCodes);
    return raw ? (JSON.parse(raw) as MvpCode[]) : [];
  } catch {
    return [];
  }
}

function saveMvpCodes(codes: MvpCode[]): void {
  localStorage.setItem(KEYS.mvpCodes, JSON.stringify(codes));
}

function purgeStaleCodes(codes: MvpCode[]): MvpCode[] {
  const cutoff = Date.now() - MVP_CODE_EXPIRY_MS;
  return codes.filter((c) => c.capturedAt > cutoff);
}

/**
 * Check if a dedup key is NEW (not seen in the past 30 minutes).
 * If new, adds it to the list and returns true.
 */
export function isNewMvp(dedupKey: string): boolean {
  let codes = purgeStaleCodes(loadMvpCodes());

  if (codes.some((c) => c.code === dedupKey)) {
    saveMvpCodes(codes); // persist purged list
    return false;
  }

  codes.push({ code: dedupKey, capturedAt: Date.now() });
  saveMvpCodes(codes);
  return true;
}

/**
 * Clear all MVP dedup codes (called when user clicks "Clear" in console).
 */
export function clearMvpCodes(): void {
  localStorage.removeItem(KEYS.mvpCodes);
}
