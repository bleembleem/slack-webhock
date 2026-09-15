/**
 * Feishu URL-verification handshake (shared by /feishu and /feishu/).
 *
 * EdgeOne maps cloud-functions/feishu/index.ts → /feishu only.
 * /feishu/ falls through to the SPA HTML unless [[default]] also exports
 * these handlers. GET without onRequestGet does the same.
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store' },
  });
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

function challengeFromBody(
  rawBody: string,
  encryptKey: string,
): { challenge?: string; encrypted: boolean; decryptFailed: boolean } {
  let outer: { encrypt?: unknown; type?: unknown; challenge?: unknown };
  try {
    outer = JSON.parse(rawBody) as typeof outer;
  } catch {
    return { encrypted: false, decryptFailed: false };
  }
  if (outer.type === 'url_verification' && typeof outer.challenge === 'string') {
    return { challenge: outer.challenge, encrypted: false, decryptFailed: false };
  }
  if (typeof outer.encrypt !== 'string' || !outer.encrypt) {
    return { encrypted: false, decryptFailed: false };
  }
  if (!encryptKey) {
    return { encrypted: true, decryptFailed: true };
  }
  try {
    const inner = JSON.parse(feishuDecrypt(encryptKey, outer.encrypt)) as {
      type?: unknown;
      challenge?: unknown;
    };
    if (inner.type === 'url_verification' && typeof inner.challenge === 'string') {
      return { challenge: inner.challenge, encrypted: true, decryptFailed: false };
    }
    return { encrypted: true, decryptFailed: false };
  } catch {
    return { encrypted: true, decryptFailed: true };
  }
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

function requestPath(request: CloudFunctionContext['request']): string {
  try {
    return new URL(request?.url || '', 'https://local').pathname;
  } catch {
    return '';
  }
}

export async function handleFeishuRequest(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  const method = String(request?.method || 'GET').toUpperCase();
  const path = requestPath(request);
  console.log(`[feishu][${new Date().toISOString()}] ${method} ${path || '/feishu'}`);

  if (!request) return jsonResponse({ status: 'error', message: 'missing request' }, 400);

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return jsonResponse({ status: 'ok', service: 'feishu' });
  }

  const rawBody = await readBody(request);
  const parsed = challengeFromBody(rawBody, encryptKeyFrom(context.env));
  if (parsed.challenge) {
    console.log(`[feishu][${new Date().toISOString()}] handshake challenge encrypted=${parsed.encrypted}`);
    return jsonResponse({ challenge: parsed.challenge });
  }
  if (parsed.decryptFailed) {
    console.error(
      `[feishu][${new Date().toISOString()}] encrypt payload but decrypt failed; check FEISHU_ENCRYPT_KEY`,
    );
    return jsonResponse(
      { status: 'error', message: 'feishu url_verification decrypt failed' },
      400,
    );
  }

  const origin = requestOrigin(request);
  if (!origin) {
    console.error(`[feishu][${new Date().toISOString()}] missing origin; cannot forward event`);
    return jsonResponse({ status: 'ok' });
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

  return jsonResponse({ status: 'ok' });
}
