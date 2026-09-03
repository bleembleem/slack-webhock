/**
 * Shared logger factory — private module (starts with _), not mapped as a route.
 *
 * Edge console.log is not reported. Buffer lines and flush() them to
 * Cloud Function POST /debug-log (Node logs do show up).
 *
 * One Slack request shares a requestId. Fast paths send a single final
 * batch; a watchdog snapshot is sent if background work outlives the
 * isolate's likely waitUntil window. Failed POSTs restore the batch and
 * retry once so a dying isolate still has a chance to ship logs.
 */

export type EdgeLogSink = {
  origin: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type FlushOptions = {
  /** Last batch for this request (or the only batch on short-circuit). */
  final?: boolean;
};

type LogLevel = 'log' | 'error';

type LogEntry = {
  level: LogLevel;
  at: string;
  message: string;
};

const FLUSH_TIMEOUT_MS = 8000;
const FLUSH_ATTEMPTS = 2;
const MAX_BATCH_ENTRIES = 80;
const MAX_MESSAGE_CHARS = 500;

function requestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function clip(message: string): string {
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_MESSAGE_CHARS)}…(truncated)`;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

export function createLogger(tag: string, sink?: EdgeLogSink) {
  const id = requestId();
  const entries: LogEntry[] = [];
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();

  function emit(level: LogLevel, args: unknown[]) {
    const at = new Date().toISOString();
    const message = clip(args.map(formatArg).join(' '));
    if (level === 'error') {
      console.error(`[${tag}][${at}]`, ...args);
    } else {
      console.log(`[${tag}][${at}]`, ...args);
    }
    entries.push({ level, at, message });
    if (entries.length > MAX_BATCH_ENTRIES * 2) {
      entries.splice(0, entries.length - MAX_BATCH_ENTRIES);
      entries.unshift({
        level: 'error',
        at: new Date().toISOString(),
        message: `log buffer overflow, kept last ${MAX_BATCH_ENTRIES} lines`,
      });
    }
  }

    async function postBatch(opts: FlushOptions): Promise<void> {
      if (!sink?.origin) return;

      const drain = Boolean(opts.final);
      do {
        if (entries.length === 0) return;

        const overflow = entries.length > MAX_BATCH_ENTRIES;
        const batch = entries.splice(0, overflow ? MAX_BATCH_ENTRIES : entries.length);
        if (overflow) {
          batch.push({
            level: 'error',
            at: new Date().toISOString(),
            message: `batch truncated to ${MAX_BATCH_ENTRIES} lines, ${entries.length} still buffered`,
          });
        }

        seq += 1;
        const more = entries.length > 0;
        const payload = JSON.stringify({
          source: 'edge',
          tag,
          requestId: id,
          seq,
          final: drain && !more,
          flushedAt: new Date().toISOString(),
          entries: batch,
        });

        let lastError: unknown;
        let sent = false;
        for (let attempt = 1; attempt <= FLUSH_ATTEMPTS; attempt++) {
          try {
            const res = await fetchWithTimeout(
              `${sink.origin}/debug-log`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: payload,
              },
              FLUSH_TIMEOUT_MS,
            );
            if (res.ok) {
              sent = true;
              break;
            }
            lastError = new Error(`debug-log HTTP ${res.status}`);
          } catch (e) {
            lastError = e;
          }
        }

        if (!sent) {
          entries.unshift(...batch);
          seq -= 1;
          console.error(`[${tag}] debug-log flush failed`, lastError);
          return;
        }
      } while (drain && entries.length > 0);
    }

  return {
    log(...args: unknown[]) {
      emit('log', args);
    },
    error(...args: unknown[]) {
      emit('error', args);
    },
    flush(opts: FlushOptions = {}): Promise<void> {
      const task = chain.then(() => postBatch(opts));
      chain = task.catch(() => {
        /* keep the queue moving after a failed flush */
      });
      if (sink?.waitUntil) sink.waitUntil(task);
      return task;
    },
  };
}

export type EdgeLogger = ReturnType<typeof createLogger>;
