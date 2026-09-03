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
 * Edge console.log is not reported; lines are flushed to POST /debug-log.
 *
 * Env:
 *   SLACK_SIGNING_SECRET  required — HMAC key from Slack app credentials
 */

import { createLogger, type EdgeLogger } from '../_logger';
import {
  header,
  normalizeSecret,
  readRawBody,
  verifySlackSignature,
} from '../_slack';

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

function slackEventSummary(rawBody: string): string {
  try {
    const payload = JSON.parse(rawBody) as {
      type?: unknown;
      event_id?: unknown;
      event?: { type?: unknown };
    };
    const type = typeof payload.type === 'string' ? payload.type : '';
    const eventType = typeof payload.event?.type === 'string' ? payload.event.type : '';
    const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
    return `type=${type} event=${eventType} event_id=${eventId} body_len=${rawBody.length}`;
  } catch {
    return `type=unparsed body_len=${rawBody.length}`;
  }
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

async function forwardToProcess(
  origin: string,
  request: Request,
  rawBody: string,
  logger: EdgeLogger,
): Promise<void> {
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
  logger.log(`slack-process HTTP ${res.status}`);
}

const WATCHDOG_FLUSH_MS = 2000;

export async function onRequestPost(context: EdgeFunctionContext): Promise<Response> {
  const startTime = Date.now();
  const request = context.request;
  const origin = requestOrigin(request);
  const waitUntil =
    typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
  const logger = createLogger(
    'slack-webhook',
    origin ? { origin, waitUntil } : undefined,
  );

  let background: Promise<void> | undefined;

  try {
    logger.log(`[slack-webhook] start: ${new Date(startTime).toISOString()}`);

    const signingSecret = normalizeSecret(context.env.SLACK_SIGNING_SECRET);
    if (!signingSecret) {
      logger.error('SLACK_SIGNING_SECRET is not configured');
      return jsonResponse({ status: 'error', message: 'slack signing secret is not configured' }, 500);
    }

    const rawBody = await readRawBody(request);
    const retryNum = header(request, 'x-slack-retry-num');
    logger.log(`${slackEventSummary(rawBody)}${retryNum ? ` retry=${retryNum}` : ''}`);

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

    if (!origin) {
      logger.error('could not resolve request origin for slack-process');
      return jsonResponse({ status: 'error', message: 'missing origin' }, 500);
    }

    const mode = waitUntil ? 'waitUntil' : 'await';
    logger.log(`background mode: ${mode}`);
    logger.log(`ack done, elapsed=${Date.now() - startTime}ms`);
    if (waitUntil) {
      logger.log('dispatch slack-process via waitUntil');
    } else {
      logger.log('await slack-process before responding');
    }

    background = (async () => {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        watchdog = setTimeout(() => {
          void logger.flush({ final: false });
        }, WATCHDOG_FLUSH_MS);
        await forwardToProcess(origin, request, rawBody, logger);
      } catch (e) {
        logger.error('failed to forward Slack event to slack-process:', e);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
        logger.log(
          `[slack-webhook] background done: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms, mode=${mode}`,
        );
        await logger.flush({ final: true });
      }
    })();

    if (waitUntil) {
      waitUntil(background);
    } else {
      await background;
    }

    return emptyOk();
  } finally {
    if (!background) {
      const flushTask = logger.flush({ final: true });
      if (!waitUntil) await flushTask;
    }
  }
}
