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
  const looksEncrypted = typeof payload?.encrypt === 'string' && payload.encrypt.length > 0;
  const verified = verifyFeishuUrl(wire, encryptKey);
  if (verified) return jsonResponse({ challenge: verified.challenge });

  if (looksEncrypted || payload?.type === 'url_verification') {
    logger.error(
      looksEncrypted
        ? 'url_verification is encrypted but decrypt failed; check FEISHU_ENCRYPT_KEY'
        : 'url_verification is missing a string challenge',
    );
    return jsonResponse(
      { status: 'error', message: 'feishu url_verification failed' },
      400,
    );
  }
  return undefined;
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
  summarize: feishuSummarize,
  placeholder: false as const,
};
