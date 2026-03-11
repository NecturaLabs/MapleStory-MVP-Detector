/**
 * regexPatterns.ts
 * Complete port of RegexPatterns.cs — all 9 patterns (IgnoreCase, en-GB).
 * Also contains the full MAP_DICTIONARY from appsettings.json (38 entries).
 *
 * IMPORTANT: All patterns with g/i flags must have lastIndex reset between uses.
 * Use resetRegex(pattern) before each match call, or clone with cloneRegex().
 */

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** Leading/trailing timestamp: [09:12], (09.12), 09:12, 09.12, etc. */
export const TIMESTAMP = /\s*(?:\[?{?\(?)?((?:[01]\d|2[0-3])(?:\.|-|:)?[0-5]\d)(?:\]?}?\)?)?\s*/;

/** Channel prefix: ch5, channel5, cc5, chan5 */
export const CHANNEL_1 = /(?:ch|channel|cc|chan)\.?\s?\d{1,2}/gi;

/** Channel suffix: 5ch, 5channel, 5cc, 5chan */
export const CHANNEL_2 = /\d{1,2}\s?(?:ch|channel|cc|chan)\.?/gi;

/** Scuffed channel: cc5 written as one token */
export const CHANNEL_SCUFFED = /\b(cc|ch|channel)\w\b/gi;

/**
 * Time (minute markers used in MapleStory MVP callouts):
 * xx45, 45xx, x45, 45x, :45, .45, ;45, 09:45, xx:45, etc.
 */
export const TIME =
  /\b(?!(?:[0-9]{1,2}[.,;:]0?|[0-9]{1,2}\.[0-9]))(?:(?:[;:]|xx)\s?\d{2}\b|\d{2}\s?xx\b|x\d{2}|\d{2}x|(?:[0-9]{1,2}|x{1,2})[:.,;][0-5]?[0-9]\b|xx\s?[:.,;]?\s?[0-9]?\b)/gi;

/** Special time: "MS 45" or "45 MS" (Mushroom Shrine time notation) */
export const SPECIAL_TIME = /(?:\bMS\s\d{2})|(?:\d{2}\sMS)/gi;

/** Verbal time expressions: "now", "rn", "soon", "in 5", etc. */
export const VERBAL_TIME =
  /\b(now|right now|fast|rn|quick|soon|in a moment|\bin\s*([1-9]|[1-9][0-9])\b)\b/gi;

/** Square bracket content: [anything] */
export const SQUARE_BRACKET = /\[[^\]]+\]/g;

/** MVP keyword variants: mvp, myp, MvP, MVp, MYP, etc. (IgnoreCase to match C#) */
export const MVP_PROBABLE = /\b[mM][vy][pP]\b/gi;

// ---------------------------------------------------------------------------
// Utility helpers for stateful regexes
// ---------------------------------------------------------------------------

/** Reset a regex with the g flag before use */
export function resetRegex(re: RegExp): RegExp {
  re.lastIndex = 0;
  return re;
}

/** Clone a regex (same pattern/flags but fresh lastIndex=0) */
export function cloneRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

// ---------------------------------------------------------------------------
// MAP_DICTIONARY (full port from appsettings.json)
// Key = display map name, Value = array of match keywords (empty = use key words only)
// ---------------------------------------------------------------------------

export const MAP_DICTIONARY: Record<string, string[]> = {
  'Henesys':                   ['hene'],
  'Mushroom Shrine':           ['ms', 'mshrine', 'shrine', 'mushroom shrine'],
  'Ellinia':                   [],
  'Perion':                    [],
  'Kerning City':              ['kerning'],
  'Lith Harbor':               ['lith'],
  'Nautilus Harbor':           ['nautilus'],
  'Sleepywood':                [],
  'Orbis':                     [],
  'El Nath':                   ['nath'],
  'Ludibrium':                 ['ludi'],
  'Omega Sector':              [],
  'Ariant':                    [],
  'Magatia':                   [],
  'Edelstein':                 ['edel'],
  'Rien':                      [],
  'Leafre':                    [],
  'New Leaf City':             ['nlc'],
  'Mu Lung':                   ['mu lung'],
  'Herb Town':                 [],
  'Temple of Time':            ['temple', 'tos'],
  'Elluel':                    [],
  'Pantheon':                  [],
  'Heliseum':                  [],
  'Fox Point Village':         ['fox village'],
  'Savage Terminal':           [],
  'Cernium':                   [],
  'Hotel Arcus':               ['arcus'],
  'Odium':                     [],
  'Shangri-La':                [],
  'Arteria':                   [],
  'Carcion':                   [],
  'Momijigaoka':               ['momiji'],
  'Future Henesys':            ['future hene'],
  'Ellin Forest':              ['ellin'],
  'The Door to Zakum':         ['door to zakum', 'zakum', 'zak'],
  'Ariant Station Platform':   ['station platform'],
};
