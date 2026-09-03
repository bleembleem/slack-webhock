/**
 * Slack webhook ack — EdgeOne Makers Edge Function
 * ================================================
 *
 * File path edge-functions/slack-webhook/index.ts maps to
 * **POST /slack-webhook**.
 *
 * Point Slack's Events API Request URL here. This function only verifies
 * the signature, answers url_verification, and returns 200. Real events are
 * forwarded to POST /slack-process (Cloud Function + Chat SDK) via waitUntil.
 *
 * Env:
 *   SLACK_SIGNING_SECRET  required — HMAC key from Slack app credentials
 */

import { createLogger } from '../_logger';
import {
  header,
  normalizeSecret,
  readRawBody,
  verifySlackSignature,
} from '../_slack';

const logger = createLogger('slack-webhook');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

const FORWARD_HEADERS = [
  'content-type',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'x-slack-retry-num',
  'x-slack-retry-reason',
] as const;

/** Edge runtime context. Avoid npm imports in edge-functions. */
interface EdgeFunctionContext {
  request: Request;
  env: Record<string, string | undefined>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function emptyOk(): Response {
  return new Response('ok', { status: 200 });
}

function requestOrigin(request: Request): string {
  try {
    const origin = new URL(request.url).origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    /* relative or invalid URL */
  }
  const host = request.headers.get('eo-pages-host') || request.headers.get('host') || '';
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  return host ? `${proto}://${host}` : '';
}

function isUrlVerification(rawBody: string): { ok: true; challenge: string } | { ok: false } {
  try {
    const payload = JSON.parse(rawBody) as { type?: unknown; challenge?: unknown };
    if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { ok: true, challenge: payload.challenge };
    }
  } catch {
    /* not JSON */
  }
  return { ok: false };
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return headers;
}

async function forwardToProcess(origin: string, request: Request, rawBody: string): Promise<void> {
  const url = `${origin}/slack-process`;
  logger.log(`forwarding event to ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: forwardHeaders(request),
    body: rawBody,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`slack-process HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

export async function onRequestPost(context: EdgeFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[slack-webhook] start: ${new Date(startTime).toISOString()}`);

  const request = context.request;
  const signingSecret = normalizeSecret(context.env.SLACK_SIGNING_SECRET);
  if (!signingSecret) {
    logger.error('SLACK_SIGNING_SECRET is not configured');
    return jsonResponse({ status: 'error', message: 'slack signing secret is not configured' }, 500);
  }

  const rawBody = await readRawBody(request);
  const verified = await verifySlackSignature({
    signingSecret,
    signature: header(request, 'x-slack-signature'),
    timestamp: header(request, 'x-slack-request-timestamp'),
    rawBody,
  });

  if (!verified.ok) {
    logger.error('slack request verification failed:', verified.reason);
    logger.log(`[slack-webhook] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'unauthorized' }, 401);
  }

  const challenge = isUrlVerification(rawBody);
  if (challenge.ok) {
    logger.log('url_verification challenge received');
    logger.log(`[slack-webhook] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ challenge: challenge.challenge });
  }

  const origin = requestOrigin(request);
  if (!origin) {
    logger.error('could not resolve request origin for slack-process');
    return jsonResponse({ status: 'error', message: 'missing origin' }, 500);
  }

  const waitUntil =
    typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
  const mode = waitUntil ? 'waitUntil' : 'await';
  logger.log(`background mode: ${mode}`);

  const task = forwardToProcess(origin, request, rawBody).catch((e) => {
    logger.error('failed to forward Slack event to slack-process:', e);
  });

  if (waitUntil) {
    logger.log('dispatch slack-process via waitUntil');
    waitUntil(task);
  } else {
    logger.log('await slack-process before responding');
    await task;
  }

  logger.log(`[slack-webhook] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms, mode=${mode}`);
  return emptyOk();
}
