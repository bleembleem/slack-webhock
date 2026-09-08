/**
 * Discord Gateway listener — EdgeOne Makers Node Function
 * =======================================================
 *
 * File path cloud-functions/discord/gateway/index.ts maps to **GET /discord/gateway**.
 *
 * Discord HTTP Interactions do not receive regular messages. This route opens a
 * Gateway WebSocket for `DISCORD_GATEWAY_DURATION_MS` and forwards events to
 * POST /discord, which is where all the bot logic lives.
 *
 * The Chat SDK ships `startGatewayListener` for exactly this, but on this
 * runtime it forwards READY and GUILD_CREATE and then stops delivering events,
 * so @mentions never arrive. A plain discord.js client with the same intents
 * works, so we run one here and send the payload shape POST /discord expects.
 *
 * Do not overlap two listeners. Discord allows ~1000 IDENTIFY (connect)
 * attempts per day; two clients fighting for one token reconnect until Discord
 * resets the bot token.
 *
 * Authorize with `Authorization: Bearer $DISCORD_GATEWAY_SECRET` (or CRON_SECRET).
 * Default: one shot. Append `?chain=1` to start the next listener only after
 * this one has disconnected. `?ms=` shortens the run for testing.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import {
  DISCORD_GATEWAY_DURATION_MS,
  DISCORD_GATEWAY_RECONNECT_GAP_MS,
  discordAdapter,
  discordGatewaySecret,
} from '../../_adapters/discord';
import { jsonResponse, requestOrigin } from '../../_process';
import { createLogger } from '../../_logger';

const logger = createLogger('discord-gateway');

const GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

/** Event types POST /discord acts on. Forwarding the rest is pure noise. */
const FORWARDED_EVENTS = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(authHeader: string | null, secret: string): boolean {
  if (!secret) return false;
  return (authHeader ?? '').trim() === `Bearer ${secret}`;
}

function shouldChain(headers: Headers | null, query: URLSearchParams): boolean {
  if (headers?.get('x-discord-gateway-chain')?.trim() === '1') return true;
  const chain = query.get('chain')?.trim();
  return chain === '1' || chain === 'true';
}

type ListenerReport = {
  ready: string;
  packets: Record<string, number>;
  forwarded: number;
  problems: string[];
};

/**
 * Messages posted inside a Discord thread carry the thread's channel id.
 * `respondToChannelIds` is configured with parent channels, so resolve the
 * parent and tag the payload the way the Chat SDK's adapter expects.
 */
async function withThreadParent(
  client: Client,
  payload: unknown,
  respondToChannelIds: string[],
): Promise<unknown> {
  const message = payload as { author?: { bot?: boolean }; channel_id?: string };
  if (message.author?.bot || !message.channel_id) return payload;
  if (respondToChannelIds.includes(message.channel_id)) return payload;

  const channel = await client.channels.fetch(message.channel_id).catch(() => null);
  if (channel?.isThread() && channel.parentId && respondToChannelIds.includes(channel.parentId)) {
    return { ...message, thread: { id: channel.id, parent_id: channel.parentId } };
  }
  return payload;
}

async function runGatewayListener(opts: {
  botToken: string;
  webhookUrl: string;
  durationMs: number;
  respondToChannelIds: string[];
}): Promise<ListenerReport> {
  const startedAt = Date.now();
  const at = () => Date.now() - startedAt;
  const packets: Record<string, number> = {};
  const problems: string[] = [];
  const pending: Promise<void>[] = [];
  let forwarded = 0;
  let ready = 'never fired';
  let shuttingDown = false;

  const client = new Client({ intents: GATEWAY_INTENTS, partials: [Partials.Channel] });

  const forwardEvent = async (type: string, payload: unknown): Promise<void> => {
    try {
      const data =
        type === 'MESSAGE_CREATE' && opts.respondToChannelIds.length > 0
          ? await withThreadParent(client, payload, opts.respondToChannelIds)
          : payload;
      const response = await fetch(opts.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-discord-gateway-token': opts.botToken,
        },
        body: JSON.stringify({ type: `GATEWAY_${type}`, timestamp: Date.now(), data }),
      });
      if (response.ok) {
        forwarded += 1;
        return;
      }
      const detail = await response.text().catch(() => '');
      problems.push(`${at()}ms ${type} HTTP ${response.status} ${detail.slice(0, 120)}`);
    } catch (e) {
      problems.push(`${at()}ms ${type} ${String(e)}`);
    }
  };

  client.on('raw', (packet: { t?: string | null; d?: unknown }) => {
    if (shuttingDown || !packet?.t) return;
    packets[packet.t] = (packets[packet.t] ?? 0) + 1;
    if (!FORWARDED_EVENTS.has(packet.t)) return;
    // Our own replies come back as MESSAGE_CREATE. The bot ignores them anyway,
    // so dropping them here saves a POST /discord per reply.
    if (packet.t === 'MESSAGE_CREATE' && (packet.d as { author?: { bot?: boolean } })?.author?.bot) {
      return;
    }
    // discord.js links member.user back to author while handling the packet,
    // which makes it circular and unserializable. Snapshot before yielding.
    pending.push(forwardEvent(packet.t, structuredClone(packet.d)));
  });

  client.on(Events.ClientReady, () => {
    ready = `${at()}ms as ${client.user?.username ?? ''}`;
  });
  client.on(Events.Error, (e) => problems.push(`${at()}ms client ${String(e)}`));
  client.on(Events.ShardError, (e, id) => problems.push(`${at()}ms shard ${id} ${String(e)}`));
  client.on(Events.ShardDisconnect, (event, id) =>
    problems.push(`${at()}ms shard ${id} disconnected code=${event?.code}`),
  );

  try {
    await client.login(opts.botToken);
    await sleep(Math.max(0, opts.durationMs - at()));
  } catch (e) {
    problems.push(`${at()}ms login failed ${String(e)}`);
  } finally {
    shuttingDown = true;
    await Promise.allSettled(pending);
    client.destroy();
  }

  return { ready, packets, forwarded, problems: problems.slice(0, 20) };
}

async function onRequest(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  const env = context.env;
  const resolved = discordAdapter.resolveEnv(env);
  const secret = discordGatewaySecret(resolved);
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

  let query: URLSearchParams;
  try {
    query = new URL(request.url).searchParams;
  } catch {
    query = new URLSearchParams();
  }

  const durationMs = Math.min(
    Number(query.get('ms')) || DISCORD_GATEWAY_DURATION_MS,
    DISCORD_GATEWAY_DURATION_MS,
  );
  const webhookUrl = `${origin}/discord`;
  const chain = shouldChain(request.headers as unknown as Headers, query);
  logger.log(`start durationMs=${durationMs} chain=${chain} webhook=${webhookUrl}`);

  const report = await runGatewayListener({
    botToken: resolved.DISCORD_BOT_TOKEN ?? '',
    webhookUrl,
    durationMs,
    respondToChannelIds: (resolved.DISCORD_RESPOND_TO_CHANNEL_IDS ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  });

  logger.log(
    `listener finished ready=${report.ready} forwarded=${report.forwarded}` +
      ` packets=${JSON.stringify(report.packets)} problems=${report.problems.length}`,
  );

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

  return jsonResponse({ status: 'finished', durationMs, ...report });
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
