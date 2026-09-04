/**
 * Shared Chat SDK webhook worker — EdgeOne Makers Node Function
 * =============================================================
 *
 * File path cloud-functions/chat-process/index.ts maps to
 * **POST /chat-process**.
 *
 * Not a vendor Request URL. Edge functions classify handshake vs event and
 * forward the original body here with `x-chat-adapter`. Chat SDK verifies
 * the signature and can await /chat (up to ~120s).
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { getVendorAdapter } from '../_adapters';
import { jsonResponse, runChatWebhook } from '../_process';

const ADAPTER_HEADER = 'x-chat-adapter';

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const name = context.request?.headers.get(ADAPTER_HEADER)?.trim();
  const vendor = getVendorAdapter(name);
  if (!vendor) {
    return jsonResponse({ status: 'error', message: 'unknown or missing chat adapter' }, 400);
  }
  return runChatWebhook(context, {
    adapter: vendor.name,
    assertEnv: vendor.assertEnv,
  });
}
