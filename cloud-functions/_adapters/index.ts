/**
 * Chat SDK adapter registry — private module, not mapped as a route.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. this directory: <name>.ts, then wire create / resolveEnv / fingerprint
 *   3. cloud-functions/<name>/index.ts with createVendorWebhook(<name>Adapter)
 *   If the vendor has no HTTP events (e.g. Discord Gateway messages), add a
 *   long-lived listener outside this webhook route.
 */

import { slackAdapter, type SlackEnv } from './slack';

export type BotEnv = SlackEnv;

export type VendorAdapter = {
  name: string;
  assertEnv: (env: Record<string, string | undefined>) => Response | void;
  handshake?: (rawBody: string, parsedBody?: unknown) => Response | undefined;
  summarize?: (
    rawBody: string,
    request: { headers: { get(name: string): string | null } },
  ) => string;
};

export type ChatAdapters = {
  slack?: NonNullable<ReturnType<typeof slackAdapter.create>>;
};

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
