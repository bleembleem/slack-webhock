/**
 * Shared Chat SDK webhook runner — private module, not mapped as a route.
 *
 * POST /chat-process reads x-chat-adapter, then runChatWebhook({ adapter }).
 * Signature verification happens inside bot.webhooks.<adapter>.
 *
 * Edge forwards the vendor body as text/plain (see x-chat-content-type) so this
 * runtime does not JSON-parse it. HMAC needs the exact Slack bytes.
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';
import { getChatBot, requestContext, type ChatBot } from './_bot';
import { createLogger } from './_logger';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;
const CHAT_CONTENT_TYPE_HEADER = 'x-chat-content-type';

const SKIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
]);

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function bodyKind(body: unknown): string {
  if (typeof body === 'string') return 'string';
  if (body instanceof ArrayBuffer) return 'arraybuffer';
  if (body instanceof Uint8Array) return 'uint8array';
  if (body && typeof body === 'object') return Array.isArray(body) ? 'array' : 'object';
  return body == null ? 'empty' : typeof body;
}

const FALLBACK_HEADERS = [
  'content-type',
  'x-chat-adapter',
  'x-chat-content-type',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'x-slack-retry-num',
  'x-slack-retry-reason',
] as const;

async function readRawBody(request: EdgeoneRequest): Promise<string> {
  const resolved = await Promise.resolve(request.body);
  // text/plain hop: runtime may already expose the original bytes as a string.
  if (typeof resolved === 'string') return resolved;

  const asRequest = request as unknown as Request;
  if (typeof asRequest.text === 'function') {
    try {
      return await asRequest.text();
    } catch {
      // Stream already consumed by the runtime's body parser.
    }
  }

  if (resolved instanceof ArrayBuffer) return new TextDecoder().decode(resolved);
  if (resolved instanceof Uint8Array) return new TextDecoder().decode(resolved);
  // Do not JSON.stringify a parsed object — that changes bytes and HMAC fails.
  return '';
}

function copyWebhookHeaders(request: EdgeoneRequest): Headers {
  const headers = new Headers();
  const src = request.headers;
  if (src && typeof src.forEach === 'function') {
    src.forEach((value, key) => {
      if (!SKIP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
  }
  for (const name of FALLBACK_HEADERS) {
    if (headers.has(name)) continue;
    const value = src.get(name);
    if (value) headers.set(name, value);
  }

  const originalContentType = headers.get(CHAT_CONTENT_TYPE_HEADER);
  if (originalContentType) {
    headers.set('content-type', originalContentType);
    headers.delete(CHAT_CONTENT_TYPE_HEADER);
  }
  return headers;
}

function toStandardRequest(request: EdgeoneRequest, rawBody: string): Request {
  return new Request(request.url, {
    method: request.method || 'POST',
    headers: copyWebhookHeaders(request),
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
  const incomingKind = bodyKind(request.body);
  const rawBody = await readRawBody(request);
  const webRequest = toStandardRequest(request, rawBody);
  const origin = requestOrigin(request);
  logger.log(
    `origin=${origin} request.url=${request.url} body_len=${rawBody.length} body_kind=${incomingKind}` +
      ` sig=${Boolean(webRequest.headers.get('x-slack-signature'))}` +
      ` ts=${Boolean(webRequest.headers.get('x-slack-request-timestamp'))}` +
      ` ct=${webRequest.headers.get('content-type') || ''}`,
  );
  if (!rawBody) {
    logger.error('empty webhook body; Chat SDK HMAC will fail');
  }
  const pending: Promise<unknown>[] = [];

  try {
    const response = await requestContext.run({ origin }, () =>
      dispatchWebhook(bot, opts.adapter, webRequest, (task) => {
        pending.push(Promise.resolve(task));
      }),
    );

    if (!response.ok) {
      const detail = await response.clone().text().catch(() => '');
      logger.error(`chat webhook HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

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
