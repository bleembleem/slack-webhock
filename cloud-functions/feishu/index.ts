/**
 * Feishu webhook — EdgeOne Makers Node Function
 * =============================================
 *
 * File path cloud-functions/feishu/index.ts maps to **POST /feishu**.
 *
 * Point 事件订阅 → 请求地址 here. url_verification is answered immediately
 * with `{ challenge }`. Events are acked 200; the adapter then verifies the
 * signature and handles im.message.receive_v1 without awaiting the HTTP response.
 */

import { feishuAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(feishuAdapter);
