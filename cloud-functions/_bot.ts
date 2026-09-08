/**
 * Chat SDK bot — private module (starts with _), not mapped as a route.
 *
 * One Chat instance, pluggable adapters. Handlers are platform-agnostic.
 * Register vendors in `_adapters/` (add `<name>.ts` and wire it in
 * `_adapters/index.ts`). Vendor routes (POST /slack, POST /discord, …)
 * dispatch through `_process.ts`. Slack acks immediately; Discord Interactions
 * return Chat SDK's PONG/DEFERRED. Regular Discord messages need GET /discord/gateway.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. cloud-functions/_adapters/<name>.ts and wire create / resolveEnv / fingerprint
 *   3. cloud-functions/<name>/index.ts with createVendorWebhook
 *   Discord also needs cloud-functions/discord/gateway (Gateway WebSocket).
 *
 * Memory state adapter keeps subscriptions/locks in-process (lost on restart).
 * /chat already emits SSE text_delta; we adapt that iterable into post().
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Chat, type Message, type SentMessage, type Thread } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import {
  buildAdapters,
  envFingerprint,
  resolveBotEnv,
  type BotEnv,
  type ChatAdapters,
} from './_adapters';
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

async function* sseTextDeltas(res: Response): AsyncIterable<string> {
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      let eventType = '';
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (eventType !== 'text_delta' || !data) continue;
      try {
        const parsed = JSON.parse(data) as { delta?: unknown };
        if (typeof parsed.delta === 'string' && parsed.delta) yield parsed.delta;
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

async function* withFallback(source: AsyncIterable<string>): AsyncIterable<string> {
  let any = false;
  for await (const chunk of source) {
    any = true;
    yield chunk;
  }
  if (!any) yield '(empty response)';
}

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

async function streamAgent(opts: {
  origin: string;
  message: string;
  platform: string;
  userId: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<AsyncIterable<string>> {
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
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  return withFallback(sseTextDeltas(res));
}

const CHANNEL_THINKING = 'Thinking…';
const CHANNEL_STREAM_EDIT_MS = 500;

async function editChannelStream(
  posted: SentMessage,
  source: AsyncIterable<string>,
): Promise<void> {
  let text = '';
  let lastPosted = CHANNEL_THINKING;
  let lastEditAt = 0;

  const flush = async (force: boolean) => {
    if (!text || text === lastPosted) return;
    if (!force && Date.now() - lastEditAt < CHANNEL_STREAM_EDIT_MS) return;
    await posted.edit({ markdown: text });
    lastPosted = text;
    lastEditAt = Date.now();
  };

  for await (const chunk of source) {
    text += chunk;
    await flush(false);
  }
  await flush(true);
}

async function streamToChannel(opts: {
  post: (text: string) => Promise<SentMessage>;
  text: string;
  platform: string;
  userId: string;
  conversationId: string;
  signal?: AbortSignal;
  source: string;
}): Promise<void> {
  const origin = requestContext.getStore()?.origin;
  if (!origin) {
    logger.error('missing request origin; cannot call /chat');
    await opts.post('Sorry, I could not complete that request.');
    return;
  }

  logger.log(
    `${opts.source} platform=${opts.platform} conversation=${opts.conversationId} user=${opts.userId} text="${opts.text.slice(0, 50)}"`,
  );

  let placeholder: SentMessage | undefined;
  try {
    placeholder = await opts.post(CHANNEL_THINKING);
    const stream = await streamAgent({
      origin,
      message: opts.text,
      platform: opts.platform,
      userId: `${opts.platform}:${opts.userId}`,
      conversationId: opts.conversationId,
      signal: opts.signal,
    });
    await editChannelStream(placeholder, stream);
    logger.log(`${opts.source} posted channel message conversation=${opts.conversationId}`);
  } catch (e) {
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    logger.error(`failed to handle thread: ${detail}`);
    try {
      if (placeholder) {
        await placeholder.edit('Sorry, I could not complete that request.');
      } else {
        await opts.post('Sorry, I could not complete that request.');
      }
    } catch (postErr) {
      const postDetail = postErr instanceof Error ? postErr.message : String(postErr);
      logger.error(`failed to post error reply: ${postDetail}`);
    }
  }
}

async function replyToThread(thread: Thread, message: Message, source: string): Promise<void> {
  if (message.author.isMe || message.author.isBot === true) {
    logger.log(
      `skip ${source} thread=${thread.id} isMe=${message.author.isMe} isBot=${message.author.isBot}`,
    );
    return;
  }

  await streamToChannel({
    post: (text) => thread.channel.post(text),
    text: message.text.trim() || '(The user sent a message with no text.)',
    platform: platformFromThreadId(thread.id),
    userId: message.author.userId,
    conversationId: thread.id,
    signal: thread.signal,
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

  chat.onNewMention(async (thread, message) => {
    await replyToThread(thread, message, 'onNewMention');
  });

  chat.onDirectMessage(async (thread, message) => {
    await replyToThread(thread, message, 'onDirectMessage');
  });

  chat.onSlashCommand(async (event) => {
    if (event.user.isMe || event.user.isBot === true) {
      logger.log(`skip onSlashCommand isMe=${event.user.isMe} isBot=${event.user.isBot}`);
      return;
    }
    const text = event.text.trim() || event.command;
    await streamToChannel({
      post: (markdown) => event.channel.post(markdown),
      text,
      platform: platformFromThreadId(event.channel.id),
      userId: event.user.userId,
      conversationId: event.channel.id,
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

