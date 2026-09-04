/**
 * Shared edge → cloud-function forwarder — private module, not a route.
 *
 * Edge does not verify vendor signatures. It classifies handshake vs event,
 * forwards the raw body + signature headers, and either:
 *   - proxy: await the process response (url_verification / PING)
 *   - ack: return 200 immediately, waitUntil the process call
 *
 * Avoid npm imports in edge-functions.
 */

import type { EdgeLogger } from './_logger';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;
const WATCHDOG_FLUSH_MS = 2000;

export type DispatchMode = 'proxy' | 'ack';

/** Edge runtime context. */
export interface EdgeFunctionContext {
  request: Request;
  env: Record<string, string | undefined>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function emptyOk(): Response {
  return new Response('ok', { status: 200 });
}

export async function readRawBody(request: Request): Promise<string> {
  try {
    return await request.text();
  } catch {
    return '';
  }
}

export function requestOrigin(request: Request): string {
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

export function pickHeaders(
  request: Request,
  names: readonly string[],
  extraHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (value) headers.set(name, value);
    }
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return headers;
}

export async function forwardToProcess(opts: {
  origin: string;
  path: string;
  request: Request;
  rawBody: string;
  headerNames: readonly string[];
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  return fetch(`${opts.origin}${path}`, {
    method: 'POST',
    headers: pickHeaders(opts.request, opts.headerNames, opts.extraHeaders),
    body: opts.rawBody,
  });
}

export type DispatchToProcessOptions = {
  origin: string;
  path: string;
  request: Request;
  rawBody: string;
  headerNames: readonly string[];
  extraHeaders?: Record<string, string>;
  classify: (rawBody: string) => DispatchMode;
  waitUntil?: (promise: Promise<unknown>) => void;
  logger: EdgeLogger;
  startTime: number;
};

export async function dispatchToProcess(opts: DispatchToProcessOptions): Promise<Response> {
  const mode = opts.classify(opts.rawBody);
  const waitUntil = opts.waitUntil;
  opts.logger.log(`dispatch mode=${mode} path=${opts.path} waitUntil=${Boolean(waitUntil)}`);

  const runForward = async (): Promise<Response> => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      watchdog = setTimeout(() => {
        void opts.logger.flush({ final: false });
      }, WATCHDOG_FLUSH_MS);
      const res = await forwardToProcess(opts);
      if (res.ok) {
        opts.logger.log(`${opts.path} HTTP ${res.status}`);
      } else {
        opts.logger.error(`${opts.path} HTTP ${res.status}`);
      }
      return res;
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      opts.logger.log(
        `forward done: ${new Date().toISOString()}, total: ${Date.now() - opts.startTime}ms, mode=${mode}`,
      );
      await opts.logger.flush({ final: true });
    }
  };

  if (mode === 'proxy') {
    try {
      return await runForward();
    } catch (e) {
      opts.logger.error('failed to proxy handshake to process:', e);
      await opts.logger.flush({ final: true });
      return jsonResponse({ status: 'error', message: 'process unavailable' }, 502);
    }
  }

  const background = (async () => {
    try {
      const res = await runForward();
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    } catch (e) {
      opts.logger.error('failed to forward event to process:', e);
      await opts.logger.flush({ final: true });
    }
  })();

  if (waitUntil) {
    waitUntil(background);
  } else {
    await background;
  }

  opts.logger.log(`ack done, elapsed=${Date.now() - opts.startTime}ms`);
  return emptyOk();
}
