/**
 * Chat SDK bot — private module (starts with _), not mapped as a route.
 *
 * One Chat instance, pluggable adapters. Handlers are platform-agnostic.
 * Register vendors in `_adapters/` (add `<name>.ts` and wire it in
 * `_adapters/index.ts`). Vendor routes (POST /slack, POST /discord, …)
 * dispatch through `_process.ts`. Slack acks immediately; Discord Interactions
 * return Chat SDK's PONG/DEFERRED. Regular Discord messages need POST /discord-gateway.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. cloud-functions/_adapters/<name>.ts and wire create / resolveEnv / fingerprint
 *   3. cloud-functions/<name>/index.ts with createVendorWebhook
 *   Discord also needs agents/discord-gateway (Gateway WebSocket).
 *
 * Memory state adapter keeps subscriptions/locks in-process (lost on restart).
 *
 * Replies post a placeholder, hand the run to /chat without waiting, and let
 * POST /chat-callback edit the placeholder when the answer arrives — a Cloud
 * Function is killed at 120s, which is not enough for a long agent run.
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Chat,
  ThreadImpl,
  type Channel,
  type Message,
  type SerializedThread,
  type Thread,
} from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import {
  buildAdapters,
  envFingerprint,
  resolveBotEnv,
  vendorAdapter,
  type BotEnv,
  type ChatAdapters,
} from './_adapters';
import { callbackSecret, type AgentCallback, type CallbackTarget } from './_callback';
import { createLogger } from './_logger';

const logger = createLogger('chat-bot');

type RequestScope = {
  origin: string;
};

export const requestContext = new AsyncLocalStorage<RequestScope>();

export type { BotEnv };
export type ChatBot = Chat<ChatAdapters>;

let bot: ChatBot | undefined;
let cachedFingerprint = '';

/**
 * Agent sticky routing expects the same conversation-id shape the web UI uses:
 * a 36-char UUID v4 (version nibble `4`, RFC variant `8`/`9`/`a`/`b`).
 * Vendor thread ids contain `:` and are not valid Makers conversation ids.
 */
