/**
 * Feishu Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   FEISHU_APP_ID
 *   FEISHU_APP_SECRET
 *   FEISHU_ENCRYPT_KEY           Encrypt Key from 事件与回调 → 加密策略
 *   FEISHU_VERIFICATION_TOKEN    Verification Token from the same page
 *
 * Request URL: https://<domain>/feishu
 * Subscribe to im.message.receive_v1.
 */

import { createFeishuAdapter, verifyFeishuUrl } from '@edgeone/chat-adapter-feishu';
import { createLogger } from '../_logger';

const logger = createLogger('feishu-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type FeishuEnv = {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_ENCRYPT_KEY?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function resolveFeishuEnv(env: FeishuEnv): FeishuEnv {
  return {
    FEISHU_APP_ID: normalizeSecret(env.FEISHU_APP_ID || process.env.FEISHU_APP_ID),
    FEISHU_APP_SECRET: normalizeSecret(env.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET),
    FEISHU_ENCRYPT_KEY: normalizeSecret(env.FEISHU_ENCRYPT_KEY || process.env.FEISHU_ENCRYPT_KEY),
    FEISHU_VERIFICATION_TOKEN: normalizeSecret(
      env.FEISHU_VERIFICATION_TOKEN || process.env.FEISHU_VERIFICATION_TOKEN,
    ),
  };
}

export function feishuFingerprint(env: FeishuEnv): Record<string, string> {
  return {
    feishuAppId: normalizeSecret(env.FEISHU_APP_ID),
    feishuSecret: normalizeSecret(env.FEISHU_APP_SECRET),
    feishuEncryptKey: normalizeSecret(env.FEISHU_ENCRYPT_KEY),
    feishuToken: normalizeSecret(env.FEISHU_VERIFICATION_TOKEN),
  };
}

export function createFeishuChatAdapter(env: FeishuEnv) {
  const resolved = resolveFeishuEnv(env);
  if (
    !resolved.FEISHU_APP_ID ||
    !resolved.FEISHU_APP_SECRET ||
    !resolved.FEISHU_ENCRYPT_KEY ||
    !resolved.FEISHU_VERIFICATION_TOKEN
  ) {
    return undefined;
  }
  return createFeishuAdapter({
    appId: resolved.FEISHU_APP_ID,
    appSecret: resolved.FEISHU_APP_SECRET,
    encryptKey: resolved.FEISHU_ENCRYPT_KEY,
    verificationToken: resolved.FEISHU_VERIFICATION_TOKEN,
  });
}

