/**
 * DingTalk Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   DINGTALK_APP_KEY
 *   DINGTALK_APP_SECRET
 *   DINGTALK_ROBOT_CODE         robotCode of the internal-app robot
 *
 * Request URL: https://<domain>/dingtalk
 */

import { createDingtalkAdapter } from '@edgeone/chat-adapter-dingtalk';
import { createLogger } from '../_logger';

const logger = createLogger('dingtalk-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type DingtalkEnv = {
  DINGTALK_APP_KEY?: string;
  DINGTALK_APP_SECRET?: string;
  DINGTALK_ROBOT_CODE?: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function resolveDingtalkEnv(env: DingtalkEnv): DingtalkEnv {
  return {
    DINGTALK_APP_KEY: normalizeSecret(env.DINGTALK_APP_KEY || process.env.DINGTALK_APP_KEY),
    DINGTALK_APP_SECRET: normalizeSecret(
      env.DINGTALK_APP_SECRET || process.env.DINGTALK_APP_SECRET,
    ),
    DINGTALK_ROBOT_CODE: normalizeSecret(
      env.DINGTALK_ROBOT_CODE || process.env.DINGTALK_ROBOT_CODE,
    ),
  };
}

export function dingtalkFingerprint(env: DingtalkEnv): Record<string, string> {
  return {
    dingtalkAppKey: normalizeSecret(env.DINGTALK_APP_KEY),
    dingtalkSecret: normalizeSecret(env.DINGTALK_APP_SECRET),
    dingtalkRobot: normalizeSecret(env.DINGTALK_ROBOT_CODE),
  };
}

export function createDingtalkChatAdapter(env: DingtalkEnv) {
  const resolved = resolveDingtalkEnv(env);
  if (!resolved.DINGTALK_APP_KEY || !resolved.DINGTALK_APP_SECRET || !resolved.DINGTALK_ROBOT_CODE) {
    return undefined;
  }
  return createDingtalkAdapter({
    appKey: resolved.DINGTALK_APP_KEY,
    appSecret: resolved.DINGTALK_APP_SECRET,
    robotCode: resolved.DINGTALK_ROBOT_CODE,
  });
}

export function dingtalkSummarize(rawBody: string): string {
  try {
    const raw = JSON.parse(rawBody) as {
      conversationId?: string;
      conversationType?: string;
      senderStaffId?: string;
      senderNick?: string;
      text?: { content?: string };
    };
    const text = raw.text?.content?.slice(0, 80) ?? '';
    return (
      `type=${raw.conversationType ?? ''} conv=${raw.conversationId ?? ''}` +
      ` from=${raw.senderNick ?? raw.senderStaffId ?? ''} text="${text}"`
    );
  } catch {
    return `update=unparsed body_len=${rawBody.length}`;
  }
}

export function assertDingtalkEnv(env: Record<string, string | undefined>): Response | void {
  const resolved = resolveDingtalkEnv(env);
  const missing = (
    [
      ['DINGTALK_APP_KEY', resolved.DINGTALK_APP_KEY],
      ['DINGTALK_APP_SECRET', resolved.DINGTALK_APP_SECRET],
      ['DINGTALK_ROBOT_CODE', resolved.DINGTALK_ROBOT_CODE],
    ] as const
  ).filter(([, value]) => !value);
  logger.log(`DINGTALK_APP_KEY present=${Boolean(resolved.DINGTALK_APP_KEY)}`);
  if (missing.length === 0) return;
  const keys = missing.map(([key]) => key).join(', ');
  logger.error(`${keys} is not configured`);
  return jsonResponse({ status: 'error', message: `${keys} is not configured` }, 500);
}

export const dingtalkAdapter = {
  name: 'dingtalk' as const,
  resolveEnv: resolveDingtalkEnv,
  fingerprint: dingtalkFingerprint,
  create: createDingtalkChatAdapter,
  assertEnv: assertDingtalkEnv,
  summarize: dingtalkSummarize,
  placeholder: false as const,
};
