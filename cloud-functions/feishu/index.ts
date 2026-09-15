/**
 * Feishu webhook — EdgeOne Makers Node Function
 * =============================================
 *
 * File path cloud-functions/feishu/index.ts maps to **POST /feishu**.
 *
 * Point Feishu's Event Request URL here. url_verification is answered
 * immediately with `{ challenge }`. Events are acked 200; Chat SDK then
 * verifies the signature and handles the event without awaiting the HTTP
 * response.
 */

import { feishuAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(feishuAdapter);
