/**
 * Discord Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   DISCORD_BOT_TOKEN         Bot token from Discord Developer Portal → Bot
 *   DISCORD_PUBLIC_KEY        Application public key (General Information)
 *   DISCORD_APPLICATION_ID    Application ID (General Information)
 *   DISCORD_MENTION_ROLE_IDS  Optional comma-separated role IDs
 *   DISCORD_RESPOND_TO_CHANNEL_IDS  Optional parent channel IDs (no @mention)
 *   DISCORD_GATEWAY_SECRET    Bearer secret for GET /discord/gateway (or CRON_SECRET)
 *
 * HTTP Interactions (PING, slash, buttons) POST to /discord and must return
 * the Chat SDK response. Regular messages need GET /discord/gateway.
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
export const DISCORD_GATEWAY_OVERLAP_MS = 15_000;

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

export function discordSummarize(
  rawBody: string,
  request: { headers: { get(name: string): string | null } },
): string {
  const forwarded = request.headers.get('x-discord-gateway-token') ? 'yes' : 'no';
  const sig = request.headers.get('x-signature-ed25519') ? 'yes' : 'no';
  const ts = request.headers.get('x-signature-timestamp') ? 'yes' : 'no';
  try {
    const payload = JSON.parse(rawBody) as { type?: unknown };
    const type = typeof payload.type === 'string' || typeof payload.type === 'number' ? payload.type : '';
    return `type=${type} body_len=${rawBody.length} gateway_fwd=${forwarded} sig=${sig} ts=${ts}`;
  } catch {
    return `type=unparsed body_len=${rawBody.length} gateway_fwd=${forwarded} sig=${sig} ts=${ts}`;
  }
}

/**
 * PING / slash / buttons must return Chat SDK's body (PONG or DEFERRED).
 * Gateway-forwarded MESSAGE_CREATE posts can ack first — the agent run is slow.
 */
export function discordRespond(
  _rawBody: string,
  request: { headers: { get(name: string): string | null } },
): 'sdk' | 'ack' {
  return request.headers.get('x-discord-gateway-token') ? 'ack' : 'sdk';
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
};
