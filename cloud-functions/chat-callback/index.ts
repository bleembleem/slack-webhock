/**
 * Agent callback sink — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/chat-callback/index.ts maps to **POST /chat-callback**.
 *
 * An IM webhook hands the run to /chat without waiting. The agent POSTs the
 * finished answer here. Platforms that posted a "Thinking…" placeholder send
 * that message in `target.message` and this route edits it; the rest get a
 * new `thread.post`. DingTalk prefers `target.replyUrl` (sessionWebhook).
 * See _callback.ts for the contract.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { Message, ThreadImpl } from 'chat';
import { vendorAdapter } from '../_adapters';
import { getChatBot } from '../_bot';
import { callbackSecret, isCallbackAuthorized, type CallbackRequest } from '../_callback';
import { createLogger } from '../_logger';

const logger = createLogger('chat-callback');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function sanitizeCallbackError(detail: string): string {
  const redacted = detail
    .replace(/access_token=[^&\s"'\\]+/gi, 'access_token=***')
    .replace(/corpsecret=[^&\s"'\\]+/gi, 'corpsecret=***');
  const ip = redacted.match(/from ip:\s*([\d.]+)/i)?.[1];
  if (/errcode=60020|not allow to access from your ip/i.test(redacted)) {
    return (
      `WeCom 60020: message/send blocked from ${ip ?? 'this function\'s egress IP'}. ` +
      `Add that IP under 应用管理 → 该应用 → 企业可信IP. EdgeOne egress IPs can change.`
    );
  }
  return redacted.slice(0, 300);
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[chat-callback] start: ${new Date(startTime).toISOString()}`);

  try {
    const secret = callbackSecret(context.env);
    if (!secret) {
      logger.error('AGENT_CALLBACK_SECRET is not configured');
      return jsonResponse({ status: 'error', message: 'callback secret is not configured' }, 500);
    }
    if (!isCallbackAuthorized(context.request!.headers.get('authorization'), secret)) {
      logger.error('rejected callback with a bad bearer token');
      return jsonResponse({ status: 'error', message: 'unauthorized' }, 401);
    }

    const { target, text } = (await context.request!.json()) as CallbackRequest;
    logger.log(
      `thread=${target.thread.id} message=${target.message?.id ?? 'none'}` +
        ` replyUrl=${target.replyUrl ? 'yes' : 'no'} len=${text.length}`,
    );

    const platform = target.thread.id.split(':')[0] ?? '';
    const vendor = vendorAdapter(platform);
    if (target.replyUrl && vendor?.postReplyUrl) {
      try {
        await vendor.postReplyUrl(target.replyUrl, text);
        logger.log(`[chat-callback] done via replyUrl: total ${Date.now() - startTime}ms`);
        return jsonResponse({ status: 'ok' });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        logger.error(`replyUrl failed, falling back to adapter post: ${detail}`);
      }
    }

    // Builds the Chat singleton that ThreadImpl.fromJSON resolves its adapter from.
    getChatBot(context.env);

    const thread = ThreadImpl.fromJSON(target.thread);
    if (target.message) {
      const placeholder = thread.createSentMessageFromMessage(Message.fromJSON(target.message));
      await placeholder.edit({ markdown: text });
    } else {
      await thread.post({ markdown: text });
    }

    logger.log(`[chat-callback] done: total ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'ok' });
  } catch (e) {
    const detail = e instanceof Error ? e.stack || e.message : String(e);
    logger.error(`unhandled chat-callback error: ${sanitizeCallbackError(detail)}`);
    return jsonResponse({ status: 'error', message: sanitizeCallbackError(detail) }, 500);
  }
}
