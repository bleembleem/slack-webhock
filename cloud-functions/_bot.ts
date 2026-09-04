/**
 * Chat SDK bot — private module (starts with _), not mapped as a route.
 *
 * One Chat instance, pluggable adapters. Handlers are platform-agnostic.
 * Register vendors in `_adapters/` (add `<name>.ts` and wire it in
 * `_adapters/index.ts`). Adapters verify signatures in POST /chat-process
 * (bot.webhooks.<name>); the edge function only classifies handshake vs
 * event and forwards the raw body + signature headers.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. edge-functions/_adapters/<name>.ts + edge-functions/<name>/index.ts
 *   3. cloud-functions/_adapters/<name>.ts and wire create / resolveEnv / fingerprint
 *
 * Memory state adapter keeps subscriptions/locks in-process (lost on restart).
 * /chat already emits SSE text_delta; we adapt that iterable into post().
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Chat, type Message, type Thread } from 'chat';
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

async function replyToThread(thread: Thread, message: Message, source: string): Promise<void> {
  if (message.author.isMe || message.author.isBot === true) {
    logger.log(
      `skip ${source} thread=${thread.id} isMe=${message.author.isMe} isBot=${message.author.isBot}`,
    );
    return;
  }

  const text = message.text.trim() || '(The user sent a message with no text.)';
  const origin = requestContext.getStore()?.origin;
  if (!origin) {
    logger.error('missing request origin; cannot call /chat');
    await thread.channel.post('Sorry, I could not complete that request.');
    return;
  }

  const platform = platformFromThreadId(thread.id);
  logger.log(
    `${source} platform=${platform} thread=${thread.id} user=${message.author.userId} text="${text.slice(0, 50)}"`,
  );

  try {
    await thread.startTyping?.('Thinking…');
  } catch (e) {
    logger.log('startTyping failed:', e);
  }

  try {
    const stream = await streamAgent({
      origin,
      message: text,
      platform,
      userId: `${platform}:${message.author.userId}`,
      conversationId: thread.id,
      signal: thread.signal,
    });
    await thread.channel.post(stream);
    logger.log(`${source} posted new channel message thread=${thread.id}`);
  } catch (e) {
    logger.error('failed to handle thread:', e);
    try {
      await thread.channel.post('Sorry, I could not complete that request.');
    } catch (postErr) {
      logger.error('failed to post error reply:', postErr);
    }
  }
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
    await thread.subscribe();
    await replyToThread(thread, message, 'onNewMention');
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await replyToThread(thread, message, 'onDirectMessage');
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await replyToThread(thread, message, 'onSubscribedMessage');
  });

  // Channel messages that are not a mention and not in a subscribed thread.
  chat.onNewMessage(/^/, async (thread, message) => {
    await replyToThread(thread, message, 'onNewMessage');
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
