/**
 * Chat SDK adapter registry — private module, not mapped as a route.
 *
 * Add a vendor:
 *   1. Official package: package.json @chat-adapter/<name>
 *      or community: @edgeone/chat-adapter-feishu / wecom / dingtalk
 *   2. this directory: <name>.ts, then wire create / resolveEnv / fingerprint
 *   3. cloud-functions/<name>/index.ts with createVendorWebhook(<name>Adapter)
 *   4. this file: register it in `vendorAdapters`
 *   If the vendor has no HTTP events (e.g. Discord Gateway messages), add a
 *   long-lived listener outside this webhook route.
 *
 * `replySurface` and `placeholder` are the knobs a new vendor is likely to
 * need. Platforms that cannot edit a sent message set `placeholder: false`
 * and /chat-callback posts a new message instead.
 */

import { resolveCallbackEnv, type CallbackEnv } from '../_callback';
import { dingtalkAdapter, type DingtalkEnv } from './dingtalk';
import { discordAdapter, type DiscordEnv } from './discord';
import { feishuAdapter, type FeishuEnv } from './feishu';
import { slackAdapter, type SlackEnv } from './slack';
import { telegramAdapter, type TelegramEnv } from './telegram';
import { wecomAdapter, type WecomEnv } from './wecom';

export type BotEnv = SlackEnv & DiscordEnv & TelegramEnv & FeishuEnv & WecomEnv & DingtalkEnv & CallbackEnv;

export type VendorRespond = 'sdk' | 'ack';

/**
 * Where a reply belongs. `channel` keeps one conversation per channel, which is
 * also what the agent conversation id is keyed on, and is what Discord needs
 * anyway because it opens a throwaway thread for every mention. `thread` is for
 * platforms where burying the answer in a thread is the expected behaviour.
 */
export type ReplySurface = 'thread' | 'channel';

export type VendorAdapter = {
  name: string;
  assertEnv: (env: Record<string, string | undefined>) => Response | void;
  /** Default `thread`. */
  replySurface?: ReplySurface;
  /**
   * Post a "Thinking…" placeholder and edit it when the answer lands. Default
   * `true`. Off where the platform cannot edit a sent message: WeCom only has
   * update_template_card (single-use response_code, buttons only), and Feishu
   * PATCH works on interactive cards alone.
   */
  placeholder?: boolean;
  /**
   * Discard a thread the platform opened on our behalf that we did not reply
   * in. Only called when `replySurface` moved the reply somewhere else.
   */
  discardUnusedThread?: (
    env: Record<string, string | undefined>,
    threadId: string,
    sourceChannelId: string | undefined,
  ) => Promise<void>;
  handshake?: (
    rawBody: string,
    parsedBody?: unknown,
    env?: Record<string, string | undefined>,
  ) => Response | undefined;
  /** WeCom URL verification is a GET with echostr, not a POST body. */
  handshakeGet?: (
    request: { url: string; headers: { get(name: string): string | null } },
    env?: Record<string, string | undefined>,
  ) => Response | Promise<Response | undefined> | undefined;
  /**
   * Ack a delivery without processing it, returning the reason to log. For
   * redeliveries the vendor sends when our ack looks slow — the first delivery
   * already posted a placeholder and dispatched the run.
   */
  skip?: (
    rawBody: string,
    request: { headers: { get(name: string): string | null } },
  ) => string | undefined;
  summarize?: (
    rawBody: string,
    request: { headers: { get(name: string): string | null } },
  ) => string;
  /** Default `ack`. Discord Interactions must `sdk` so PING/DEFERRED reach Discord. */
  respond?: (
    rawBody: string,
    request: { headers: { get(name: string): string | null } },
  ) => VendorRespond;
  /** Mutate raw body / headers before Chat SDK sees the request. */
  prepare?: (
    rawBody: string,
    headers: Headers,
    env: Record<string, string | undefined>,
  ) => { rawBody: string; headers?: Headers };
};

export type ChatAdapters = {
  slack?: NonNullable<ReturnType<typeof slackAdapter.create>>;
  discord?: NonNullable<ReturnType<typeof discordAdapter.create>>;
  telegram?: NonNullable<ReturnType<typeof telegramAdapter.create>>;
  feishu?: NonNullable<ReturnType<typeof feishuAdapter.create>>;
  wecom?: NonNullable<ReturnType<typeof wecomAdapter.create>>;
  dingtalk?: NonNullable<ReturnType<typeof dingtalkAdapter.create>>;
};

export function resolveBotEnv(env: BotEnv): BotEnv {
  return {
    ...slackAdapter.resolveEnv(env),
    ...discordAdapter.resolveEnv(env),
    ...telegramAdapter.resolveEnv(env),
    ...feishuAdapter.resolveEnv(env),
    ...wecomAdapter.resolveEnv(env),
    ...dingtalkAdapter.resolveEnv(env),
    ...resolveCallbackEnv(env),
  };
}

export function envFingerprint(env: BotEnv): string {
  return JSON.stringify({
    ...slackAdapter.fingerprint(env),
    ...discordAdapter.fingerprint(env),
    ...telegramAdapter.fingerprint(env),
    ...feishuAdapter.fingerprint(env),
    ...wecomAdapter.fingerprint(env),
    ...dingtalkAdapter.fingerprint(env),
  });
}

const vendorAdapters: Record<string, VendorAdapter> = {
  [slackAdapter.name]: slackAdapter,
  [discordAdapter.name]: discordAdapter,
  [telegramAdapter.name]: telegramAdapter,
  [feishuAdapter.name]: feishuAdapter,
  [wecomAdapter.name]: wecomAdapter,
  [dingtalkAdapter.name]: dingtalkAdapter,
};

/** Look up a vendor by the platform prefix of a Chat SDK thread id. */
export function vendorAdapter(platform: string): VendorAdapter | undefined {
  return vendorAdapters[platform];
}

export function buildAdapters(env: BotEnv): ChatAdapters {
  const adapters: ChatAdapters = {};
  const slack = slackAdapter.create(env);
  if (slack) adapters.slack = slack;
  const discord = discordAdapter.create(env);
  if (discord) adapters.discord = discord;
  const telegram = telegramAdapter.create(env);
  if (telegram) adapters.telegram = telegram;
  const feishu = feishuAdapter.create(env);
  if (feishu) adapters.feishu = feishu;
  const wecom = wecomAdapter.create(env);
  if (wecom) adapters.wecom = wecom;
  const dingtalk = dingtalkAdapter.create(env);
  if (dingtalk) adapters.dingtalk = dingtalk;
  return adapters;
}

export { dingtalkAdapter, discordAdapter, feishuAdapter, slackAdapter, telegramAdapter, wecomAdapter };
