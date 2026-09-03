/**
 * Slack HMAC helpers for Edge Functions — private module.
 * Web Crypto only (V8 runtime; no Node built-ins / npm).
 */

export const SLACK_MAX_TIMESTAMP_AGE_SEC = 60 * 5;

const encoder = new TextEncoder();

export function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export function header(request: Request, name: string): string {
  return request.headers.get(name)?.trim() ?? '';
}

export async function readRawBody(request: Request): Promise<string> {
  try {
    return await request.text();
  } catch {
    return '';
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const len = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return toHex(signature);
}

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'invalid_signature' };

export async function verifySlackSignature(opts: {
  signingSecret: string;
  signature: string;
  timestamp: string;
  rawBody: string;
  nowSec?: number;
}): Promise<SlackVerifyResult> {
  const { signingSecret, signature, timestamp, rawBody } = opts;
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'stale_timestamp' };

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SLACK_MAX_TIMESTAMP_AGE_SEC) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const computed = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  if (!timingSafeEqual(computed, signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}
