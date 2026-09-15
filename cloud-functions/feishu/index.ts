/**
 * Feishu webhook — EdgeOne Makers Node Function
 * =============================================
 *
 * File path cloud-functions/feishu/index.ts maps to **POST /feishu**.
 *
 * URL verification must return `{ challenge }` within 1s. This file has no
 * Chat SDK / adapter imports so the cold start stays under that window.
 * Real events are forwarded to POST /feishu-events.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import type { CloudFunctionContext } from '@edgeone/types';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

const FORWARD_HEADERS = [
  'content-type',
  'x-lark-signature',
  'x-lark-request-timestamp',
  'x-lark-request-nonce',
] as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function encryptKeyFrom(env: Record<string, string | undefined> | undefined): string {
  return String(env?.FEISHU_ENCRYPT_KEY || process.env.FEISHU_ENCRYPT_KEY || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function feishuDecrypt(encryptKey: string, encrypt: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const buf = Buffer.from(encrypt, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}

function challengeFromBody(rawBody: string, encryptKey: string): string | undefined {
  let outer: { encrypt?: unknown; type?: unknown; challenge?: unknown };
  try {
    outer = JSON.parse(rawBody) as typeof outer;
  } catch {
    return undefined;
  }
  if (outer.type === 'url_verification' && typeof outer.challenge === 'string') {
    return outer.challenge;
  }
  if (typeof outer.encrypt !== 'string' || !outer.encrypt || !encryptKey) return undefined;
  try {
    const inner = JSON.parse(feishuDecrypt(encryptKey, outer.encrypt)) as {
      type?: unknown;
      challenge?: unknown;
    };
    if (inner.type === 'url_verification' && typeof inner.challenge === 'string') {
      return inner.challenge;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readBody(request: CloudFunctionContext['request']): Promise<string> {
  const asRequest = request as unknown as Request & { rawBody?: unknown };
  if (typeof asRequest.rawBody === 'string' && asRequest.rawBody) return asRequest.rawBody;
  if (typeof asRequest.text === 'function') {
    try {
      const text = await asRequest.text();
      if (text) return text;
    } catch {
      /* already consumed */
    }
  }
  const resolved = await Promise.resolve(request?.body);
  if (typeof resolved === 'string') return resolved;
  if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    try {
      return JSON.stringify(resolved);
    } catch {
      return '';
    }
  }
  return '';
}

function requestOrigin(request: NonNullable<CloudFunctionContext['request']>): string {
  const host = (
    request.headers.get('eo-pages-host') ||
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  )
    .split(',')[0]
    .trim();
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  if (host) return `${proto}://${host}`;
  try {
    const origin = new URL(request.url).origin;
    if (origin && origin !== 'null') return origin;
  } catch {
    /* ignore */
  }
  return '';
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  console.log(`[feishu][${new Date().toISOString()}] url_verification gate`);
  const request = context.request;
  if (!request) return jsonResponse({ status: 'error', message: 'missing request' }, 400);

  const rawBody = await readBody(request);
  const challenge = challengeFromBody(rawBody, encryptKeyFrom(context.env));
  if (challenge) {
    console.log(`[feishu][${new Date().toISOString()}] handshake challenge`);
    return jsonResponse({ challenge });
  }

  const origin = requestOrigin(request);
  if (!origin) {
    console.error(`[feishu][${new Date().toISOString()}] missing origin; cannot forward event`);
    return new Response('ok', { status: 200 });
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');

  const pending = fetch(`${origin}/feishu-events`, {
    method: 'POST',
    headers,
    body: rawBody,
  }).then(
    (res) => {
      console.log(`[feishu][${new Date().toISOString()}] forwarded event HTTP ${res.status}`);
    },
    (err: unknown) => {
      console.error(`[feishu][${new Date().toISOString()}] forward failed: ${String(err)}`);
    },
  );
  const waitUntil = (context as { waitUntil?: (task: Promise<unknown>) => void }).waitUntil;
  if (typeof waitUntil === 'function') waitUntil(pending);
  else void pending;

  return new Response('ok', { status: 200 });
}
