/**
 * discordService.ts
 *
 * Sends MVP alerts to a Discord channel via a Discord Webhook URL.
 * Discord webhooks accept HTTPS POST requests — no backend or bot token required.
 *
 * Usage:
 *   sendMvpToDiscord(webhookUrl, mvpDetails)
 *   testDiscordWebhook(webhookUrl)
 *
 * The webhook URL is stored in app settings and never leaves the browser except
 * when the user explicitly enables Discord notifications.
 */

export interface MvpDiscordPayload {
  text: string;
  channel: number | null;
  willBeUsedAt: number | null; // epoch ms, or 0 for "now/soon"
  location: string | null;
  rawTimestamp: string | null;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string };
  timestamp: string;
}

interface DiscordWebhookBody {
  username: string;
  avatar_url: string;
  content?: string;
  embeds: DiscordEmbed[];
}

// MapleStory gold colour
const EMBED_COLOR = 0xe8a000;

// Public MVP trophy icon (MapleStory themed)
const AVATAR_URL = 'https://i.imgur.com/EvQgqaD.png';

/**
 * Build a Discord embed for a detected MVP event.
 */
function buildEmbed(payload: MvpDiscordPayload): DiscordEmbed {
  const fields: DiscordEmbed['fields'] = [];

  if (payload.channel !== null) {
    fields.push({ name: 'Channel', value: `Ch ${payload.channel}`, inline: true });
  }

  if (payload.willBeUsedAt !== null) {
    const isNow = payload.willBeUsedAt === 0;
    const value = isNow
      ? 'Now / Soon'
      : `<t:${Math.floor(payload.willBeUsedAt / 1000)}:t>`;
    fields.push({ name: 'Time', value, inline: true });
  }

  if (payload.location) {
    fields.push({ name: 'Location', value: payload.location, inline: true });
  }

  const description = payload.text.trim();

  return {
    title: '🏆 New MVP Detected',
    description: description.length > 4096 ? description.slice(0, 4093) + '…' : description,
    color: EMBED_COLOR,
    fields,
    footer: { text: 'MapleStory MVP Detector' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate that a string looks like a Discord webhook URL.
 * Discord webhooks always start with https://discord.com/api/webhooks/ or
 * the canary/ptb variants.
 */
export function isValidWebhookUrl(url: string): boolean {
  return /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/.+$/i.test(
    url.trim(),
  );
}

/**
 * POST an MVP notification to the given Discord webhook URL.
 * If roleId is provided, prepends a role mention (<@&ROLE_ID>) as message content.
 * Returns null on success, or an error message string on failure.
 */
export async function sendMvpToDiscord(
  webhookUrl: string,
  payload: MvpDiscordPayload,
  roleId?: string,
): Promise<string | null> {
  if (!isValidWebhookUrl(webhookUrl)) {
    return 'Invalid Discord webhook URL.';
  }

  const body: DiscordWebhookBody = {
    username: 'MVP Detector',
    avatar_url: AVATAR_URL,
    embeds: [buildEmbed(payload)],
  };

  // Prepend role mention if a valid role ID is provided
  const trimmedRoleId = roleId?.trim();
  if (trimmedRoleId && /^\d+$/.test(trimmedRoleId)) {
    body.content = `<@&${trimmedRoleId}>`;
  }

  try {
    const res = await fetch(webhookUrl.trim() + '?wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) return null;

    // Discord returns JSON error details on 4xx
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { message?: string; code?: number };
      if (json.message) detail += `: ${json.message}`;
    } catch {
      // ignore JSON parse failure
    }
    return detail;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Network error: ${msg}`;
  }
}

/**
 * Send a test message to verify the webhook URL works.
 * Returns null on success, or an error message string on failure.
 */
export async function testDiscordWebhook(webhookUrl: string): Promise<string | null> {
  if (!isValidWebhookUrl(webhookUrl)) {
    return 'Invalid Discord webhook URL. Expected: https://discord.com/api/webhooks/<id>/<token>';
  }

  const body: DiscordWebhookBody = {
    username: 'MVP Detector',
    avatar_url: AVATAR_URL,
    embeds: [
      {
        title: '✅ Webhook Test',
        description: 'MapleStory MVP Detector is connected to this channel.',
        color: 0x48bb78,
        fields: [],
        footer: { text: 'MapleStory MVP Detector' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl.trim() + '?wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) return null;

    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json.message) detail += `: ${json.message}`;
    } catch {
      // ignore
    }
    return detail;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Network error: ${msg}`;
  }
}
