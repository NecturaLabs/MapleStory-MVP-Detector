/**
 * chatParserService.test.ts
 * Port of MvpProcessor.Tests/MessageProcessingTests.cs
 *
 * Covers:
 *  - EnsureTestMessagesAreProcessedCorrectly       → isValid correctness
 *  - EnsureMvpAnnouncementsCanBeExtractedFromTestMessages → combineLines → analyzeMvp pipeline
 *  - EnsureMapNamesCanBeExtractedFromTestMessages   → location extraction
 *  - EnsureTimeSpecificationsCanBeExtractedFromTestMessages → willBeUsedAt calculation
 */

import { describe, it, expect } from 'vitest';
import { analyzeMvp, combineLines } from './chatParserService.ts';
import type { AppSettings } from '../utils/persistence.ts';

// ---------------------------------------------------------------------------
// Settings matching appsettings.json / DEFAULT_SETTINGS
// ---------------------------------------------------------------------------
const SETTINGS: AppSettings = {
  pollingInterval: 2000,
  useMultiFilter: true,
  useUpscale: true,
  searchKeywords: ['mvp', 'alicias blessing', 'certified wellness tonic'],
  exclusionKeywords: ['superpower', 'exp coupon', 'any mvp', 'pls mvp', 'plz mvp', 'please mvp'],
  replacementKeywords: ['mvp red', 'be mvp', 'x1 coupon', 'effect x1'],
  maxChannel: 40,
  minConfidence: 30,
  maxMessages: 100,
  autoCleanup: true,
  soundEnabled: true,
  soundVolume: 0.5,
  soundTone: 'sine',
  discordEnabled: false,
  discordWebhookUrl: '',
  discordRoleId: '',
  vlmEnabled: false,
  showMvpOnly: false,
};

// ---------------------------------------------------------------------------
// Test data — direct port of _testMessages
// ---------------------------------------------------------------------------
const TEST_MESSAGES: Array<{ message: string; expected: boolean }> = [
  // Not MVP announcements
  { message: 'meow', expected: false },
  { message: '[10:42] meow', expected: false },
  { message: '[10:42] MVP', expected: false },
  { message: '[10:42] MVP[10:42][10:42]', expected: false },
  { message: '[10:42] MVP hustino22 is ksing me now..', expected: false },
  { message: '[10:42] [Dea Sidus Earring] Any MVP soon??', expected: false },
  { message: '[10:42] Any MVP pls ?2?@???!!!', expected: false },
  { message: '[10:42] where tf is my mvp ?????', expected: false },
  { message: '[10:42] i spy with my little eyes, an mvp soon', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x5', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 5x', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : mvps? 0.0', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : mvps? 0,0', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : mvps? 0:0', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : mvps? 0;0', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45 x', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x 45', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 12:x', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 5x[10:42] <Medal> PlayerName [CH.X] : MVP 5x[10:42] <Medal> PlayerName [CH.X] : MVP 5x', expected: false },
  // Valid MVP announcements
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP ch5', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx:5', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45x', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x45', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx45', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45xx', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx 45', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45 xx', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 12:xx', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x:12', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx:12', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] ch5', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] xx:5', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] MVP CH9 xx:29', expected: true },
  { message: '[00:07] <Wonderful Pet Owner> limfaoow [ch.10] : [MVP 50% Bonus EXP Atmospheric Effect] ms10 xx10', expected: true },
  { message: '[10:42] <*Mayple Island*> Hypothesis0 [ch.06] : [MVP 50% Bonus EXP Atmospheric Effect] MS cc6 XX45', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] CH9 xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 MVP bing bing dong asdasd', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP chn 22 at xx08', expected: true },
];

// ---------------------------------------------------------------------------
// Test data — direct port of _testMessagesWithMapNames
// ---------------------------------------------------------------------------
const TEST_MESSAGES_WITH_MAP_NAMES: Array<{ message: string; expected: boolean }> = [
  // No location
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP ch5', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx:5', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45x', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x45', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx45', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45xx', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx 45', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 45 xx', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 12:xx', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP x:12', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP xx:12', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] ch5', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] xx:5', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : [MVP 50% Bonus EXP Atmospheric Effect] MVP CH9 xx:29', expected: false },
  { message: '[10:42] <Medal> PlayerName [CH.X] : MVP 5x[10:42] <Medal> PlayerName [CH.X] : MVP 5x[10:42] <Medal> PlayerName [CH.X] : MVP 5x', expected: false },
  // Has location
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 xx:29 MVP MS', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 MS xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : CH9 hene xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : HENESYS CH9 xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : zak CH9 xx:29 MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : xx:29 mshrine MVP', expected: true },
  { message: '[10:42] <Medal> PlayerName [CH.X] : xx:29 omega sector MVP', expected: true },
];

