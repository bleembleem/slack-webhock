/**
 * Telegram Chat SDK adapter — private module under _adapters/.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN             Bot token from BotFather (<id>:<secret>)
 *   TELEGRAM_WEBHOOK_SECRET_TOKEN  Secret passed to setWebhook, echoed back in
 *                                  x-telegram-bot-api-secret-token
 *
 * Telegram pushes every update to one URL, so POST /telegram is the whole
 * integration — there is no Gateway half like Discord. Register it once:
 *
 *   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d url=https://<domain>/telegram \
 *     -d secret_token=<TELEGRAM_WEBHOOK_SECRET_TOKEN>
 */

import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createLogger } from '../_logger';

const logger = createLogger('telegram-adapter');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export type TelegramEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
};

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** BotFather hands out `<bot id>:<auth token>`. */
export function isTelegramBotToken(value: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(value);
}

export function resolveTelegramEnv(env: TelegramEnv): TelegramEnv {
  return {
    TELEGRAM_BOT_TOKEN: normalizeSecret(env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: normalizeSecret(
      env.TELEGRAM_WEBHOOK_SECRET_TOKEN || process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    ),
  };
}

export function telegramFingerprint(env: TelegramEnv): Record<string, string> {
  return {
    telegramToken: normalizeSecret(env.TELEGRAM_BOT_TOKEN),
    telegramSecretToken: normalizeSecret(env.TELEGRAM_WEBHOOK_SECRET_TOKEN),
  };
}

export function createTelegramChatAdapter(env: TelegramEnv) {
  const botToken = normalizeSecret(env.TELEGRAM_BOT_TOKEN);
  const secretToken = normalizeSecret(env.TELEGRAM_WEBHOOK_SECRET_TOKEN);
  if (!isTelegramBotToken(botToken) || !secretToken) return undefined;
  return createTelegramAdapter({
    botToken,
    secretToken,
    // `auto` probes getWebhookInfo and can fall back to long polling, which a
    // Cloud Function cannot sustain. This route is the only way in.
    mode: 'webhook',
  });
}

export function telegramSummarize(rawBody: string): string {
  try {
    const update = JSON.parse(rawBody) as {
      update_id?: unknown;
      message?: { chat?: { id?: unknown; type?: unknown }; from?: { username?: unknown }; text?: unknown };
    };
    const message = update.message;
    if (!message) {
      const kind = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
      return `update_id=${update.update_id ?? ''} kind=${kind} body_len=${rawBody.length}`;
    }
    const text = typeof message.text === 'string' ? message.text.slice(0, 80) : '';
    return (
      `update_id=${update.update_id ?? ''} chat=${message.chat?.id ?? ''}` +
      ` chat_type=${message.chat?.type ?? ''} from=${message.from?.username ?? ''}` +
      ` text="${text}"`
    );
  } catch {
    return `update=unparsed body_len=${rawBody.length}`;
  }
}

export function assertTelegramEnv(env: Record<string, string | undefined>): Response | void {
  const botToken = normalizeSecret(env.TELEGRAM_BOT_TOKEN);
  const secretToken = normalizeSecret(env.TELEGRAM_WEBHOOK_SECRET_TOKEN);

  const botTokenValid = isTelegramBotToken(botToken);
  logger.log(`TELEGRAM_BOT_TOKEN present=${Boolean(botToken)} format=${botTokenValid ? 'ok' : 'invalid'}`);
  if (!botTokenValid) {
    logger.error('TELEGRAM_BOT_TOKEN must be the BotFather token, shaped <bot id>:<auth token>.');
    return jsonResponse(
      { status: 'error', message: 'TELEGRAM_BOT_TOKEN is not configured' },
      500,
    );
  }

  if (!secretToken) {
    logger.error(
      'TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured; without it any caller could post updates.',
    );
    return jsonResponse(
      { status: 'error', message: 'TELEGRAM_WEBHOOK_SECRET_TOKEN is not configured' },
      500,
    );
  }
}

export const telegramAdapter = {
  name: 'telegram' as const,
  resolveEnv: resolveTelegramEnv,
  fingerprint: telegramFingerprint,
  create: createTelegramChatAdapter,
  assertEnv: assertTelegramEnv,
  summarize: telegramSummarize,
  // No replySurface: a Telegram thread id is already the chat (plus forum
  // topic), so the default `thread` posts straight back into the conversation.
};
