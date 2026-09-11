/**
 * Chat SDK adapter registry — private module, not mapped as a route.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. this directory: <name>.ts, then wire create / resolveEnv / fingerprint
 *   3. cloud-functions/<name>/index.ts with createVendorWebhook(<name>Adapter)
 *   4. this file: register it in `vendorAdapters`
 *   If the vendor has no HTTP events (e.g. Discord Gateway messages), add a
 *   long-lived listener outside this webhook route.
 *
 * Replying and editing stay platform-agnostic — `_bot.ts` and /chat-callback go
 * through the Chat SDK, which requires every adapter to implement `editMessage`
 * and `channelIdFromThreadId`. `replySurface` below is the only knob a new
 * vendor is likely to need.
 */

import { resolveCallbackEnv, type CallbackEnv } from '../_callback';
import { discordAdapter, type DiscordEnv } from './discord';
import { slackAdapter, type SlackEnv } from './slack';

export type BotEnv = SlackEnv & DiscordEnv & CallbackEnv;

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
   * Discard a thread the platform opened on our behalf that we did not reply
   * in. Only called when `replySurface` moved the reply somewhere else.
   */
  discardUnusedThread?: (
    env: Record<string, string | undefined>,
    threadId: string,
    sourceChannelId: string | undefined,
  ) => Promise<void>;
  handshake?: (rawBody: string, parsedBody?: unknown) => Response | undefined;
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
};

export function resolveBotEnv(env: BotEnv): BotEnv {
  return {
    ...slackAdapter.resolveEnv(env),
    ...discordAdapter.resolveEnv(env),
    ...resolveCallbackEnv(env),
  };
}

export function envFingerprint(env: BotEnv): string {
  return JSON.stringify({
    ...slackAdapter.fingerprint(env),
    ...discordAdapter.fingerprint(env),
  });
}

const vendorAdapters: Record<string, VendorAdapter> = {
  [slackAdapter.name]: slackAdapter,
  [discordAdapter.name]: discordAdapter,
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
  return adapters;
}

export { discordAdapter, slackAdapter };
