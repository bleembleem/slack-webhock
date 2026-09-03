/**
 * Slack event processor — EdgeOne Makers Node Function
 * ====================================================
 *
 * File path cloud-functions/slack-process/index.ts maps to
 * **POST /slack-process**.
 *
 * Not the Slack Request URL. Edge Function POST /slack-webhook verifies
 * the signature, returns 200 to Slack, then waitUntil-forwards the original
 * body here. Chat SDK runs on Node and can await /chat (up to ~120s).
 *
 * Env:
 *   SLACK_SIGNING_SECRET  required — HMAC key from Slack app credentials
 *   SLACK_BOT_TOKEN       required to reply — xoxb- Bot User OAuth Token
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';
import { createLogger } from '../_logger';
import { getSlackBot, isSlackBotToken, normalizeSecret, slackRequestContext } from '../_bot';

const logger = createLogger('slack-process');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

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

function toStandardRequest(request: EdgeoneRequest, rawBody: string): Request {
  return new Request(request.url, {
    method: request.method || 'POST',
    headers: request.headers,
    body: rawBody,
  });
}

function requestOrigin(request: EdgeoneRequest): string {
  const host = (
    request.headers.get('eo-pages-host') ||
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  )
    .split(',')[0]
    .trim();
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  if (host && !/tencentscf|localhost|127\.0\.0\.1/i.test(host)) {
    return `${proto}://${host}`;
  }
  try {
    const origin = new URL(request.url).origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    /* relative or invalid URL */
  }
  return host ? `${proto}://${host}` : '';
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[slack-process] start: ${new Date(startTime).toISOString()}`);

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

  const botTokenValid = isSlackBotToken(botToken);
  logger.log(`SLACK_BOT_TOKEN present=${Boolean(botToken)} format=${botTokenValid ? 'xoxb' : 'invalid'}`);
  if (!botTokenValid) {
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
    SLACK_BOT_TOKEN: botToken,
  });

  const rawBody = await readRawBody(request);
  const webRequest = toStandardRequest(request, rawBody);
  const origin = requestOrigin(request);
  logger.log(`origin=${origin} request.url=${request.url}`);
  const pending: Promise<unknown>[] = [];

  try {
    const response = await slackRequestContext.run({ origin }, () =>
      bot.webhooks.slack(webRequest, {
        waitUntil: (task) => {
          pending.push(Promise.resolve(task));
        },
      }),
    );

    if (pending.length > 0) {
      logger.log(`await ${pending.length} Chat SDK handler(s) until Slack post finishes`);
      await Promise.all(pending);
    }

    logger.log(`[slack-process] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return response;
  } catch (e) {
    logger.error('unhandled slack-process error:', e);
    logger.log(`[slack-process] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'internal error' }, 500);
  }
}
