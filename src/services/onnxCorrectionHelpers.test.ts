import { describe, it, expect } from 'vitest';
import {
  parseCorrectionOutput,
  VLM_USER_INSTRUCTION,
} from './onnxCorrectionHelpers.ts';

describe('parseCorrectionOutput', () => {
  it('splits output into OcrLine array with confidence 50', () => {
    const result = parseCorrectionOutput('[10:27] MVP ch3\n[10:28] MVP ch5');
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('[10:27] MVP ch3');
    expect(result[1].text).toBe('[10:28] MVP ch5');
    expect(result[0].confidence).toBe(50);
    expect(result[1].confidence).toBe(50);
  });

  it('filters blank lines from VLM output', () => {
    const result = parseCorrectionOutput('[10:27] MVP ch3\n\n\n[10:28] MVP ch5\n');
    expect(result).toHaveLength(2);
  });

  it('returns empty array for blank output', () => {
    expect(parseCorrectionOutput('')).toHaveLength(0);
    expect(parseCorrectionOutput('   \n  ')).toHaveLength(0);
  });

  it('trims whitespace from each line', () => {
    const result = parseCorrectionOutput('  [10:27] MVP ch3  ');
    expect(result[0].text).toBe('[10:27] MVP ch3');
  });

  it('handles single line without newline', () => {
    const result = parseCorrectionOutput('[16:34] <THE BLACK> Beek: MVP - CC 38 Zak');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('[16:34] <THE BLACK> Beek: MVP - CC 38 Zak');
    expect(result[0].confidence).toBe(50);
  });

  it('passes through non-timestamped lines (caller filters downstream)', () => {
    const result = parseCorrectionOutput('some prose without a timestamp\n[10:27] MVP ch3');
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('some prose without a timestamp');
    expect(result[1].text).toBe('[10:27] MVP ch3');
  });

  it('handles MapleStory MVP announcement format', () => {
    const raw =
      '[00:33] <THE BLACK> Haytato: [MVP 70% Bonus EXP Atmospheric Effect] cc22 MS 035\n' +
      '[01:01] Maestro obtained Key to Love x10 from the Atelier Reliquary.';
    const result = parseCorrectionOutput(raw);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('MVP');
    expect(result[1].text).toContain('Reliquary');
  });
});

describe('VLM_USER_INSTRUCTION', () => {
  it('is a non-empty string mentioning [HH:MM]', () => {
    expect(typeof VLM_USER_INSTRUCTION).toBe('string');
    expect(VLM_USER_INSTRUCTION.length).toBeGreaterThan(0);
    expect(VLM_USER_INSTRUCTION).toContain('[HH:MM]');
  });
});