function uuidFromSeed(seed: string): string {
  const chars = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Chat SDK thread ids are `adapter:channel:thread`. */
function platformFromThreadId(threadId: string): string {
  const platform = threadId.split(':')[0];
  return platform || 'im';
}

function conversationSeed(platform: string, threadId: string): string {
  if (platform === 'slack') return `slack-thread:${threadId}`;
  return `${platform}-thread:${threadId}`;
}

function userSeed(platform: string, qualifiedUserId: string): string {
  if (platform === 'slack') return `slack-user:${qualifiedUserId}`;
  return `${platform}-user:${qualifiedUserId}`;
}

type AgentRunOptions = {
  origin: string;
  message: string;
  platform: string;
  userId: string;
  conversationId: string;
  callback: AgentCallback;
  signal: AbortSignal;
};

async function postAgent(opts: AgentRunOptions): Promise<void> {
  const conversationId = uuidFromSeed(conversationSeed(opts.platform, opts.conversationId));
  const userId = uuidFromSeed(userSeed(opts.platform, opts.userId));
  const url = `${opts.origin}/chat`;
  logger.log(`POST ${url} makers-conversation-id=${conversationId}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Origin: opts.origin,
      Referer: `${opts.origin}/`,
      'User-Agent':
        'Mozilla/5.0 (compatible; ImWebhookAgent/1.0; +https://slack-webhock.edgeone.dev/)',
      'makers-conversation-id': conversationId,
    },
    body: JSON.stringify({
      message: opts.message,
      userId,
      callback: opts.callback,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
}

const THINKING = 'Thinking…';
/** Long enough for the agent to reject a run outright, short enough to ack fast. */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Hand the run to the agent and let go. The answer comes back out of band via
 * POST /chat-callback, which is the only way to outlive the 120s Cloud Function
 * ceiling.
 *
 * We wait briefly so a rejected run still surfaces as an error here, then abort
 * to detach. Aborting closes our connection but does not stop the run — /chat
 * ignores its request signal whenever a callback is set.
 */
async function dispatchAgent(opts: Omit<AgentRunOptions, 'signal'>): Promise<void> {
  const detach = new AbortController();
  const timer = setTimeout(() => detach.abort(), DISPATCH_TIMEOUT_MS);
  try {
    await postAgent({ ...opts, signal: detach.signal });
    logger.log(`agent run finished within the dispatch window conversation=${opts.conversationId}`);
  } catch (e) {
    if (!detach.signal.aborted) throw e;
    logger.log(`agent run detached conversation=${opts.conversationId}; awaiting callback`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reply surface as something both this request and /chat-callback can
 * rebuild. A Chat SDK thread id encodes where messages go, so pointing it at
 * the channel is what makes both `post` and `edit` land there.
 *
 * Omit `threadId` to reply in the channel itself.
 */
function replySurfaceOf(channel: Channel, threadId?: string): SerializedThread {
  const json = channel.toJSON();
  return {
    _type: 'chat:Thread',
    adapterName: json.adapterName,
    channelId: json.id,
    ...(json.channelVisibility ? { channelVisibility: json.channelVisibility } : {}),
    id: threadId ?? json.id,
    isDM: json.isDM,
  };
}

async function respond(opts: {
  env: BotEnv;
  surface: SerializedThread;
  text: string;
  platform: string;
  userId: string;
  source: string;
}): Promise<void> {
  const origin = requestContext.getStore()?.origin;
  if (!origin) throw new Error('missing request origin; cannot call /chat');
  const secret = callbackSecret(opts.env);
  if (!secret) throw new Error('AGENT_CALLBACK_SECRET is not configured');

  const conversationId = opts.surface.id;
  logger.log(
    `${opts.source} platform=${opts.platform} conversation=${conversationId} user=${opts.userId} text="${opts.text.slice(0, 50)}"`,
  );

  const placeholder = await ThreadImpl.fromJSON(opts.surface).post(THINKING);
  const target: CallbackTarget = { thread: opts.surface, message: placeholder.toJSON() };
  await dispatchAgent({
    origin,
    message: opts.text,
    platform: opts.platform,
    userId: `${opts.platform}:${opts.userId}`,
    conversationId,
    callback: { url: `${origin}/chat-callback`, token: secret, target },
  });
}

async function replyToThread(
  env: BotEnv,
  thread: Thread,
  message: Message,
  source: string,
): Promise<void> {
  if (message.author.isMe || message.author.isBot === true) {
    logger.log(
      `skip ${source} thread=${thread.id} isMe=${message.author.isMe} isBot=${message.author.isBot}`,
    );
    return;
  }

  const platform = platformFromThreadId(thread.id);
  const vendor = vendorAdapter(platform);
  const replyInChannel = vendor?.replySurface === 'channel';
  const surface = replySurfaceOf(thread.channel, replyInChannel ? undefined : thread.id);
  if (replyInChannel) {
    const raw = message.raw as { channel_id?: string } | undefined;
    await vendor?.discardUnusedThread?.(env, thread.id, raw?.channel_id);
  }

  await respond({
    env,
    surface,
    text: message.text.trim() || '(The user sent a message with no text.)',
    platform,
    userId: message.author.userId,
    source,
  });
}

function createBot(env: BotEnv): ChatBot {
  const adapters = buildAdapters(env);
  if (Object.keys(adapters).length === 0) {
    throw new Error('no chat adapters configured');
  }

  const chat = new Chat({
    userName: 'assistant',
    adapters,
    state: createMemoryState(),
    logger: 'info',
  });

  // ThreadImpl.fromJSON resolves its adapter from the Chat singleton, both when
  // building the reply surface here and when /chat-callback rebuilds it.
  chat.registerSingleton();

  chat.onNewMention(async (thread, message) => {
    await replyToThread(env, thread, message, 'onNewMention');
  });

  chat.onDirectMessage(async (thread, message) => {
    await replyToThread(env, thread, message, 'onDirectMessage');
  });

  chat.onSlashCommand(async (event) => {
    if (event.user.isMe || event.user.isBot === true) {
      logger.log(`skip onSlashCommand isMe=${event.user.isMe} isBot=${event.user.isBot}`);
      return;
    }
    await respond({
      env,
      surface: replySurfaceOf(event.channel),
      text: event.text.trim() || event.command,
      platform: platformFromThreadId(event.channel.id),
      userId: event.user.userId,
      source: `onSlashCommand:${event.command}`,
    });
  });

  chat.onNewMessage(/.*/, async (thread, message) => {
    logger.log(
      `onNewMessage no mention/dm handler thread=${thread.id}` +
        ` isMention=${message.isMention} isBot=${message.author.isBot}` +
        ` user=${message.author.userId} text="${message.text.slice(0, 80)}"`,
    );
  });

  return chat;
}

export function getChatBot(env: BotEnv): ChatBot {
  const resolved = resolveBotEnv(env);
  const fingerprint = envFingerprint(resolved);
  if (bot && cachedFingerprint === fingerprint) {
    return bot;
  }

  bot = createBot(resolved);
  cachedFingerprint = fingerprint;
  return bot;
}

