/**
 * Feishu event worker — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/feishu-events/index.ts maps to **POST /feishu-events**.
 *
 * Not the Feishu Request URL. POST /feishu answers url_verification in <1s,
 * then forwards real events here so Chat SDK / adapter cold start cannot
 * miss Feishu's handshake window.
 */

import { feishuAdapter } from '../_adapters';
import { createVendorWebhook, jsonResponse } from '../_process';

const onPost = createVendorWebhook(feishuAdapter);

export async function onRequest(context: Parameters<typeof onPost>[0]) {
  const method = String(context.request?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return jsonResponse({ status: 'ok', service: 'feishu-events' });
  }
  return onPost(context);
}

export const onRequestPost = onPost;
export const onRequestGet = onRequest;
export const onRequestHead = onRequest;
export const onRequestOptions = onRequest;
