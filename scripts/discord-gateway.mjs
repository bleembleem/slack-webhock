/**
 * Discord Gateway daemon
 * ======================
 *
 * Discord only delivers regular messages (including @mentions) over a Gateway
 * WebSocket, never to the HTTP Interactions endpoint. This process holds that
 * connection open and forwards the events POST /discord acts on. All bot logic
 * stays in the deployed function; this is a pipe, nothing more.
 *
 * Run it somewhere that stays up:
 *   npm run gateway
 *
 * The deployed POST /discord-gateway agent is the primary listener; this is a
 * local fallback. Cloud Functions cap out at 120s, so
 * keeping a listener alive there means reconnecting ~800 times a day, and
 * Discord resets a bot token that connects more than ~1000 times a day.
 * One long-lived connection reconnects a handful of times instead.
 *
 * Env (read from .env or the environment):
 *   DISCORD_BOT_TOKEN               required
 *   DISCORD_WEBHOOK_URL             where to forward; defaults to production
 *   DISCORD_RESPOND_TO_CHANNEL_IDS  optional parent channel IDs
 */

import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';

const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
const WEBHOOK_URL = (
  process.env.DISCORD_WEBHOOK_URL ?? 'https://slack-webhock.edgeone.dev/discord'
).trim();
const RESPOND_TO_CHANNEL_IDS = (process.env.DISCORD_RESPOND_TO_CHANNEL_IDS ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set. Add it to .env or the environment.');
  process.exit(1);
}

/** Event types POST /discord acts on. Forwarding the rest is pure noise. */
const FORWARDED_EVENTS = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
]);

const log = (...args) => console.log(new Date().toISOString(), ...args);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel],
});

/**
 * Messages posted inside a Discord thread carry the thread's channel id, while
 * DISCORD_RESPOND_TO_CHANNEL_IDS lists parent channels. Resolve the parent and
 * tag the payload the way the Chat SDK adapter expects.
 */
async function withThreadParent(message) {
  if (RESPOND_TO_CHANNEL_IDS.length === 0) return message;
  if (message.author?.bot || !message.channel_id) return message;
  if (RESPOND_TO_CHANNEL_IDS.includes(message.channel_id)) return message;

  const channel = await client.channels.fetch(message.channel_id).catch(() => null);
  if (channel?.isThread() && channel.parentId && RESPOND_TO_CHANNEL_IDS.includes(channel.parentId)) {
    return { ...message, thread: { id: channel.id, parent_id: channel.parentId } };
  }
  return message;
}

async function forward(type, payload) {
  try {
    const data = type === 'MESSAGE_CREATE' ? await withThreadParent(payload) : payload;
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-discord-gateway-token': BOT_TOKEN,
      },
      body: JSON.stringify({ type: `GATEWAY_${type}`, timestamp: Date.now(), data }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log(`forward ${type} failed HTTP ${response.status} ${detail.slice(0, 200)}`);
      return;
    }
    log(`forward ${type} ok`);
  } catch (e) {
    log(`forward ${type} threw ${String(e)}`);
  }
}

client.on('raw', (packet) => {
  if (!packet?.t || !FORWARDED_EVENTS.has(packet.t)) return;
  // Our own replies come back as MESSAGE_CREATE. The bot ignores messages it
  // authored, so dropping them here saves a request per reply.
  if (packet.t === 'MESSAGE_CREATE' && packet.d?.author?.bot) return;
  // discord.js links member.user back to author while handling the packet,
  // which makes it circular and unserializable. Snapshot before yielding.
  void forward(packet.t, structuredClone(packet.d));
});

client.on(Events.ClientReady, () => log(`connected as ${client.user?.tag}; forwarding to ${WEBHOOK_URL}`));
client.on(Events.ShardResume, (id) => log(`shard ${id} resumed`));
client.on(Events.ShardDisconnect, (event, id) => log(`shard ${id} disconnected code=${event?.code}`));
client.on(Events.ShardReconnecting, (id) => log(`shard ${id} reconnecting`));
client.on(Events.ShardError, (e, id) => log(`shard ${id} error ${String(e)}`));
client.on(Events.Error, (e) => log(`client error ${String(e)}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, closing Gateway connection`);
    client.destroy();
    process.exit(0);
  });
}

await client.login(BOT_TOKEN);
