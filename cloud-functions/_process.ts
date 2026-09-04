/**
 * Shared Chat SDK webhook runner — private module, not mapped as a route.
 *
 * POST /chat-process reads x-chat-adapter, then runChatWebhook({ adapter }).
 * Signature verification happens inside bot.webhooks.<adapter>.
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';
import { getChatBot, requestContext, type ChatBot } from './_bot';
import { createLogger } from './_logger';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export function jsonResponse(data: unknown, status = 200): Response {
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

type WebhookHandler = (
  request: Request,
  options?: { waitUntil?: (task: Promise<unknown>) => void },
) => Promise<Response>;

function dispatchWebhook(bot: ChatBot, adapter: string, request: Request, waitUntil: (task: Promise<unknown>) => void): Promise<Response> {
  const webhooks = bot.webhooks as unknown as Record<string, WebhookHandler | undefined>;
  const handler = webhooks[adapter];
  if (typeof handler !== 'function') {
    throw new Error(`chat adapter "${adapter}" is not registered`);
  }
  return handler(request, { waitUntil });
}

export type RunChatWebhookOptions = {
  adapter: string;
  assertEnv: (env: Record<string, string | undefined>) => Response | void;
};

export async function runChatWebhook(
  context: CloudFunctionContext,
  opts: RunChatWebhookOptions,
): Promise<Response> {
  const tag = `${opts.adapter}-process`;
  const logger = createLogger(tag);
  const startTime = Date.now();
  logger.log(`[${tag}] start: ${new Date(startTime).toISOString()}`);

  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  const envError = opts.assertEnv(context.env);
  if (envError) return envError;

  const bot = getChatBot(context.env);
  const rawBody = await readRawBody(request);
  const webRequest = toStandardRequest(request, rawBody);
  const origin = requestOrigin(request);
  logger.log(`origin=${origin} request.url=${request.url}`);
  const pending: Promise<unknown>[] = [];

  try {
    const response = await requestContext.run({ origin }, () =>
      dispatchWebhook(bot, opts.adapter, webRequest, (task) => {
        pending.push(Promise.resolve(task));
      }),
    );

    if (pending.length > 0) {
      logger.log(`await ${pending.length} Chat SDK handler(s) until post finishes`);
      await Promise.all(pending);
    }

    logger.log(`[${tag}] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return response;
  } catch (e) {
    logger.error(`unhandled ${tag} error:`, e);
    logger.log(`[${tag}] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'internal error' }, 500);
  }
}
