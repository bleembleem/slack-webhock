/**
 * Chat SDK bot — private module (starts with _), not mapped as a route.
 *
 * Slack adapter verifies signatures and parses Events API payloads.
 * Memory state adapter keeps subscriptions/locks in-process (lost on restart).
 *
 * Chat SDK does not return HTTP SSE from the webhook. It accepts
 * AsyncIterable<string> on thread.post() and streams into Slack via
 * chat.startStream / appendStream (or post+edit fallback).
 * /chat already emits SSE text_delta; we adapt that iterable into post().
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Chat, type Message, type Thread } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createMemoryState } from '@chat-adapter/state-memory';
import { createLogger } from './_logger';

const logger = createLogger('slack-bot');

export type SlackEnv = {
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
};

type RequestScope = {
  origin: string;
};

export const slackRequestContext = new AsyncLocalStorage<RequestScope>();

type SlackBot = Chat<{ slack: ReturnType<typeof createSlackAdapter> }>;

let bot: SlackBot | undefined;
let cachedToken = '';
let cachedSigningSecret = '';

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
 * Slack thread ids contain `:` and are not valid Makers conversation ids.
 */
function uuidFromSeed(seed: string): string {
  const chars = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function streamAgent(opts: {
  origin: string;
  message: string;
  userId: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<AsyncIterable<string>> {
  const conversationId = uuidFromSeed(`slack-thread:${opts.conversationId}`);
  const userId = uuidFromSeed(`slack-user:${opts.userId}`);
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
        'Mozilla/5.0 (compatible; SlackWebhookAgent/1.0; +https://slack-webhock.edgeone.dev/)',
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
  const origin = slackRequestContext.getStore()?.origin;
  if (!origin) {
    logger.error('missing request origin; cannot call /chat');
    await thread.channel.post('Sorry, I could not complete that request.');
    return;
  }

  logger.log(
    `${source} thread=${thread.id} user=${message.author.userId} text="${text.slice(0, 50)}"`,
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
      userId: `slack:${message.author.userId}`,
      conversationId: thread.id,
      signal: thread.signal,
    });
    await thread.channel.post(stream);
    logger.log(`${source} posted new channel message thread=${thread.id}`);
  } catch (e) {
    logger.error('failed to handle Slack thread:', e);
    try {
      await thread.channel.post('Sorry, I could not complete that request.');
    } catch (postErr) {
      logger.error('failed to post Slack error reply:', postErr);
    }
  }
}

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function isSlackBotToken(value: string): boolean {
  return value.startsWith('xoxb-') && value.length > 20;
}

function createBot(env: SlackEnv): SlackBot {
  const chat = new Chat({
    userName: 'assistant',
    adapters: {
      slack: createSlackAdapter({
        botToken: env.SLACK_BOT_TOKEN,
        signingSecret: env.SLACK_SIGNING_SECRET,
        nativeStreaming: true,
      }),
    },
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

export { isSlackBotToken, normalizeSecret };

export function getSlackBot(env: SlackEnv): SlackBot {
  const botToken = normalizeSecret(env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN);
  const signingSecret = normalizeSecret(
    env.SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET,
  );

  if (bot && cachedToken === botToken && cachedSigningSecret === signingSecret) {
    return bot;
  }

  bot = createBot({
    SLACK_BOT_TOKEN: isSlackBotToken(botToken) ? botToken : undefined,
    SLACK_SIGNING_SECRET: signingSecret || undefined,
  });
  cachedToken = botToken;
  cachedSigningSecret = signingSecret;
  return bot;
}