function feishuPayload(rawBody: string, parsedBody?: unknown): Record<string, unknown> | undefined {
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON */
    }
  }
  if (typeof parsedBody === 'string' && parsedBody) {
    try {
      const parsed = JSON.parse(parsedBody) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    return parsedBody as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Feishu URL verification must return `{"challenge"}` as JSON within 1s.
 * If this function returns undefined, `_process` acks with plain text `ok`,
 * and the console reports "返回数据不是合法的JSON格式".
 *
 * An encrypted body is not evidence of a handshake — real events are encrypted
 * too, and `verifyFeishuUrl` returns undefined for both a real event and a key
 * mismatch. Only a decrypted `url_verification` may answer with a challenge;
 * everything else has to fall through so Chat SDK handles the event.
 */
export function feishuHandshake(
  rawBody: string,
  parsedBody?: unknown,
  env?: Record<string, string | undefined>,
): Response | undefined {
  const payload = feishuPayload(rawBody, parsedBody);
  const encryptKey = normalizeSecret(env?.FEISHU_ENCRYPT_KEY || process.env.FEISHU_ENCRYPT_KEY);

  if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') {
    return jsonResponse({ challenge: payload.challenge });
  }

  const wire = rawBody || (typeof parsedBody === 'string' ? parsedBody : JSON.stringify(payload ?? {}));
  const verified = verifyFeishuUrl(wire, encryptKey);
  if (verified) return jsonResponse({ challenge: verified.challenge });

  if (payload?.type === 'url_verification') {
    logger.error('url_verification is missing a string challenge');
    return jsonResponse({ status: 'error', message: 'feishu url_verification failed' }, 400);
  }

  if (typeof payload?.encrypt === 'string' && payload.encrypt.length > 0 && !encryptKey) {
    logger.error('FEISHU_ENCRYPT_KEY is not configured; encrypted payload cannot be read');
  }
  return undefined;
}

/**
 * Feishu retries when the first 200 is missing or not JSON. Those retries
 * share `header.event_id` / `message.message_id` (or the same `encrypt`
 * blob). Drop the second copy we see on this instance — Slack does the
 * same with `event.ts`.
 */
const claimedEvents = new Map<string, number>();
const CLAIM_TTL_MS = 120_000;

function claimFeishuEvent(id: string): boolean {
  const now = Date.now();
  for (const [key, at] of claimedEvents) {
    if (now - at > CLAIM_TTL_MS) claimedEvents.delete(key);
  }
  if (claimedEvents.has(id)) return false;
  claimedEvents.set(id, now);
  return true;
}

function feishuEventKey(rawBody: string): string | undefined {
  try {
    const payload = JSON.parse(rawBody) as {
      encrypt?: unknown;
      header?: { event_id?: unknown };
      event?: { message?: { message_id?: unknown } };
    };
    if (typeof payload.encrypt === 'string' && payload.encrypt) return payload.encrypt;
    const eventId = payload.header?.event_id;
    if (typeof eventId === 'string' && eventId) return eventId;
    const messageId = payload.event?.message?.message_id;
    if (typeof messageId === 'string' && messageId) return messageId;
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function feishuSkip(rawBody: string): string | undefined {
  const key = feishuEventKey(rawBody);
  if (key && !claimFeishuEvent(key)) {
    return `duplicate event ${key.slice(0, 24)}`;
  }
  return undefined;
}

export function feishuAck(): Response {
  return jsonResponse({ status: 'ok' });
}

export function feishuSummarize(rawBody: string): string {
  try {
    const outer = JSON.parse(rawBody) as { encrypt?: unknown; header?: { event_type?: unknown } };
    if (typeof outer.encrypt === 'string') return `encrypted body_len=${rawBody.length}`;
    return `event=${String(outer.header?.event_type ?? '')} body_len=${rawBody.length}`;
  } catch {
    return `event=unparsed body_len=${rawBody.length}`;
  }
}

export function assertFeishuEnv(env: Record<string, string | undefined>): Response | void {
  const resolved = resolveFeishuEnv(env);
  const missing = (
    [
      ['FEISHU_APP_ID', resolved.FEISHU_APP_ID],
      ['FEISHU_APP_SECRET', resolved.FEISHU_APP_SECRET],
      ['FEISHU_ENCRYPT_KEY', resolved.FEISHU_ENCRYPT_KEY],
      ['FEISHU_VERIFICATION_TOKEN', resolved.FEISHU_VERIFICATION_TOKEN],
    ] as const
  ).filter(([, value]) => !value);
  logger.log(`FEISHU_APP_ID present=${Boolean(resolved.FEISHU_APP_ID)}`);
  if (missing.length === 0) return;
  const keys = missing.map(([key]) => key).join(', ');
  logger.error(`${keys} is not configured`);
  return jsonResponse({ status: 'error', message: `${keys} is not configured` }, 500);
}

export const feishuAdapter = {
  name: 'feishu' as const,
  resolveEnv: resolveFeishuEnv,
  fingerprint: feishuFingerprint,
  create: createFeishuChatAdapter,
  assertEnv: assertFeishuEnv,
  handshake: feishuHandshake,
  skip: feishuSkip,
  ack: feishuAck,
  summarize: feishuSummarize,
  placeholder: false as const,
};
