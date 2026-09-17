/**
 * WeCom Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   WECOM_CORP_ID
 *   WECOM_AGENT_ID
 *   WECOM_APP_SECRET
 *   WECOM_TOKEN                 Token from 接收消息服务器配置
 *   WECOM_ENCODING_AES_KEY      43-char EncodingAESKey from the same page
 *
 * URL: https://<domain>/wecom  (GET verifies echostr; POST receives messages)
 *
 * Replies use message/send. WeCom 60020 means the function egress IP is not
 * on 应用管理 → 企业可信IP. There is no sessionWebhook fallback.
 */

import { createWecomAdapter, verifyWecomUrl, xmlTag } from '@edgeone/chat-adapter-wecom';
import { createLogger } from '../_logger';

const logger = createLogger('wecom-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type WecomEnv = {
  WECOM_CORP_ID?: string;
  WECOM_AGENT_ID?: string;
  WECOM_APP_SECRET?: string;
  WECOM_TOKEN?: string;
  WECOM_ENCODING_AES_KEY?: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function resolveWecomEnv(env: WecomEnv): WecomEnv {
  return {
    WECOM_CORP_ID: normalizeSecret(env.WECOM_CORP_ID || process.env.WECOM_CORP_ID),
    WECOM_AGENT_ID: normalizeSecret(env.WECOM_AGENT_ID || process.env.WECOM_AGENT_ID),
    WECOM_APP_SECRET: normalizeSecret(env.WECOM_APP_SECRET || process.env.WECOM_APP_SECRET),
    WECOM_TOKEN: normalizeSecret(env.WECOM_TOKEN || process.env.WECOM_TOKEN),
    WECOM_ENCODING_AES_KEY: normalizeSecret(
      env.WECOM_ENCODING_AES_KEY || process.env.WECOM_ENCODING_AES_KEY,
    ),
  };
}

export function wecomFingerprint(env: WecomEnv): Record<string, string> {
  return {
    wecomCorpId: normalizeSecret(env.WECOM_CORP_ID),
    wecomAgentId: normalizeSecret(env.WECOM_AGENT_ID),
    wecomSecret: normalizeSecret(env.WECOM_APP_SECRET),
    wecomToken: normalizeSecret(env.WECOM_TOKEN),
    wecomAesKey: normalizeSecret(env.WECOM_ENCODING_AES_KEY),
  };
}

export function createWecomChatAdapter(env: WecomEnv) {
  const resolved = resolveWecomEnv(env);
  if (
    !resolved.WECOM_CORP_ID ||
    !resolved.WECOM_AGENT_ID ||
    !resolved.WECOM_APP_SECRET ||
    !resolved.WECOM_TOKEN ||
    !resolved.WECOM_ENCODING_AES_KEY
  ) {
    return undefined;
  }
  return createWecomAdapter({
    corpId: resolved.WECOM_CORP_ID,
    agentId: resolved.WECOM_AGENT_ID,
    appSecret: resolved.WECOM_APP_SECRET,
    token: resolved.WECOM_TOKEN,
    encodingAesKey: resolved.WECOM_ENCODING_AES_KEY,
  });
}

export function wecomHandshakeGet(
  request: { url: string; headers: { get(name: string): string | null } },
  env?: Record<string, string | undefined>,
): Response {
  const resolved = resolveWecomEnv(env ?? {});
  const params = new URL(request.url, 'https://unused.local').searchParams;
  const echostr = params.get('echostr') ?? '';
  if (!echostr || !resolved.WECOM_TOKEN || !resolved.WECOM_ENCODING_AES_KEY || !resolved.WECOM_CORP_ID) {
    throw new Error('wecom GET handshake is missing echostr or env');
  }
  const plain = verifyWecomUrl({
    echostr,
    timestamp: params.get('timestamp') ?? '',
    nonce: params.get('nonce') ?? '',
    signature: params.get('msg_signature') ?? '',
    token: resolved.WECOM_TOKEN,
    encodingAesKey: resolved.WECOM_ENCODING_AES_KEY,
    corpId: resolved.WECOM_CORP_ID,
  });
  return new Response(plain, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

/** WeCom text content is capped at 2048 bytes. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '');
}

function wecomPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export async function wecomDeliver(
  env: Record<string, string | undefined>,
  threadId: string,
  text: string,
): Promise<void> {
  const resolved = resolveWecomEnv(env);
  if (!resolved.WECOM_CORP_ID || !resolved.WECOM_AGENT_ID || !resolved.WECOM_APP_SECRET) {
    throw new Error('wecom deliver is missing corpId, agentId, or appSecret');
  }
  const userId = threadId.startsWith('wecom:') ? threadId.slice('wecom:'.length) : threadId;
  const content = truncateUtf8(wecomPlainText(text) || text, 2048);
  const tokenRes = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(resolved.WECOM_CORP_ID)}` +
      `&corpsecret=${encodeURIComponent(resolved.WECOM_APP_SECRET)}`,
  );
  const tokenBody = (await tokenRes.json()) as { access_token?: string; errcode?: number; errmsg?: string };
  if (!tokenBody.access_token) {
    throw new Error(`wecom gettoken failed errcode=${tokenBody.errcode ?? ''} ${tokenBody.errmsg ?? ''}`);
  }
  const sendRes = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(tokenBody.access_token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        agentid: Number(resolved.WECOM_AGENT_ID) || resolved.WECOM_AGENT_ID,
        text: { content },
      }),
    },
  );
  const sendBody = (await sendRes.json()) as { errcode?: number; errmsg?: string };
  if (typeof sendBody.errcode === 'number' && sendBody.errcode !== 0) {
    throw new Error(`wecom message/send errcode=${sendBody.errcode} ${sendBody.errmsg ?? ''}`);
  }
  logger.log(`delivered text to ${userId} chars=${content.length}`);
}

export function wecomSummarize(rawBody: string): string {
  const encrypt = xmlTag(rawBody, 'Encrypt');
  return encrypt
    ? `encrypted body_len=${rawBody.length}`
    : `type=${xmlTag(rawBody, 'MsgType') || 'unparsed'} body_len=${rawBody.length}`;
}

export function assertWecomEnv(env: Record<string, string | undefined>): Response | void {
  const resolved = resolveWecomEnv(env);
  const missing = (
    [
      ['WECOM_CORP_ID', resolved.WECOM_CORP_ID],
      ['WECOM_AGENT_ID', resolved.WECOM_AGENT_ID],
      ['WECOM_APP_SECRET', resolved.WECOM_APP_SECRET],
      ['WECOM_TOKEN', resolved.WECOM_TOKEN],
      ['WECOM_ENCODING_AES_KEY', resolved.WECOM_ENCODING_AES_KEY],
    ] as const
  ).filter(([, value]) => !value);
  logger.log(`WECOM_CORP_ID present=${Boolean(resolved.WECOM_CORP_ID)}`);
  if (missing.length === 0) return;
  const keys = missing.map(([key]) => key).join(', ');
  logger.error(`${keys} is not configured`);
  return jsonResponse({ status: 'error', message: `${keys} is not configured` }, 500);
}

export const wecomAdapter = {
  name: 'wecom' as const,
  resolveEnv: resolveWecomEnv,
  fingerprint: wecomFingerprint,
  create: createWecomChatAdapter,
  assertEnv: assertWecomEnv,
  handshakeGet: wecomHandshakeGet,
  summarize: wecomSummarize,
  deliver: wecomDeliver,
  placeholder: false as const,
};
