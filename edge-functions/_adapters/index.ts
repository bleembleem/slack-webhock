/**
 * Edge vendor webhook factory — private module, not a route.
 *
 * Add a vendor:
 *   1. package.json: @chat-adapter/<name>
 *   2. this directory: <name>.ts + edge-functions/<name>/index.ts
 *   3. cloud-functions/_adapters/<name>.ts and wire it in the registry
 *   If the vendor has no HTTP events (e.g. Discord Gateway messages), add a
 *   long-lived listener outside this edge/process pair.
 */

import { createLogger } from '../_logger';
import {
  dispatchToProcess,
  jsonResponse,
  readRawBody,
  requestOrigin,
  type DispatchMode,
  type EdgeFunctionContext,
} from '../_forward';

export const CHAT_ADAPTER_HEADER = 'x-chat-adapter';
export const CHAT_PROCESS_PATH = '/chat-process';

export type VendorEdgeAdapter = {
  name: string;
  headers: readonly string[];
  classify: (rawBody: string) => DispatchMode;
  summarize?: (rawBody: string, request: Request) => string;
};

export function createVendorWebhook(adapter: VendorEdgeAdapter) {
  return async function onRequestPost(context: EdgeFunctionContext): Promise<Response> {
    const startTime = Date.now();
    const request = context.request;
    const origin = requestOrigin(request);
    const waitUntil =
      typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
    const logger = createLogger(
      adapter.name,
      origin ? { origin, waitUntil } : undefined,
    );

    logger.log(`[${adapter.name}] start: ${new Date(startTime).toISOString()}`);

    const rawBody = await readRawBody(request);
    logger.log(adapter.summarize?.(rawBody, request) ?? `body_len=${rawBody.length}`);

    if (!origin) {
      logger.error('could not resolve request origin for chat-process');
      await logger.flush({ final: true });
      return jsonResponse({ status: 'error', message: 'missing origin' }, 500);
    }

    return dispatchToProcess({
      origin,
      path: CHAT_PROCESS_PATH,
      request,
      rawBody,
      headerNames: adapter.headers,
      extraHeaders: { [CHAT_ADAPTER_HEADER]: adapter.name },
      classify: adapter.classify,
      waitUntil,
      logger,
      startTime,
    });
  };
}

export { slackEdgeAdapter } from './slack';
