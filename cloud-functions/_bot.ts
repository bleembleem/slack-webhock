/**
 * Chat SDK bot — private module (starts with _), not mapped as a route.
 *
 * Slack adapter verifies signatures and parses Events API payloads.
 * Memory state adapter keeps subscriptions/locks in-process (lost on restart).
 */

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

async function collectSseText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

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
        if (typeof parsed.delta === 'string') text += parsed.delta;
      } catch {
        /* ignore malformed frames */
      }
    }
  }

  return text.trim();
}

async function runAgent(opts: {
  origin: string;
  message: string;
  userId: string;
  conversationId: string;
}): Promise<string> {
  const res = await fetch(`${opts.origin}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'makers-conversation-id': opts.conversationId,
    },
    body: JSON.stringify({
      message: opts.message,
      userId: opts.userId,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`chat HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  return collectSseText(res);
}

async function replyToThread(thread: Thread, message: Message): Promise<void> {
  if (message.author.isMe || message.author.isBot === true) return;

  const text = message.text.trim();
  if (!text) return;

  const origin = slackRequestContext.getStore()?.origin;
  if (!origin) {
    logger.error('missing request origin; cannot call /chat');
    await thread.post('Sorry, I could not complete that request.');
    return;
  }

  logger.log(
    `thread=${thread.id} user=${message.author.userId} text="${text.slice(0, 50)}"`,
  );

  try {
    const reply = await runAgent({
      origin,
      message: text,
      userId: `slack:${message.author.userId}`,
      conversationId: thread.id,
    });
    await thread.post(reply || '(empty response)');
  } catch (e) {
    logger.error('failed to handle Slack thread:', e);
    try {
      await thread.post('Sorry, I could not complete that request.');
    } catch (postErr) {
      logger.error('failed to post Slack error reply:', postErr);
    }
  }
}

function createBot(env: SlackEnv): SlackBot {
  const chat = new Chat({
    userName: 'assistant',
    adapters: {
      slack: createSlackAdapter({
        botToken: env.SLACK_BOT_TOKEN,
        signingSecret: env.SLACK_SIGNING_SECRET,
      }),
    },
    state: createMemoryState(),
    logger: 'info',
  });

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await replyToThread(thread, message);
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await replyToThread(thread, message);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await replyToThread(thread, message);
  });

  return chat;
}

export function getSlackBot(env: SlackEnv): SlackBot {
  if (!bot) {
    bot = createBot({
      SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
      SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET,
    });
  }
  return bot;
}
