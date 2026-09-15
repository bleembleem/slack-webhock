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
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(feishuAdapter);
