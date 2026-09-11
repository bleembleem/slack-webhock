/**
 * Discord Gateway listener — EdgeOne Makers Agent
 * ===============================================
 *
 * File path agents/discord-gateway/index.ts maps to **POST /discord-gateway**.
 *
 * Discord only delivers regular messages (including @mentions) over a Gateway
 * WebSocket, never to the HTTP Interactions endpoint. This holds that socket
 * open and forwards the events POST /discord acts on. All bot logic stays
 * there; this is a pipe, nothing more.
 *
 * It lives in the Agents runtime rather than a Cloud Function because
 * `cloudFunctions.maxDuration` caps at 120s while this runtime allows 600s.
 * That matters: Discord resets a bot token that connects more than ~1000 times
 * a day, and 120s windows would need ~800 reconnects a day. 9-minute windows
 * need about 160, which is what the Chat SDK's own serverless guide budgets.
 *
 * Never run two listeners on one token at once — they reconnect against each
 * other until Discord resets the token. The `schedules` entry in edgeone.json
 * re-arms this every 10 minutes, and GATEWAY_CONVERSATION_ID keeps repeat
 * triggers from overlapping (see the single-flight guard in onRequest).
 *
 * Authorize with `Authorization: Bearer $DISCORD_GATEWAY_SECRET` (or CRON_SECRET).
 * `?ms=` shortens the run for testing.
 *
 * `context.request.signal` aborts on client disconnect as well as run timeout,
 * and this has to outlive the cron request that kicked it off, so the window is
 * not tied to it. To stop it, remove the schedule or rotate the secret.
 */

import type { AgentContext } from '@edgeone/types';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { createLogger } from '../_logger';

const logger = createLogger('discord-gateway');

/**
 * The runtime kills an invocation at 600s with a 502 no matter what
 * `agents.timeout` says (measured with `?probe=1`), and cron re-arms us every
 * 10 minutes. 9.5 minutes is the longest window that still exits cleanly,
 * leaving a ~30s gap per cycle where mentions are missed.
 */
const GATEWAY_DURATION_MS = 570_000;

/**
 * Every start uses this conversation id so the runtime, which tracks one active
 * run per conversation, serialises them. That is what makes POST /gateway-tick
 * safe to leave unauthenticated: cron cannot send headers, so anyone can call
 * it, but a repeat trigger can only ever no-op or queue — never connect a
 * second socket on the same bot token.
 *
 * Kept in sync by hand with the copy in cloud-functions/gateway-tick.
 */
const GATEWAY_CONVERSATION_ID = 'discord-gateway';

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

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function resolveOrigin(url: string, headers: Record<string, string>): string {
  const host = (headers['eo-pages-host'] || headers['x-forwarded-host'] || headers.host || '')
    .split(',')[0]
    .trim();
  const proto = headers['x-forwarded-proto'] || 'https';
  if (host && !/tencentscf|localhost|127\.0\.0\.1/i.test(host)) {
    return `${proto}://${host}`;
  }
  try {
    const origin = new URL(url).origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    /* relative or invalid URL */
  }
  return host ? `${proto}://${host}` : '';
}

type ListenerReport = {
  ready: string;
  packets: Record<string, number>;
  forwarded: number;
  problems: string[];
};

/**
 * Messages posted inside a Discord thread carry the thread's channel id, while
 * DISCORD_RESPOND_TO_CHANNEL_IDS lists parent channels. Resolve the parent and
 * tag the payload the way the Chat SDK adapter expects.
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
    // Our own replies come back as MESSAGE_CREATE. The bot ignores messages it
    // authored, so dropping them here saves a POST /discord per reply.
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

export async function onRequest(context: AgentContext): Promise<Response> {
  const env = context.env as Record<string, string | undefined>;
  const request = context.request;
  const headers = request.headers ?? {};

  const secret = clean(env.DISCORD_GATEWAY_SECRET) || clean(env.CRON_SECRET);
  if (!secret) {
    logger.error('DISCORD_GATEWAY_SECRET (or CRON_SECRET) is not configured');
    return jsonResponse({ status: 'error', message: 'discord gateway secret is not configured' }, 500);
  }
  if (clean(headers.authorization) !== `Bearer ${secret}`) {
    return jsonResponse({ status: 'error', message: 'unauthorized' }, 401);
  }

  const botToken = clean(env.DISCORD_BOT_TOKEN);
  if (!botToken) {
    logger.error('DISCORD_BOT_TOKEN is not configured');
    return jsonResponse({ status: 'error', message: 'DISCORD_BOT_TOKEN is not configured' }, 500);
  }

  // The single-flight guard below only sees runs on the same conversation, so a
  // start under any other id would sit outside the mutex and could open a
  // second socket.
  if (context.conversation_id !== GATEWAY_CONVERSATION_ID) {
    logger.error(`refusing start under conversation ${context.conversation_id}`);
    return jsonResponse(
      {
        status: 'error',
        message: `makers-conversation-id must be ${GATEWAY_CONVERSATION_ID}`,
      },
      409,
    );
  }

  // A listener is already holding the socket for this conversation. Connecting
  // a second one would double every reply and burn the IDENTIFY budget.
  const activeRunId = context.active_run_id;
  if (activeRunId && activeRunId !== context.run_id) {
    logger.log(`already running as ${activeRunId}; skipping`);
    return jsonResponse({ status: 'skipped', reason: 'already running', activeRunId });
  }

  const origin = resolveOrigin(request.url, headers);
  if (!origin) {
    logger.error('missing request origin; cannot forward Gateway events');
    return jsonResponse({ status: 'error', message: 'missing request origin' }, 500);
  }

  const query = request.query ?? {};

  // How long does this runtime actually let a task run? The listener only
  // chains after its window ends, so a run killed early never re-arms. Measure
  // it without touching Discord, so this costs no IDENTIFY and cannot collide
  // with a listener that is already connected.
  if (query.probe === '1' || query.probe === 1) {
    const probeMs = Math.max(0, Number(query.ms) || 60_000);
    const probeStart = Date.now();
    logger.log(`probe requested ${probeMs}ms`);
    await sleep(probeMs);
    const elapsedMs = Date.now() - probeStart;
    logger.log(`probe survived ${elapsedMs}ms`);
    return jsonResponse({ status: 'probe', requestedMs: probeMs, elapsedMs });
  }

  const requestedMs = Number(query.ms);
  const durationMs = Math.min(
    Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : GATEWAY_DURATION_MS,
    GATEWAY_DURATION_MS,
  );
  const webhookUrl = `${origin}/discord`;
  logger.log(`start durationMs=${durationMs} webhook=${webhookUrl}`);

  const startedAt = Date.now();
  const report = await runGatewayListener({
    botToken,
    webhookUrl,
    durationMs,
    respondToChannelIds: clean(env.DISCORD_RESPOND_TO_CHANNEL_IDS)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  });
  const elapsedMs = Date.now() - startedAt;

  logger.log(
    `listener finished elapsed=${elapsedMs}ms ready=${report.ready} forwarded=${report.forwarded}` +
      ` packets=${JSON.stringify(report.packets)} problems=${report.problems.length}`,
  );

  return jsonResponse({ status: 'finished', durationMs, elapsedMs, ...report });
}
