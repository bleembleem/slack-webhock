/**
 * Chat SDK adapter registry — private module, not mapped as a route.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. edge-functions/_adapters/<name>.ts + edge-functions/<name>/index.ts
 *      (classify handshake → proxy, else ack; forward signature headers).
 *      Do not re-verify on the edge.
 *   3. this directory: <name>.ts, then wire create / resolveEnv / fingerprint below.
 *   If the vendor has no HTTP events (e.g. Discord Gateway messages), add a
 *   long-lived listener outside this edge/process pair.
 */

import { slackAdapter, type SlackEnv } from './slack';

export type BotEnv = SlackEnv;

export type VendorAdapter = {
  name: string;
  assertEnv: (env: Record<string, string | undefined>) => Response | void;
};

export type ChatAdapters = {
  slack?: NonNullable<ReturnType<typeof slackAdapter.create>>;
};

const vendors: Record<string, VendorAdapter> = {
  [slackAdapter.name]: slackAdapter,
};

export function getVendorAdapter(name: string | null | undefined): VendorAdapter | undefined {
  if (!name) return undefined;
  return vendors[name];
}

export function resolveBotEnv(env: BotEnv): BotEnv {
  return {
    ...slackAdapter.resolveEnv(env),
  };
}

export function envFingerprint(env: BotEnv): string {
  return JSON.stringify({
    ...slackAdapter.fingerprint(env),
  });
}

export function buildAdapters(env: BotEnv): ChatAdapters {
  const adapters: ChatAdapters = {};
  const slack = slackAdapter.create(env);
  if (slack) adapters.slack = slack;
  return adapters;
}

export { slackAdapter };
