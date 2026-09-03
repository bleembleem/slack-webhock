/**
 * Edge debug log sink — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/debug-log/index.ts maps to **POST /debug-log**.
 *
 * Edge Function console.log is not reported. Edge POSTs aggregated batches
 * here so they show up as one Cloud Function log block per flush.
 * Not a Slack URL. Stay fast: no extra I/O, return 200 immediately.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';

const logger = createLogger('debug-log');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;
const MAX_BODY_CHARS = 64_000;
const MAX_PRINT_ENTRIES = 80;

type LogEntry = {
  level?: unknown;
  at?: unknown;
  message?: unknown;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) {
    return jsonResponse({ status: 'error', message: 'missing request' }, 400);
  }

  let raw = '';
  try {
    raw = await request.text();
  } catch (e) {
    logger.error('failed to read debug-log body:', e);
    return jsonResponse({ status: 'error', message: 'unreadable body' }, 400);
  }

  if (raw.length > MAX_BODY_CHARS) {
    logger.error(`payload too large: ${raw.length} chars, refusing to parse`);
    return jsonResponse({ status: 'error', message: 'payload too large' }, 413);
  }

  let payload: Record<string, unknown> = {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      payload = data as Record<string, unknown>;
    }
  } catch {
    logger.error(`debug-log body is not JSON, chars=${raw.length}`);
    return jsonResponse({ status: 'error', message: 'invalid json' }, 400);
  }

  const source = asString(payload.source) || 'edge';
  const tag = asString(payload.tag) || 'unknown';
  const requestId = asString(payload.requestId) || 'no-id';
  const seq = asPositiveInt(payload.seq) || 1;
  const final = payload.final === true;
  const flushedAt = asString(payload.flushedAt);
  const allEntries = Array.isArray(payload.entries) ? payload.entries : [];
  const truncated = allEntries.length > MAX_PRINT_ENTRIES;
  const entries = truncated ? allEntries.slice(0, MAX_PRINT_ENTRIES) : allEntries;

  const lines: string[] = [];
  let errorCount = 0;
  for (const item of entries) {
    const entry = (item && typeof item === 'object' ? item : {}) as LogEntry;
    const level = asString(entry.level) === 'error' ? 'error' : 'log';
    if (level === 'error') errorCount += 1;
    const at = asString(entry.at);
    const message = asString(entry.message);
    lines.push(`${at} ${level.padEnd(5)} ${message}`);
  }
  if (truncated) {
    lines.push(`… truncated ${allEntries.length - MAX_PRINT_ENTRIES} extra line(s)`);
  }

  const header = [
    `--- ${source}/${tag}`,
    `id=${requestId}`,
    `seq=${seq}`,
    final ? 'final' : 'snapshot',
    `lines=${allEntries.length}`,
    `errors=${errorCount}`,
    flushedAt ? `flushedAt=${flushedAt}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const block = [header, ...lines, `--- end ${requestId} seq=${seq}`].join('\n');
  if (errorCount > 0) {
    logger.error(`${requestId} seq=${seq} ${errorCount} error(s)`);
  }
  logger.log(block);

  return jsonResponse({
    status: 'ok',
    requestId,
    seq,
    final,
    received: allEntries.length,
  });
}
