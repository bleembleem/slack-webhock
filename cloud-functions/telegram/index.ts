/**
 * Telegram webhook — EdgeOne Makers Node Function
 * ===============================================
 *
 * File path cloud-functions/telegram/index.ts maps to **POST /telegram**.
 *
 * Point setWebhook here. Updates are acked 200; Chat SDK then checks the
 * secret token and handles the update without awaiting the HTTP response.
 */

import { telegramAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(telegramAdapter);
