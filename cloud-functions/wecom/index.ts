/**
 * WeCom webhook — EdgeOne Makers Node Function
 * ============================================
 *
 * File path cloud-functions/wecom/index.ts maps to **GET /wecom** and
 * **POST /wecom**.
 *
 * GET is the URL verification (decrypt echostr, return plaintext). POST is
 * the encrypted message callback; it is acked 200 and processed after return.
 */

import { wecomAdapter } from '../_adapters';
import { createVendorWebhook, createVendorWebhookGet } from '../_process';

export const onRequestGet = createVendorWebhookGet(wecomAdapter);
export const onRequestPost = createVendorWebhook(wecomAdapter);
