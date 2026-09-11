/**
 * Agent callback sink — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/chat-callback/index.ts maps to **POST /chat-callback**.
 *
 * An IM webhook posts a "Thinking…" placeholder and hands the run to /chat
 * without waiting. The agent POSTs the finished answer here, and this route
 * edits that placeholder in place. See _callback.ts for the contract.
 *
 * This makes the bot speak, so it requires AGENT_CALLBACK_SECRET as a bearer
 * token.
 *
 * Nothing here is platform-specific: the payload carries a Chat SDK
 * SerializedThread, and every adapter implements `editMessage`.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { Message, ThreadImpl } from 'chat';
import { getChatBot } from '../_bot';
import { callbackSecret, isCallbackAuthorized, type CallbackRequest } from '../_callback';
import { createLogger } from '../_logger';

const logger = createLogger('chat-callback');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[chat-callback] start: ${new Date(startTime).toISOString()}`);

  const secret = callbackSecret(context.env);
  if (!secret) throw new Error('AGENT_CALLBACK_SECRET is not configured');
  if (!isCallbackAuthorized(context.request!.headers.get('authorization'), secret)) {
    logger.error('rejected callback with a bad bearer token');
    return new Response(JSON.stringify({ status: 'error', message: 'unauthorized' }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  const { target, text } = (await context.request!.json()) as CallbackRequest;
  logger.log(`thread=${target.thread.id} message=${target.message.id} len=${text.length}`);

  // Builds the Chat singleton that ThreadImpl.fromJSON resolves its adapter from.
  getChatBot(context.env);

  const thread = ThreadImpl.fromJSON(target.thread);
  const placeholder = thread.createSentMessageFromMessage(Message.fromJSON(target.message));
  await placeholder.edit({ markdown: text });

  logger.log(`[chat-callback] done: total ${Date.now() - startTime}ms`);
  return new Response(JSON.stringify({ status: 'ok' }), { headers: JSON_HEADERS });
}
