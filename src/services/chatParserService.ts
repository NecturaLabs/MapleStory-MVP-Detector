/**
 * chatParserService.ts
 * Port of ChatMessageService.cs + MapService.cs + StringExtensions.cs.
 * Combines OCR lines, detects MVP announcements, extracts channel/time/location.
 */

import {
  TIMESTAMP,
  CHANNEL_1,
  CHANNEL_2,
  TIME,
  SPECIAL_TIME,
  VERBAL_TIME,
  MVP_PROBABLE,
  MAP_DICTIONARY,
  cloneRegex,
} from '../utils/regexPatterns.ts';
import type { OcrLine } from './ocrService.ts';
import type { LocationMatch } from './dbService.ts';

// ---------------------------------------------------------------------------
// Pipeline constants (not user-configurable — no UI controls)
// ---------------------------------------------------------------------------

const MIN_CONFIDENCE = 30;
const MAX_CHANNEL = 40;
const SEARCH_KEYWORDS = ['mvp', 'alicias blessing', 'certified wellness tonic'] as const;
const EXCLUSION_KEYWORDS = ['superpower', 'exp coupon', 'any mvp', 'pls mvp', 'plz mvp', 'please mvp'] as const;
const REPLACEMENT_KEYWORDS = ['mvp red', 'be mvp', 'x1 coupon', 'effect x1'] as const;

export interface CombinedMessage {
  text: string;
  confidence: number;
  rawTimestamp: string | null;
}

export interface MvpAnalysis {
  isValid: boolean;
  rawTimestamp: string | null;
  fixedText: string;
  channel: number | null;
  willBeUsedAt: Date | null;
  location: LocationMatch | null;
  dedupKey: string | null;
  hasMvpKeyword: boolean;
}

// ---------------------------------------------------------------------------
// stripGuildMedals — remove angle-bracket guild medal content
// ---------------------------------------------------------------------------

/**
 * Strip guild medal brackets: <...>, «...>, <...», «...», and OCR variants.
 * In MapleStory chat, guild medals appear as `<Medal Name>` before the
 * player's IGN.  These can contain MVP (e.g. "<Born to Be MVP Red>")
 * which would otherwise trigger false-positive MVP detection.
 *
 * OCR often misreads the closing `>` as `=`, so we accept both.
 * We require the opening bracket to be `<` or `«` (distinctive enough
 * that OCR rarely misreads them as something else).
 *
 * Only strips content that looks like a guild medal (contains words,
 * not a system message format like "[MVP 70%...]" which uses square brackets).
 */
