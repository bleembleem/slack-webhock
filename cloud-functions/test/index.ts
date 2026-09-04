/**
 * Background waitUntil probe — EdgeOne Makers Node Function
 * =========================================================
 *
 * File path cloud-functions/test/index.ts maps to **GET /test**.
 *
 * Returns an empty 200 immediately, then POSTs /debug-log every second
 * (id + timestamp) until the platform kills the isolate.
 */

import type { CloudFunctionContext, EdgeoneRequest } from '@edgeone/types';

type TestContext = CloudFunctionContext & {
  waitUntil?: (promise: Promise<unknown>) => void;
};

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

function queryId(request: EdgeoneRequest): string {
  try {
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (id) return id;
  } catch {
    /* relative or invalid URL */
  }
  return 'missing-id';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingDebugLog(origin: string, id: string): Promise<void> {
  let seq = 0;
  while (true) {
    seq += 1;
    const ts = Date.now();
    const at = new Date(ts).toISOString();
    try {
      await fetch(`${origin}/debug-log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'cloud',
          tag: 'test',
          requestId: id,
          seq,
          final: false,
          flushedAt: at,
          entries: [
            {
              level: 'log',
              at,
              message: `id=${id} ts=${ts}`,
            },
          ],
        }),
      });
    } catch {
      /* keep looping until the isolate is killed */
    }
    await sleep(1000);
  }
}

export async function onRequestGet(context: TestContext): Promise<Response> {
  const request = context.request;
  if (!request) {
    return new Response(null, { status: 200 });
  }

  const id = queryId(request);
  const origin = requestOrigin(request);
  const loop = origin ? pingDebugLog(origin, id) : Promise.resolve();

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(loop);
  } else {
    void loop;
  }

  return new Response(null, { status: 200 });
}