// ---------------------------------------------------------------------------
// Test data — direct port of _testMessagesWithTimeSpecifications
//
// C# builds expected times as:
//   [23:14] MVP 3x15  → postedAt = today 23:14 UTC, targetMinute = 15
//                       postedAt.Minute (14) < targetMinute (15) → same hour
//                       willBeUsedAt = today 23:15 UTC
//
//   [23:54] MVP xx5   → postedAt = today 23:54 UTC, targetMinute = 5
//                       postedAt.Minute (54) > targetMinute (5) → next hour
//                       willBeUsedAt = tomorrow 00:05 UTC
//
// We replicate the same calculation here so the expected value matches
// what parseTimestamp + extractChannelAndTime produce.
// ---------------------------------------------------------------------------
function buildExpectedTime(hour: number, minute: number, targetMinute: number): Date {
  const now = new Date();
  const postedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
  const base = new Date(postedAt);
  base.setUTCSeconds(0, 0);
  if (postedAt.getUTCMinutes() > targetMinute) {
    const minutesUntilNextHour = 60 - postedAt.getUTCMinutes();
    base.setUTCMinutes(base.getUTCMinutes() + minutesUntilNextHour + targetMinute);
  } else {
    base.setUTCMinutes(base.getUTCMinutes() + (targetMinute - postedAt.getUTCMinutes()));
  }
  return base;
}

const TEST_MESSAGES_WITH_TIME: Array<{ message: string; expectedTime: Date }> = [
  // [23:14] MVP 3x15 → postedAt.Minute=14 < 15 → today 23:15 UTC
  {
    message: "[23:14] <THE BLACK= Birninmoon 'ava : MVP 3x15 MS ch 10",
    expectedTime: buildExpectedTime(23, 14, 15),
  },
  // [23:54] MVP xx5 → postedAt.Minute=54 > 5 → next hour: tomorrow 00:05 UTC
  {
    message: "[23:54] <THE BLACK= Birninmoon 'ava : MVP xx5 MS ch 10",
    expectedTime: buildExpectedTime(23, 54, 5),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Thin wrapper — same signature as C# GetMvpAnnouncementDetails(new ChatMessage(text)) */
function getDetails(message: string) {
  return analyzeMvp(message, SETTINGS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnsureTestMessagesAreProcessedCorrectly', () => {
  for (const { message, expected } of TEST_MESSAGES) {
    it(`isValid=${expected} — ${message}`, () => {
      expect(getDetails(message).isValid).toBe(expected);
    });
  }
});

describe('EnsureMvpAnnouncementsCanBeExtractedFromTestMessages', () => {
  // Port of: take MVP-positive messages, run through combineLines, then analyzeMvp
  const mvpMessages = TEST_MESSAGES.filter((m) => m.expected).map((m) => m.message);

  it('all MVP-positive messages survive combineLines → analyzeMvp pipeline', () => {
    const ocrLines = mvpMessages.map((text) => ({ text, confidence: 95 }));
    const combined = combineLines(ocrLines, SETTINGS);
    for (const msg of combined) {
      const result = getDetails(msg.text);
      expect(result.isValid, `pipeline failed for: ${msg.text}`).toBe(true);
    }
  });
});

describe('EnsureMapNamesCanBeExtractedFromTestMessages', () => {
  for (const { message, expected } of TEST_MESSAGES_WITH_MAP_NAMES) {
    it(`hasLocation=${expected} — ${message}`, () => {
      const result = getDetails(message);
      expect(result.location !== null).toBe(expected);
    });
  }
});

describe('EnsureTimeSpecificationsCanBeExtractedFromTestMessages', () => {
  for (const { message, expectedTime } of TEST_MESSAGES_WITH_TIME) {
    it(`willBeUsedAt=${expectedTime.toISOString()} — ${message}`, () => {
      const result = getDetails(message);
      expect(result.willBeUsedAt, `no time extracted from: ${message}`).not.toBeNull();
      // Compare to the minute — seconds/ms are zeroed in both C# and TS
      expect(result.willBeUsedAt!.getTime()).toBe(expectedTime.getTime());
    });
  }
});
