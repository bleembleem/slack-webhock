/**
 * Discord Gateway listener — EdgeOne Makers Node Function
 * =======================================================
 *
 * File path cloud-functions/discord/gateway/index.ts maps to **GET /discord/gateway**.
 *
 * Discord HTTP Interactions do not receive regular messages. This route
 * opens a Gateway WebSocket for `DISCORD_GATEWAY_DURATION_MS` and forwards
 * events to POST /discord.
 *
 * Do not overlap two listeners. Discord allows ~1000 IDENTIFY (connect)
 * attempts per day; two discord.js clients fighting for one token reconnects
 * until Discord resets the bot token.
 *
 * Authorize with `Authorization: Bearer $DISCORD_GATEWAY_SECRET` (or CRON_SECRET).
 * Default: one shot. Append `?chain=1` to start the next listener only after
 * this one has disconnected.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import {
  DISCORD_GATEWAY_DURATION_MS,
  DISCORD_GATEWAY_RECONNECT_GAP_MS,
  discordAdapter,
  discordGatewaySecret,
} from '../../_adapters/discord';
import { getChatBot } from '../../_bot';
import { jsonResponse, requestOrigin } from '../../_process';
import { createLogger } from '../../_logger';

const logger = createLogger('discord-gateway');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(authHeader: string | null, secret: string): boolean {
  if (!secret) return false;
  return (authHeader ?? '').trim() === `Bearer ${secret}`;
}

function shouldChain(request: { url: string; headers: { get(name: string): string | null } }): boolean {
  if (request.headers.get('x-discord-gateway-chain')?.trim() === '1') return true;
  try {
    const chain = new URL(request.url).searchParams.get('chain')?.trim();
    if (chain === '1' || chain === 'true') return true;
  } catch {
    /* relative URL */
  }
  return false;
}

type DiscordGatewayAdapter = {
  startGatewayListener: (
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ) => Promise<Response>;
};

async function onRequest(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  const env = context.env;
  const secret = discordGatewaySecret(discordAdapter.resolveEnv(env));
  if (!secret) {
    logger.error('DISCORD_GATEWAY_SECRET (or CRON_SECRET) is not configured');
    return jsonResponse({ status: 'error', message: 'discord gateway secret is not configured' }, 500);
  }
  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    return jsonResponse({ status: 'error', message: 'unauthorized' }, 401);
  }

  const envError = discordAdapter.assertEnv(env);
  if (envError) return envError;

  const origin = requestOrigin(request);
  if (!origin) {
    logger.error('missing request origin; cannot forward Gateway events');
    return jsonResponse({ status: 'error', message: 'missing request origin' }, 500);
  }

  const webhookUrl = `${origin}/discord`;
  const durationMs = DISCORD_GATEWAY_DURATION_MS;
  const chain = shouldChain(request);
  logger.log(`start durationMs=${durationMs} chain=${chain} webhook=${webhookUrl}`);

  let discord: DiscordGatewayAdapter;
  try {
    const bot = getChatBot(env);
    await bot.initialize();
    discord = bot.getAdapter('discord') as DiscordGatewayAdapter;
  } catch (e) {
    logger.error('failed to initialize chat bot for gateway:', e);
    return jsonResponse({ status: 'error', message: 'discord adapter is not registered' }, 500);
  }

  if (!discord || typeof discord.startGatewayListener !== 'function') {
    logger.error('discord adapter missing startGatewayListener');
    return jsonResponse({ status: 'error', message: 'discord adapter is not registered' }, 500);
  }

  let listenerTask: Promise<unknown> | undefined;
  const started = await discord.startGatewayListener(
    {
      waitUntil: (task) => {
        listenerTask = Promise.resolve(task);
      },
    },
    durationMs,
    undefined,
    webhookUrl,
  );

  if (listenerTask) {
    try {
      await listenerTask;
    } catch (e) {
      logger.error('discord gateway listener failed:', e);
    }
  }

  logger.log('listener finished');

  if (chain) {
    await sleep(DISCORD_GATEWAY_RECONNECT_GAP_MS);
    const nextUrl = `${origin}/discord/gateway?chain=1`;
    void fetch(nextUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}` },
    }).catch((e) => {
      logger.error('failed to chain discord gateway listener:', e);
    });
  }

  return started;
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