export function stripGuildMedals(text: string): string {
  // Opening: < «
  // Closing: > » = (OCR variant for >)
  return text.replace(/[<«][^>»=]*[>»=]/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// combineLines — port of CombineMessageLinesIntoMessages
// ---------------------------------------------------------------------------

export function combineLines(ocrLines: OcrLine[]): CombinedMessage[] {
  const minConfidence = MIN_CONFIDENCE;
  const messages: CombinedMessage[] = [];
  let buffer: CombinedMessage | null = null;

  const flushBuffer = () => {
    if (buffer && buffer.text.trim()) {
      messages.push({ ...buffer });
    }
    buffer = null;
  };

  const tsRe = cloneRegex(TIMESTAMP);
  const hasLeadingTimestamp = (line: string): { matched: boolean; rawTimestamp: string | null; cleanedLine: string } => {
    tsRe.lastIndex = 0;
    const m = tsRe.exec(line);
    if (m !== null && m[1] != null) {
      // Allow timestamp at index 0, OR preceded by a small amount of OCR noise
      // (e.g. "J [10:27]..." where J is a border artifact). Accept if the
      // timestamp starts within the first 4 characters.
      if (m.index <= 3) {
        // Strip leading noise before the timestamp for a cleaner message
        const cleanedLine = m.index > 0 ? line.slice(m.index) : line;
        return { matched: true, rawTimestamp: m[1], cleanedLine };
      }
    }
    return { matched: false, rawTimestamp: null, cleanedLine: line };
  };

  for (const ocr of ocrLines) {
    const line = (ocr.text || '').replace(/\n/g, ' ').trim();
    if (!line) continue;

    const hasLeading = hasLeadingTimestamp(line);
    if (hasLeading.matched) {
      // New timestamped message — flush whatever we were building
      if (buffer) flushBuffer();
      buffer = { text: hasLeading.cleanedLine, confidence: ocr.confidence, rawTimestamp: hasLeading.rawTimestamp };
    } else {
      // Continuation line (no leading timestamp)
      if (!buffer) {
        // Orphan line with no preceding timestamp — emit with rawTimestamp=null.
        // Callers that only display timestamped messages will filter these out;
        // MVP analysis still runs on them so no announcement is missed.
        if (ocr.confidence >= minConfidence) {
          messages.push({ text: line, confidence: ocr.confidence, rawTimestamp: null });
        }
        continue;
      }

      // Always append continuation lines to the current message buffer.
      // MVP-specific filtering (channel/time requirements) is handled
      // downstream by analyzeMvp() — combineLines should only combine,
      // not filter.  Skip only if confidence is extremely low (noise) or
      // the fragment is too short to carry meaning (likely OCR artifact, e.g. "ars]").
      const wordChars = line.replace(/[^a-zA-Z0-9]/g, '').length;
      if (ocr.confidence < minConfidence || wordChars < 4) continue;

      buffer.text += ' ' + line;
      buffer.confidence = Math.min(buffer.confidence, ocr.confidence);
    }
  }

  flushBuffer();
  return messages;
}

// ---------------------------------------------------------------------------
// analyzeMvp — port of GetMvpAnnouncementDetails
// ---------------------------------------------------------------------------

export function analyzeMvp(messageText: string): MvpAnalysis {
  const searchKeywords = SEARCH_KEYWORDS;
  const exclusionKeywords = EXCLUSION_KEYWORDS;
  const replacementKeywords = REPLACEMENT_KEYWORDS;

  // Step 1: Extract leading timestamp (C# rejects messages without one)
  const tsRe = cloneRegex(TIMESTAMP);
  tsRe.lastIndex = 0;
  const tsMatch = tsRe.exec(messageText);
  const rawTimestamp = tsMatch && tsMatch.index === 0 ? (tsMatch[1] ?? null) : null;

  // C#: if no valid leading timestamp → return immediately as not-MVP
  if (!rawTimestamp) {
    return { isValid: false, rawTimestamp: null, fixedText: messageText, channel: null, willBeUsedAt: null, location: null, dedupKey: null, hasMvpKeyword: false };
  }

  // Parse postedAt from the raw timestamp (mirrors C# TryGetDateTimeFromTimestamp).
  // Returns null if digits ≠ 4 or out of range — C# returns false and rejects the message.
  const postedAt = parseTimestamp(rawTimestamp);
  if (postedAt === null) {
    return { isValid: false, rawTimestamp, fixedText: messageText, channel: null, willBeUsedAt: null, location: null, dedupKey: null, hasMvpKeyword: false };
  }

  // Step 2: Check exclusion keywords on ORIGINAL text (before stripping timestamps, matching C#)
  const lowerOriginal = messageText.toLowerCase();
  for (const excl of exclusionKeywords) {
    if (lowerOriginal.includes(excl.toLowerCase())) {
      return { isValid: false, rawTimestamp, fixedText: messageText, channel: null, willBeUsedAt: null, location: null, dedupKey: null, hasMvpKeyword: false };
    }
  }

  // Step 3: Strip all TIMESTAMP occurrences from text
  let fixedText = messageText.replace(new RegExp(TIMESTAMP.source, 'g'), ' ').replace(/\s+/g, ' ').trim();

  // Step 4: Normalize MVP variants → "MVP" (before replacement keywords so
  // OCR-garbled forms like "MYP Red" become "MVP Red" and get stripped).
  fixedText = fixedText.replace(cloneRegex(MVP_PROBABLE), 'MVP');

  // Step 5: Strip replacement keywords (e.g. "mvp red", "be mvp")
  for (const repl of replacementKeywords) {
    const re = new RegExp(repl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    fixedText = fixedText.replace(re, '').replace(/\s+/g, ' ').trim();
  }

  // Step 6: Strip guild medal brackets — <...>, «...>, <...», «...=»
  // Guild medals like "<Born to Be MVP Red>" contain MVP in the player's
  // title, not in an MVP announcement.  Remove bracketed content so guild
  // MVP names don't trigger false positives.  Safety net for cases where
  // replacement keywords miss due to OCR garbling.
  fixedText = stripGuildMedals(fixedText);

  // Step 7: Check search keywords (case-insensitive substring, matching C# StringComparison.OrdinalIgnoreCase)
  const lowerFixed2 = fixedText.toLowerCase();
  const hasMvpKeyword = searchKeywords.some((kw) => lowerFixed2.includes(kw.toLowerCase()));

  // Step 8: Extract channel and time — pass postedAt as base (mirrors C# GetMvpChannelAndTime)
  const { channel, willBeUsedAt } = extractChannelAndTime(fixedText, postedAt);

  // Step 9: Get location
  const location = getLocation(fixedText);

  // Step 10: Build dedup key
  const dedupKey = rawTimestamp ? buildDedupKey(rawTimestamp) : null;

  // isValid: must have MVP keyword AND (channel OR time)
  const isValid = hasMvpKeyword && (channel !== null || willBeUsedAt !== null);

  return { isValid, rawTimestamp, fixedText, channel, willBeUsedAt, location, dedupKey, hasMvpKeyword };
}

// ---------------------------------------------------------------------------
// extractChannelAndTime — port of StringExtensions.GetMvpChannelAndTime
// ---------------------------------------------------------------------------

/**
 * Port of StringExtensions.GetMvpChannelAndTime.
 *
 * @param text      Cleaned message text (timestamps + replacement keywords stripped).
 * @param postedAt  The in-game chat timestamp parsed from the message (DateTime postedAt in C#).
 *                  Used as the base for time rollover calculation — NOT wall-clock time.
 * @param settings  App settings (maxChannel).
 */
export function extractChannelAndTime(
  text: string,
  postedAt: Date,
): { channel: number | null; willBeUsedAt: Date | null } {
  const maxChannel = MAX_CHANNEL;

  // --- Channel ---
  let channel: number | null = null;

  const matchChannel = (re: RegExp): number | null => {
    const matches = [...text.matchAll(re)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const digits = matches[i][0].match(/\d+/);
      if (digits) {
        const n = parseInt(digits[0], 10);
        if (n >= 1 && n <= maxChannel) return n;
      }
    }
    return null;
  };

  channel = matchChannel(new RegExp(CHANNEL_1.source, CHANNEL_1.flags));
  if (channel === null) {
    channel = matchChannel(new RegExp(CHANNEL_2.source, CHANNEL_2.flags));
  }

  // --- Time ---
  let willBeUsedAt: Date | null = null;

  /**
   * Extract target minute from a regex match value.
   * C# logic: string.Join("", value.Where(IsNumber)) → int.TryParse → targetMinute.
   * This concatenates ALL digits and parses as a single int.
   * Matching C# exactly — no special-casing by digit count.
   */
  const parseMinutes = (raw: string): number => {
    // C#: string.Join("", value.Where(IsNumber)) → int.TryParse(digits, out var n)
    // If TryParse fails (empty string or non-numeric), n stays at its default value of 0.
    // Matching C# exactly: empty digits → 0, same as int.TryParse default.
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return 0;
    const n = parseInt(digits, 10);
    return isNaN(n) ? 0 : n;
  };

  /**
   * C# uses .LastOrDefault() — just takes the last match, no range filtering.
   */
  const findTimeMatch = (re: RegExp): { minutes: number } | null => {
    const matches = [...text.matchAll(re)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    return { minutes: parseMinutes(last[0]) };
  };

  let timeResult = findTimeMatch(new RegExp(TIME.source, TIME.flags));
  if (timeResult === null) {
    timeResult = findTimeMatch(new RegExp(SPECIAL_TIME.source, SPECIAL_TIME.flags));
  }

  if (timeResult !== null) {
    const matchedMinutes = timeResult.minutes;
    // C# logic: use postedAt as base time, not wall-clock now.
    // If postedAt.Minute > targetMinute → minute already passed this hour, roll to next hour.
    // e.g. postedAt = 09:55, targetMinute = 5 → willBeUsedAt = 10:05
    // Use UTC throughout: parseTimestamp always constructs a UTC date.
    const base = new Date(postedAt);
    base.setUTCSeconds(0, 0);
    if (postedAt.getUTCMinutes() > matchedMinutes) {
      // Roll over to next hour: advance to start of next hour, then add target minutes
      const minutesUntilNextHour = 60 - postedAt.getUTCMinutes();
      base.setUTCMinutes(base.getUTCMinutes() + minutesUntilNextHour + matchedMinutes);
    } else {
      base.setUTCMinutes(base.getUTCMinutes() + (matchedMinutes - postedAt.getUTCMinutes()));
    }
    willBeUsedAt = base;
  } else if (channel !== null) {
    // Only check verbal time if a channel was found (mirrors C# behaviour)
    const vt = new RegExp(VERBAL_TIME.source, VERBAL_TIME.flags);
    if (vt.test(text)) {
      willBeUsedAt = new Date(0); // sentinel: "now/soon" (DateTime.MinValue in C#)
    }
  }

  return { channel, willBeUsedAt };
}

// ---------------------------------------------------------------------------
// getLocation — port of MapService.GetLocation
// ---------------------------------------------------------------------------

/**
 * Port of MapService.GetLocation.
 * C# logic:
 *   1. Quick filter: input.Contains(keyword, OrdinalIgnoreCase)
 *   2. Split keyword into words, check each word is in inputWords (split by space)
 */
export function getLocation(text: string): LocationMatch | null {
  const lower = text.toLowerCase();
  const inputWords = text.split(/\s+/).filter(Boolean);

  for (const [mapName, keywords] of Object.entries(MAP_DICTIONARY)) {
    // C# constructor adds the map name itself to the keywords set
    const allKeywords = [...keywords, mapName];

    for (const kw of allKeywords) {
      if (!kw.trim()) continue;
      // C# quick filter: input.Contains(keyword, OrdinalIgnoreCase)
      if (!lower.includes(kw.toLowerCase())) continue;
      // C# splits keyword into words and checks each word is in inputWords
      const expectedWords = kw.trim().split(/\s+/).filter(Boolean);
      const allFound = expectedWords.every((w) =>
        inputWords.some((iw) => iw.toLowerCase() === w.toLowerCase())
      );
      if (allFound) {
        return { mapName, matchedKeyword: kw };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// parseTimestamp — port of StringExtensions.TryGetDateTimeFromTimestamp
// ---------------------------------------------------------------------------

/**
 * Parse a raw OCR'd chat timestamp string into a UTC Date, matching C#'s
 * TryGetDateTimeFromTimestamp logic exactly:
 *   - Strip all non-digits, require exactly 4 digits → "HHMM"
 *   - Parse as int; reject if NaN or hour > 23 / minute > 59
 *   - Construct a UTC Date for today at HH:MM:00
 *   - Returns null on any failure (mirrors C# returning false — caller must reject the message)
 *
 * rawTimestamp examples: "09:12", "0912", "09.12", "09-12", "2312"
 */
export function parseTimestamp(rawTimestamp: string): Date | null {
  const digits = rawTimestamp.replace(/[^0-9]/g, '');
  if (digits.length !== 4) return null;
  const digitsAsInt = parseInt(digits, 10);
  if (isNaN(digitsAsInt)) return null;
  const hour = Math.floor(digitsAsInt / 100);
  const minute = digitsAsInt % 100;
  if (hour > 23 || minute > 59) return null;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
}

// ---------------------------------------------------------------------------
// buildDedupKey
// ---------------------------------------------------------------------------

/**
 * Build a dedup key from the in-game OCR'd timestamp.
 * Matches C# MvpAnnouncement.MvpCodeFormat: "yyyy-MM-dd_HH_mm"
 * PostedAt is UTC in C# (TryGetDateTimeFromTimestamp uses DateTime.UtcNow),
 * so we use UTC date components here too.
 *
 * rawTimestamp examples: "09:12", "0912", "09.12", "09-12"
 * Returns: "YYYY-MM-DD_HH_mm" e.g. "2026-03-01_09_12"
 */
export function buildDedupKey(rawTimestamp: string): string {
  const digits = rawTimestamp.replace(/[^0-9]/g, '').padStart(4, '0').slice(-4);
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  return `${y}-${mo}-${d}_${hh}_${mm}`;
}
