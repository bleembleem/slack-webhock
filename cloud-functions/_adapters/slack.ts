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
};
