/**
 * Discord Gateway cron trigger — EdgeOne Makers Node Function
 * ==========================================================
 *
 * File path cloud-functions/gateway-tick/index.ts maps to **POST /gateway-tick**.
 * The `schedules` entry in edgeone.json calls it every 10 minutes, which is
 * what re-arms the Gateway listener after a deploy or a crash.
 *
 * It exists because a schedule cannot send headers, and POST /discord-gateway
 * needs two: the bearer secret and `makers-conversation-id`. So the schedule
 * hits this instead and this adds them, keeping the secret server-side.
 *
 * Unauthenticated on purpose — a schedule has no way to prove who it is. That
 * is safe because every start reuses GATEWAY_CONVERSATION_ID, and the runtime
 * allows one active run per conversation, so a repeat call can only no-op or
 * queue behind the window already running. See agents/discord-gateway.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { requestOrigin } from '../_process';
import { createLogger } from '../_logger';

const logger = createLogger('gateway-tick');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

/**
 * Must match GATEWAY_CONVERSATION_ID in agents/discord-gateway. Duplicated
 * rather than imported because the two runtimes are bundled separately and
 * importing across would pull discord.js into this function.
 */
const GATEWAY_CONVERSATION_ID = 'discord-gateway';

/** The window outlives this request, so wait only long enough to be accepted. */
const DISPATCH_TIMEOUT_MS = 5_000;

function clean(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = context.env;
  const secret = clean(env.DISCORD_GATEWAY_SECRET) || clean(env.CRON_SECRET);
  if (!secret) throw new Error('DISCORD_GATEWAY_SECRET is not configured');

  const origin = requestOrigin(context.request!);
  if (!origin) throw new Error('missing request origin; cannot start the gateway');

  const detach = new AbortController();
  const timer = setTimeout(() => detach.abort(), DISPATCH_TIMEOUT_MS);
  let outcome: string;
  try {
    const response = await fetch(`${origin}/discord-gateway`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'makers-conversation-id': GATEWAY_CONVERSATION_ID,
      },
      body: '{}',
      signal: detach.signal,
    });
    outcome = `HTTP ${response.status}`;
  } catch (e) {
    if (!detach.signal.aborted) throw e;
    // Letting go once the window is under way is the expected path.
    outcome = 'dispatched';
  } finally {
    clearTimeout(timer);
  }

  logger.log(`gateway ${outcome}`);
  return new Response(JSON.stringify({ status: 'ok', gateway: outcome }), {
    headers: JSON_HEADERS,
  });
}
