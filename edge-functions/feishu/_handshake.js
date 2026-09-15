/**
 * Feishu URL verification — Edge Function (millisecond cold start).
 *
 * Feishu requires `{ challenge }` JSON within 1s. Node Functions on this
 * project cold-start at ~1.1–1.7s, so Feishu aborts and shows
 * 「返回数据不是合法的JSON格式」 with no Node Function log.
 *
 * edge-functions/feishu/index.js       → /feishu
 * edge-functions/feishu/[[default]].js → /feishu/
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };

const FORWARD_HEADERS = [
  'content-type',
  'x-lark-signature',
  'x-lark-request-timestamp',
  'x-lark-request-nonce',
];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function encryptKeyFrom(env) {
  return String(env?.FEISHU_ENCRYPT_KEY || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function feishuDecrypt(encryptKey, encrypt) {
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptKey));
  const buf = base64ToBytes(encrypt);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: buf.subarray(0, 16) },
    cryptoKey,
    buf.subarray(16),
  );
  return new TextDecoder().decode(plain);
}

async function challengeFromBody(rawBody, encryptKey) {
  let outer;
  try {
    outer = JSON.parse(rawBody);
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
    const inner = JSON.parse(await feishuDecrypt(encryptKey, outer.encrypt));
    if (inner.type === 'url_verification' && typeof inner.challenge === 'string') {
      return { challenge: inner.challenge, encrypted: true, decryptFailed: false };
    }
    return { encrypted: true, decryptFailed: false };
  } catch {
    return { encrypted: true, decryptFailed: true };
  }
}

async function readBody(request) {
  if (!request) return '';
  if (typeof request.text === 'function') {
    try {
      const text = await request.text();
      if (text) return text;
    } catch {
      /* already consumed */
    }
  }
  return '';
}

function requestOrigin(request) {
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

function requestPath(request) {
  try {
    return new URL(request?.url || '', 'https://local').pathname;
  } catch {
    return '';
  }
}

export async function handleFeishuRequest(context) {
  const request = context.request;
  const method = String(request?.method || 'GET').toUpperCase();
  const path = requestPath(request);
  console.log(`[feishu-edge][${new Date().toISOString()}] ${method} ${path || '/feishu'}`);

  if (!request) return jsonResponse({ status: 'error', message: 'missing request' }, 400);

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return jsonResponse({ status: 'ok', service: 'feishu' });
  }

  const rawBody = await readBody(request);
  const parsed = await challengeFromBody(rawBody, encryptKeyFrom(context.env));
  if (parsed.challenge) {
    console.log(
      `[feishu-edge][${new Date().toISOString()}] handshake challenge encrypted=${parsed.encrypted}`,
    );
    return jsonResponse({ challenge: parsed.challenge });
  }
  if (parsed.decryptFailed) {
    console.error(
      `[feishu-edge][${new Date().toISOString()}] encrypt payload but decrypt failed; check FEISHU_ENCRYPT_KEY`,
    );
    return jsonResponse(
      { status: 'error', message: 'feishu url_verification decrypt failed' },
      400,
    );
  }

  const origin = requestOrigin(request);
  if (!origin) {
    console.error(`[feishu-edge][${new Date().toISOString()}] missing origin; cannot forward event`);
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
      console.log(`[feishu-edge][${new Date().toISOString()}] forwarded event HTTP ${res.status}`);
    },
    (err) => {
      console.error(`[feishu-edge][${new Date().toISOString()}] forward failed: ${String(err)}`);
    },
  );
  if (typeof context.waitUntil === 'function') context.waitUntil(pending);
  else void pending;

  return jsonResponse({ status: 'ok' });
}
