/**
 * Slack webhook handler — EdgeOne Makers Node Function
 * ====================================================
 *
 * File path cloud-functions/slack-webhook/index.ts maps to
 * **POST /slack-webhook**.
 *
 * Forwards the request to Vercel Chat SDK's Slack adapter, which verifies
 * the signing secret, answers `url_verification`, and routes events to
 * the handlers in `_bot.ts`.
 *
 * Env:
 *   SLACK_SIGNING_SECRET  required — HMAC key from Slack app credentials
 *   SLACK_BOT_TOKEN       required to reply — xoxb- Bot User OAuth Token
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';
import { createLogger } from '../_logger';
import { getSlackBot, isSlackBotToken, normalizeSecret, slackRequestContext } from '../_bot';

const logger = createLogger('slack-webhook');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Runtime EventContext exposes waitUntil; @edgeone/types CloudFunctionContext
 * does not declare it yet. EdgeOne uses it to keep background work alive after
 * the HTTP response is sent.
 */
function getWaitUntil(context: CloudFunctionContext): WaitUntil | undefined {
  const waitUntil = (context as CloudFunctionContext & { waitUntil?: WaitUntil }).waitUntil;
  return typeof waitUntil === 'function' ? waitUntil.bind(context) : undefined;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readRawBody(request: EdgeoneRequest): Promise<string> {
  const asRequest = request as unknown as Request;
  if (typeof asRequest.text === 'function') {
    try {
      return await asRequest.text();
    } catch {
      // Stream already consumed by the runtime's body parser.
    }
  }

  const resolved = await Promise.resolve(request.body);
  if (typeof resolved === 'string') return resolved;
  if (resolved instanceof ArrayBuffer) return new TextDecoder().decode(resolved);
  if (resolved instanceof Uint8Array) return new TextDecoder().decode(resolved);
  if (resolved && typeof resolved === 'object') {
    return JSON.stringify(resolved);
  }
  return '';
}

function isUrlVerification(rawBody: string): boolean {
  try {
    const payload = JSON.parse(rawBody) as { type?: unknown };
    return payload?.type === 'url_verification';
  } catch {
    return false;
  }
}

function toStandardRequest(request: EdgeoneRequest, rawBody: string): Request {
  return new Request(request.url, {
    method: request.method || 'POST',
    headers: request.headers,
    body: rawBody,
  });
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[slack-webhook] start: ${new Date(startTime).toISOString()}`);

  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  const signingSecret = normalizeSecret(context.env.SLACK_SIGNING_SECRET);
  const botToken = normalizeSecret(context.env.SLACK_BOT_TOKEN);
  if (!signingSecret) {
    logger.error('SLACK_SIGNING_SECRET is not configured');
    return jsonResponse({ status: 'error', message: 'slack signing secret is not configured' }, 500);
  }

  const rawBody = await readRawBody(request);
  const challenge = isUrlVerification(rawBody);
  const botTokenValid = isSlackBotToken(botToken);
  logger.log(
    `SLACK_BOT_TOKEN present=${Boolean(botToken)} format=${botTokenValid ? 'xoxb' : 'invalid'} challenge=${challenge}`,
  );

  if (!challenge && !botTokenValid) {
    logger.error(
      'SLACK_BOT_TOKEN must be the Bot User OAuth Token from Slack app → OAuth & Permissions. It starts with xoxb-.',
    );
    return jsonResponse({
      status: 'error',
      message: 'SLACK_BOT_TOKEN is invalid. Use the Bot User OAuth Token (xoxb-...), not the Client Secret or Signing Secret.',
    }, 500);
  }

  const bot = getSlackBot({
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_BOT_TOKEN: botTokenValid ? botToken : undefined,
  });

  const webRequest = toStandardRequest(request, rawBody);
  const origin = new URL(request.url).origin;
  const waitUntil = getWaitUntil(context);
  const mode = waitUntil ? 'waitUntil' : 'await';
  const pending: Promise<unknown>[] = [];
  logger.log(`background mode: ${mode}`);

  try {
    const response = await slackRequestContext.run({ origin }, () =>
      bot.webhooks.slack(webRequest, {
        waitUntil: (task) => {
          const promise = Promise.resolve(task);
          if (waitUntil) {
            logger.log('dispatch handler via waitUntil');
            waitUntil(promise);
            return;
          }
          logger.log('queue handler for await');
          pending.push(promise);
        },
      }),
    );

    // Runtime waitUntil keeps work alive after this return. If it is absent
    // (older local types/runtime), fall back to awaiting so replies still send.
    if (!waitUntil && pending.length > 0) {
      logger.log(`await ${pending.length} pending handler(s) before responding`);
      await Promise.all(pending);
    }

    logger.log(`[slack-webhook] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms, mode=${mode}`);
    return response;
  } catch (e) {
    logger.error('unhandled slack webhook error:', e);
    logger.log(`[slack-webhook] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'internal error' }, 500);
  }
}
