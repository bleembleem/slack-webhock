/**
 * Discord Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   DISCORD_BOT_TOKEN         Bot token from Discord Developer Portal → Bot
 *   DISCORD_PUBLIC_KEY        Application public key (General Information)
 *   DISCORD_APPLICATION_ID    Application ID (General Information)
 *   DISCORD_MENTION_ROLE_IDS  Optional comma-separated role IDs
 *   DISCORD_RESPOND_TO_CHANNEL_IDS  Optional parent channel IDs (no @mention)
 *   DISCORD_GATEWAY_SECRET    Bearer secret for POST /discord-gateway (or CRON_SECRET)
 *
 * HTTP Interactions (PING, slash, buttons) POST to /discord and must return
 * the Chat SDK response. Regular messages need POST /discord-gateway.
 */

import { createDiscordAdapter } from '@chat-adapter/discord';
import { createLogger } from '../_logger';

const logger = createLogger('discord-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type DiscordEnv = {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_MENTION_ROLE_IDS?: string;
  DISCORD_RESPOND_TO_CHANNEL_IDS?: string;
  DISCORD_GATEWAY_SECRET?: string;
  CRON_SECRET?: string;
};

/** Stay under Cloud Functions maxDuration (120s) with room for login/teardown. */
export const DISCORD_GATEWAY_DURATION_MS = 105_000;
/** Pause after destroy so Discord can drop the session before the next IDENTIFY. */
export const DISCORD_GATEWAY_RECONNECT_GAP_MS = 2_000;

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function parseCsv(value: string | undefined): string[] {
  return normalizeSecret(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isDiscordPublicKey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function isDiscordApplicationId(value: string): boolean {
  return /^\d{17,22}$/.test(value);
}

export function isDiscordBotToken(value: string): boolean {
  return value.length > 50 && value.includes('.');
}

export function resolveDiscordEnv(env: DiscordEnv): DiscordEnv {
  return {
    DISCORD_BOT_TOKEN: normalizeSecret(env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN),
    DISCORD_PUBLIC_KEY: normalizeSecret(env.DISCORD_PUBLIC_KEY || process.env.DISCORD_PUBLIC_KEY),
    DISCORD_APPLICATION_ID: normalizeSecret(
      env.DISCORD_APPLICATION_ID || process.env.DISCORD_APPLICATION_ID,
    ),
    DISCORD_MENTION_ROLE_IDS: normalizeSecret(
      env.DISCORD_MENTION_ROLE_IDS || process.env.DISCORD_MENTION_ROLE_IDS,
    ),
    DISCORD_RESPOND_TO_CHANNEL_IDS: normalizeSecret(
      env.DISCORD_RESPOND_TO_CHANNEL_IDS || process.env.DISCORD_RESPOND_TO_CHANNEL_IDS,
    ),
    DISCORD_GATEWAY_SECRET: normalizeSecret(
      env.DISCORD_GATEWAY_SECRET || process.env.DISCORD_GATEWAY_SECRET,
    ),
    CRON_SECRET: normalizeSecret(env.CRON_SECRET || process.env.CRON_SECRET),
  };
}

export function discordFingerprint(env: DiscordEnv): Record<string, string> {
  return {
    discordToken: normalizeSecret(env.DISCORD_BOT_TOKEN),
    discordPublicKey: normalizeSecret(env.DISCORD_PUBLIC_KEY),
    discordApplicationId: normalizeSecret(env.DISCORD_APPLICATION_ID),
    discordMentionRoles: normalizeSecret(env.DISCORD_MENTION_ROLE_IDS),
    discordRespondChannels: normalizeSecret(env.DISCORD_RESPOND_TO_CHANNEL_IDS),
  };
}

export function createDiscordChatAdapter(env: DiscordEnv) {
  const botToken = normalizeSecret(env.DISCORD_BOT_TOKEN);
  const publicKey = normalizeSecret(env.DISCORD_PUBLIC_KEY);
  const applicationId = normalizeSecret(env.DISCORD_APPLICATION_ID);
  if (!isDiscordBotToken(botToken) || !isDiscordPublicKey(publicKey) || !isDiscordApplicationId(applicationId)) {
    return undefined;
  }

  const mentionRoleIds = parseCsv(env.DISCORD_MENTION_ROLE_IDS);
  const respondToChannelIds = parseCsv(env.DISCORD_RESPOND_TO_CHANNEL_IDS);
  return createDiscordAdapter({
    botToken,
    publicKey,
    applicationId,
    ...(mentionRoleIds.length > 0 ? { mentionRoleIds } : {}),
    ...(respondToChannelIds.length > 0 ? { respondToChannelIds } : {}),
  });
}

export function discordGatewaySecret(env: DiscordEnv): string {
  return normalizeSecret(env.DISCORD_GATEWAY_SECRET) || normalizeSecret(env.CRON_SECRET);
}

/**
 * The adapter opens a Discord thread for every mention before our handlers run
 * and offers no way to turn that off. We answer in the channel, so that thread
 * stays empty — delete it instead of littering the channel. Needs Manage Threads.
 *
 * Chat SDK thread ids are `discord:guildId:channelId[:threadId]`.
 */
export async function discordDeleteEmptyThread(env: DiscordEnv, chatThreadId: string): Promise<void> {
  const parts = chatThreadId.split(':');
  const discordThreadId = parts.length >= 4 ? parts[3] : '';
  if (!discordThreadId) return;

  const botToken = normalizeSecret(env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN);
  if (!botToken) return;

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${discordThreadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error(
        `failed to delete empty thread ${discordThreadId}: HTTP ${response.status} ${detail.slice(0, 120)}`,
      );
    }
  } catch (e) {
    logger.error(`failed to delete empty thread ${discordThreadId}: ${String(e)}`);
  }
}

export function discordSummarize(
  rawBody: string,
  request: { headers: { get(name: string): string | null } },
): string {
  const forwarded = request.headers.get('x-discord-gateway-token') ? 'yes' : 'no';
  const sig = request.headers.get('x-signature-ed25519') ? 'yes' : 'no';
  const ts = request.headers.get('x-signature-timestamp') ? 'yes' : 'no';
  try {
    const payload = JSON.parse(rawBody) as {
      type?: unknown;
      data?: {
        id?: unknown;
        content?: unknown;
        channel_id?: unknown;
        guild_id?: unknown;
        author?: { id?: unknown; username?: unknown; bot?: unknown };
        mentions?: Array<{ id?: unknown }>;
        mention_roles?: unknown[];
      };
    };
    const type = typeof payload.type === 'string' || typeof payload.type === 'number' ? payload.type : '';
    if (type === 'GATEWAY_MESSAGE_CREATE' && payload.data) {
      const data = payload.data;
      const content = typeof data.content === 'string' ? data.content.slice(0, 80) : '';
      const mentionIds = Array.isArray(data.mentions) ? data.mentions.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
      return (
        `type=${type} body_len=${rawBody.length} gateway_fwd=${forwarded}` +
        ` guild=${data.guild_id ?? 'dm'} channel=${data.channel_id ?? ''}` +
        ` author=${data.author?.username ?? ''} bot=${data.author?.bot === true}` +
        ` mentions=${mentionIds.join(',') || 'none'}` +
        ` text="${content}"`
      );
    }
    return `type=${type} body_len=${rawBody.length} gateway_fwd=${forwarded} sig=${sig} ts=${ts}`;
  } catch {
    return `type=unparsed body_len=${rawBody.length} gateway_fwd=${forwarded} sig=${sig} ts=${ts}`;
  }
}

/**
 * PING / slash must return Chat SDK's body (PONG or DEFERRED).
 * Gateway-forwarded MESSAGE_CREATE acks first — the agent run continues after 200.
 */
export function discordRespond(
  _rawBody: string,
  request: { headers: { get(name: string): string | null } },
): 'sdk' | 'ack' {
  return request.headers.get('x-discord-gateway-token') ? 'ack' : 'sdk';
}

export function discordPrepare(
  rawBody: string,
  headers: Headers,
  env: Record<string, string | undefined>,
): { rawBody: string; headers?: Headers } {
  let body = rawBody;
  const next = new Headers(headers);
  try {
    const parsed = JSON.parse(rawBody) as {
      type?: unknown;
      data?: {
        mentions?: unknown;
        attachments?: unknown;
        mention_roles?: unknown;
        author?: { id?: unknown; username?: unknown; bot?: unknown };
        content?: unknown;
        channel_id?: unknown;
        guild_id?: unknown;
      };
    };
    if (typeof parsed?.type !== 'string' || !parsed.type.startsWith('GATEWAY_')) {
      return { rawBody: body };
    }

    if (parsed.type === 'GATEWAY_MESSAGE_CREATE' && parsed.data && typeof parsed.data === 'object') {
      if (!Array.isArray(parsed.data.mentions)) parsed.data.mentions = [];
      if (!Array.isArray(parsed.data.attachments)) parsed.data.attachments = [];
      if (!Array.isArray(parsed.data.mention_roles)) parsed.data.mention_roles = [];
      body = JSON.stringify(parsed);
    }

    if (!next.get('x-discord-gateway-token')) {
      const token = normalizeSecret(env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN);
      if (token) {
        next.set('x-discord-gateway-token', token);
        logger.log(`injected gateway token for ${parsed.type}`);
        return { rawBody: body, headers: next };
      }
    }
    return body === rawBody ? { rawBody: body } : { rawBody: body, headers: next };
  } catch {
    return { rawBody };
  }
}

export function assertDiscordEnv(env: Record<string, string | undefined>): Response | void {
  const botToken = normalizeSecret(env.DISCORD_BOT_TOKEN);
  const publicKey = normalizeSecret(env.DISCORD_PUBLIC_KEY);
  const applicationId = normalizeSecret(env.DISCORD_APPLICATION_ID);

  if (!isDiscordPublicKey(publicKey)) {
    logger.error('DISCORD_PUBLIC_KEY is missing or not a 64-char hex public key');
    return jsonResponse(
      { status: 'error', message: 'DISCORD_PUBLIC_KEY is not configured' },
      500,
    );
  }

  if (!isDiscordApplicationId(applicationId)) {
    logger.error('DISCORD_APPLICATION_ID is missing or not a Discord snowflake');
    return jsonResponse(
      { status: 'error', message: 'DISCORD_APPLICATION_ID is not configured' },
      500,
    );
  }

  const botTokenValid = isDiscordBotToken(botToken);
  logger.log(`DISCORD_BOT_TOKEN present=${Boolean(botToken)} format=${botTokenValid ? 'ok' : 'invalid'}`);
  if (!botTokenValid) {
    logger.error('DISCORD_BOT_TOKEN must be the bot token from Discord Developer Portal → Bot.');
    return jsonResponse(
      {
        status: 'error',
        message: 'DISCORD_BOT_TOKEN is invalid. Use the bot token from the Discord Developer Portal.',
      },
      500,
    );
  }
}

export const discordAdapter = {
  name: 'discord' as const,
  resolveEnv: resolveDiscordEnv,
  fingerprint: discordFingerprint,
  create: createDiscordChatAdapter,
  assertEnv: assertDiscordEnv,
  summarize: discordSummarize,
  respond: discordRespond,
  prepare: discordPrepare,
};
