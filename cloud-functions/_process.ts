/**
 * Shared Chat SDK webhook runner — private module, not mapped as a route.
 *
 * Vendor routes (e.g. POST /slack, POST /discord) call createVendorWebhook().
 * Slack events ack 200 and keep processing after return. Discord Interactions
 * return the Chat SDK response (PING PONG / slash DEFERRED) so Discord's
 * 3s window is met. Signature verification happens inside bot.webhooks.<adapter>.
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';
import type { VendorAdapter, VendorRespond } from './_adapters';
import { getChatBot, requestContext, type ChatBot } from './_bot';
import { createLogger } from './_logger';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

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

const FALLBACK_HEADERS = [
  'content-type',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'x-slack-retry-num',
  'x-slack-retry-reason',
  'x-signature-ed25519',
  'x-signature-timestamp',
  'x-discord-gateway-token',
] as const;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function emptyOk(): Response {
  return new Response('ok', { status: 200 });
}

function bodyKind(body: unknown): string {
  if (typeof body === 'string') return 'string';
  if (body instanceof ArrayBuffer) return 'arraybuffer';
  if (body instanceof Uint8Array) return 'uint8array';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return 'buffer';
  if (body && typeof body === 'object') return Array.isArray(body) ? 'array' : 'object';
  return body == null ? 'empty' : typeof body;
}

/**
 * Prefer original vendor bytes. Do not JSON.stringify a parsed object —
 * that changes bytes and Chat SDK HMAC fails.
 */
async function readRawBody(request: EdgeoneRequest): Promise<string> {
  const asRequest = request as unknown as Request & { rawBody?: unknown };
  if (typeof asRequest.rawBody === 'string' && asRequest.rawBody) {
    return asRequest.rawBody;
  }

  if (typeof asRequest.text === 'function') {
    try {
      const text = await asRequest.text();
      if (text) return text;
    } catch {
      /* stream already consumed by the runtime's body parser */
    }
  }

  const resolved = await Promise.resolve(request.body);
  if (typeof resolved === 'string') return resolved;
  if (resolved instanceof ArrayBuffer) return new TextDecoder().decode(resolved);
  if (resolved instanceof Uint8Array) return new TextDecoder().decode(resolved);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(resolved)) {
    return resolved.toString('utf8');
  }
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
  return headers;
}

function toStandardRequest(request: EdgeoneRequest, rawBody: string): Request {
  return new Request(request.url, {
    method: request.method || 'POST',
    headers: copyWebhookHeaders(request),
    body: rawBody,
  });
}

export function requestOrigin(request: EdgeoneRequest): string {
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

function dispatchWebhook(
  bot: ChatBot,
  adapter: string,
  request: Request,
  pending: Promise<unknown>[],
): Promise<Response> {
  const webhooks = bot.webhooks as unknown as Record<string, WebhookHandler | undefined>;
  const handler = webhooks[adapter];
  if (typeof handler !== 'function') {
    throw new Error(`chat adapter "${adapter}" is not registered`);
  }
  // Chat SDK schedules handlers via waitUntil. Collect them so requestContext
  // (origin) stays alive for the agent run after handleWebhook returns.
  return handler(request, {
    waitUntil: (task) => {
      pending.push(Promise.resolve(task));
    },
  });
}

export type RunChatWebhookOptions = {
  adapter: string;
  assertEnv: (env: Record<string, string | undefined>) => Response | void;
  handshake?: VendorAdapter['handshake'];
  summarize?: VendorAdapter['summarize'];
  respond?: VendorAdapter['respond'];
};

export async function runChatWebhook(
  context: CloudFunctionContext,
  opts: RunChatWebhookOptions,
): Promise<Response> {
  const tag = opts.adapter;
  const logger = createLogger(tag);
  const startTime = Date.now();
  logger.log(`[${tag}] start: ${new Date(startTime).toISOString()}`);

  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  const rawBody = await readRawBody(request);
  const incomingKind = bodyKind(request.body);
  logger.log(opts.summarize?.(rawBody, request) ?? `body_kind=${incomingKind} body_len=${rawBody.length}`);

  const handshake = opts.handshake?.(rawBody, request.body);
  if (handshake) {
    logger.log('handshake reply');
    return handshake;
  }

  const envError = opts.assertEnv(context.env);
  if (envError) return envError;

  const webRequest = toStandardRequest(request, rawBody);
  const origin = requestOrigin(request);
  const env = context.env;
  const respond: VendorRespond = opts.respond?.(rawBody, webRequest) ?? 'ack';
  const hasVendorSig = Boolean(
    webRequest.headers.get('x-slack-signature') ||
      webRequest.headers.get('x-signature-ed25519') ||
      webRequest.headers.get('x-discord-gateway-token'),
  );
  logger.log(
    `origin=${origin} request.url=${request.url} body_len=${rawBody.length} body_kind=${incomingKind}` +
      ` respond=${respond} sig=${hasVendorSig ? 'yes' : 'no'}` +
      ` ct=${webRequest.headers.get('content-type') || ''}`,
  );
  if (!rawBody) {
    logger.error('empty webhook body; Chat SDK verification will fail');
    return jsonResponse({ status: 'error', message: 'missing raw webhook body' }, 500);
  }

  let settle!: (response: Response) => void;
  let fail!: (error: unknown) => void;
  let settled = false;
  const firstResponse = new Promise<Response>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const work = requestContext.run({ origin }, async () => {
    const pending: Promise<unknown>[] = [];
    try {
      const bot = getChatBot(env);
      const response = await dispatchWebhook(bot, opts.adapter, webRequest, pending);
      settled = true;
      settle(response);
      if (!response.ok) {
        const detail = await response.clone().text().catch(() => '');
        logger.error(`chat webhook HTTP ${response.status}: ${detail.slice(0, 200)}`);
      }
      await Promise.allSettled(pending);
      logger.log(`[${tag}] process done: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
      return response;
    } catch (e) {
      logger.error(`unhandled ${tag} error:`, e);
      logger.log(`[${tag}] process done: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
      if (!settled) fail(e);
      throw e;
    }
  });

  if (respond === 'sdk') {
    try {
      const response = await firstResponse;
      void work.then(
        () => undefined,
        () => undefined,
      );
      logger.log(`[${tag}] sdk reply elapsed=${Date.now() - startTime}ms status=${response.status}`);
      return response;
    } catch {
      return jsonResponse({ status: 'error', message: `unhandled ${tag} error` }, 500);
    }
  }

  void work.then(
    () => undefined,
    () => undefined,
  );
  logger.log(`[${tag}] ack elapsed=${Date.now() - startTime}ms`);
  return emptyOk();
}

export function createVendorWebhook(adapter: VendorAdapter) {
  return function onRequestPost(context: CloudFunctionContext): Promise<Response> {
    return runChatWebhook(context, {
      adapter: adapter.name,
      assertEnv: adapter.assertEnv,
      handshake: adapter.handshake,
      summarize: adapter.summarize,
      respond: adapter.respond,
    });
  };
}
