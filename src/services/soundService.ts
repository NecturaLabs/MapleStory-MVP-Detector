/**
 * soundService.ts
 * Web Audio API tone generator. No audio files (no licensing concerns).
 * Plays a short A5 (880 Hz) ping on new MVP matches.
 */

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

interface PingOptions {
  volume?: number;
  tone?: OscillatorType;
  frequency?: number;
  duration?: number;
}

/**
 * Play a short ping tone.
 * @param options.volume  - 0.0–1.0 (default 0.5)
 * @param options.tone    - oscillator type (default 'sine')
 * @param options.frequency - Hz (default 880, A5)
 * @param options.duration  - ms (default 300)
 */
export function playPing({ volume = 0.5, tone = 'sine', frequency = 880, duration = 300 }: PingOptions = {}): void {
  try {
    const ctx = getContext();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = tone;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    // Exponential fade-out: avoids click artifacts
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration / 1000);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration / 1000);
  } catch (err) {
    // Sound errors are non-fatal — silently ignore
    console.warn('[soundService] playPing failed:', err);
  }
}
