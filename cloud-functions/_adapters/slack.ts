/**
 * Slack Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   SLACK_BOT_TOKEN       xoxb- Bot User OAuth Token
 *   SLACK_SIGNING_SECRET  HMAC key from Slack app credentials
 */

import { createSlackAdapter } from '@chat-adapter/slack';
import { createLogger } from '../_logger';

const logger = createLogger('slack-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type SlackEnv = {
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function isSlackBotToken(value: string): boolean {
  return value.startsWith('xoxb-') && value.length > 20;
}

export function resolveSlackEnv(env: SlackEnv): SlackEnv {
  return {
    SLACK_BOT_TOKEN: normalizeSecret(env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN),
    SLACK_SIGNING_SECRET: normalizeSecret(
      env.SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET,
    ),
  };
}

export function slackFingerprint(env: SlackEnv): Record<string, string> {
  return {
    slackToken: normalizeSecret(env.SLACK_BOT_TOKEN),
    slackSecret: normalizeSecret(env.SLACK_SIGNING_SECRET),
  };
}

export function createSlackChatAdapter(env: SlackEnv) {
  const slackToken = normalizeSecret(env.SLACK_BOT_TOKEN);
  const slackSecret = normalizeSecret(env.SLACK_SIGNING_SECRET);
  if (!isSlackBotToken(slackToken) || !slackSecret) return undefined;
  return createSlackAdapter({
    botToken: slackToken,
    signingSecret: slackSecret,
    nativeStreaming: true,
  });
}

function slackChallenge(rawBody: string, parsedBody?: unknown): string | undefined {
  if (rawBody) {
    try {
      const payload = JSON.parse(rawBody) as { type?: unknown; challenge?: unknown };
      if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') {
        return payload.challenge;
      }
    } catch {
      /* not JSON */
    }
  }
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    const payload = parsedBody as { type?: unknown; challenge?: unknown };
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return payload.challenge;
    }
  }
  return undefined;
}

export function slackHandshake(rawBody: string, parsedBody?: unknown): Response | undefined {
  const challenge = slackChallenge(rawBody, parsedBody);
  if (!challenge) return undefined;
  return jsonResponse({ challenge });
}

/**
 * Slack can describe one user message twice (`app_mention` + `message.channels`,
 * or `app_mention` + `message.im` in a DM). Those share `event.ts` but not
 * `event_id`. Drop the second copy we see on this instance.
 *
 * Do not drop a channel `message` just because an `app_mention` "should"
 * exist — many apps only subscribe to `message.channels`, and that used to
 * ack with no reply.
 *
 * Slack retries with `http_timeout` when the first ack missed the 3s window.
 * Process those; skip other retry reasons.
 */
const claimedTs = new Map<string, number>();
const CLAIM_TTL_MS = 120_000;

function claimSlackTs(ts: string): boolean {
  const now = Date.now();
  for (const [key, at] of claimedTs) {
    if (now - at > CLAIM_TTL_MS) claimedTs.delete(key);
  }
  if (claimedTs.has(ts)) return false;
  claimedTs.set(ts, now);
  return true;
}

type SlackInnerEvent = {
  type?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  ts?: unknown;
  subtype?: unknown;
};

export function slackSkip(
  rawBody: string,
  request: { headers: { get(name: string): string | null } },
): string | undefined {
  const retryNum = Number(request.headers.get('x-slack-retry-num') ?? '0');
  const reason = request.headers.get('x-slack-retry-reason') ?? '';
  if (retryNum > 0 && reason !== 'http_timeout') {
    return `redelivery retry=${retryNum} reason=${reason}`;
  }

  let event: SlackInnerEvent | undefined;
  try {
    event = (JSON.parse(rawBody) as { event?: SlackInnerEvent }).event;
  } catch {
    return undefined;
  }
  if (!event) return undefined;

  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  if (event.type === 'message' && subtype && subtype !== 'file_share' && subtype !== 'thread_broadcast') {
    return `message subtype=${subtype}`;
  }

  // Prefer message.im over app_mention in DMs (same ts).
  if (event.type === 'app_mention' && typeof event.channel === 'string' && event.channel.startsWith('D')) {
    return `app_mention in DM already delivered as message.im`;
  }

  const ts = typeof event.ts === 'string' ? event.ts : '';
  if (ts && (event.type === 'message' || event.type === 'app_mention') && !claimSlackTs(ts)) {
    return `duplicate ts=${ts}`;
  }
  return undefined;
}

export function slackSummarize(
  rawBody: string,
  request: { headers: { get(name: string): string | null } },
): string {
  const retryNum = request.headers.get('x-slack-retry-num')?.trim();
  let summary: string;
  try {
    const payload = JSON.parse(rawBody) as {
      type?: unknown;
      event_id?: unknown;
      event?: { type?: unknown; channel_type?: unknown };
    };
    const type = typeof payload.type === 'string' ? payload.type : '';
    const eventType = typeof payload.event?.type === 'string' ? payload.event.type : '';
    const channelType = typeof payload.event?.channel_type === 'string' ? payload.event.channel_type : '';
    const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
    summary =
      `type=${type} event=${eventType}` +
      (channelType ? ` channel_type=${channelType}` : '') +
      ` event_id=${eventId} body_len=${rawBody.length}`;
  } catch {
    summary = `type=unparsed body_len=${rawBody.length}`;
  }
  const sig = request.headers.get('x-slack-signature') ? 'yes' : 'no';
  const ts = request.headers.get('x-slack-request-timestamp') ? 'yes' : 'no';
  summary = `${summary} sig=${sig} ts=${ts}`;
  return retryNum ? `${summary} retry=${retryNum}` : summary;
}

export function assertSlackEnv(env: Record<string, string | undefined>): Response | void {
  const signingSecret = normalizeSecret(env.SLACK_SIGNING_SECRET);
  const botToken = normalizeSecret(env.SLACK_BOT_TOKEN);
  if (!signingSecret) {
    logger.error('SLACK_SIGNING_SECRET is not configured');
    return jsonResponse({ status: 'error', message: 'slack signing secret is not configured' }, 500);
  }

  const botTokenValid = isSlackBotToken(botToken);
  logger.log(`SLACK_BOT_TOKEN present=${Boolean(botToken)} format=${botTokenValid ? 'xoxb' : 'invalid'}`);
  if (!botTokenValid) {
    logger.error(
      'SLACK_BOT_TOKEN must be the Bot User OAuth Token from Slack app → OAuth & Permissions. It starts with xoxb-.',
    );
    return jsonResponse({
      status: 'error',
      message: 'SLACK_BOT_TOKEN is invalid. Use the Bot User OAuth Token (xoxb-...), not the Client Secret or Signing Secret.',
    }, 500);
  }
}

export const slackAdapter = {
  name: 'slack' as const,
  resolveEnv: resolveSlackEnv,
  fingerprint: slackFingerprint,
  create: createSlackChatAdapter,
  assertEnv: assertSlackEnv,
  handshake: slackHandshake,
  skip: slackSkip,
  summarize: slackSummarize,
  replySurface: 'channel' as const,
};
