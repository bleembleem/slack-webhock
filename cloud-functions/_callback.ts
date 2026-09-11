/**
 * Async agent callback — private module (starts with _), not mapped as a route.
 *
 * Cloud Functions are killed at 120s, so an IM webhook cannot wait for a slow
 * agent run. It posts a placeholder, hands the agent everything needed to find
 * that message again, and returns. The agent POSTs its answer to
 * /chat-callback, which edits the placeholder in place.
 *
 *   POST /discord ──► post placeholder ──► POST /chat (does not wait)
 *                                              │
 *                     edit placeholder ◄── POST /chat-callback
 *
 * `CallbackTarget` is deliberately platform-agnostic. `channelIdFromThreadId`
 * and `editMessage` are required members of the Chat SDK Adapter interface, so
 * Telegram, Feishu and WeCom go through this same path once their adapters are
 * registered — nothing here needs to know which platform it is holding.
 */

import { timingSafeEqual } from 'node:crypto';
import type { SerializedMessage, SerializedThread } from 'chat';

export type CallbackEnv = {
  AGENT_CALLBACK_SECRET?: string;
};

/** Where an answer should land. Opaque to the agent; only /chat-callback reads it. */
export type CallbackTarget = {
  /**
   * The reply surface, not necessarily the thread the message arrived in — its
   * id is what `post` and `edit` act on, so it already encodes the adapter's
   * `replySurface` choice.
   */
  thread: SerializedThread;
  /** The placeholder to edit, from `SentMessage.toJSON()`. */
  message: SerializedMessage;
};

/** What the webhook tells the agent about reporting back. */
export type AgentCallback = {
  url: string;
  token: string;
  target: CallbackTarget;
};

/** Body of POST /chat-callback. */
export type CallbackRequest = {
  target: CallbackTarget;
  text: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export function resolveCallbackEnv(env: CallbackEnv): CallbackEnv {
  return { AGENT_CALLBACK_SECRET: callbackSecret(env) };
}

/**
 * /chat-callback can make the bot speak in any channel it can reach, so it
 * authenticates every request against this. Replies fail without it.
 */
export function callbackSecret(env: CallbackEnv): string {
  return normalizeSecret(env.AGENT_CALLBACK_SECRET || process.env.AGENT_CALLBACK_SECRET);
}

export function isCallbackAuthorized(header: string | null, secret: string): boolean {
  const provided = Buffer.from(normalizeSecret(header ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
