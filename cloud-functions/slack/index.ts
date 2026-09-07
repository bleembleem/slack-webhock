/**
 * Slack webhook — EdgeOne Makers Node Function
 * ============================================
 *
 * File path cloud-functions/slack/index.ts maps to **POST /slack**.
 *
 * Point Slack's Events API Request URL here. url_verification is answered
 * immediately with `{ challenge }`. Events are acked 200; Chat SDK then
 * verifies HMAC and handles the event without awaiting the HTTP response.
 */

import { slackAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(slackAdapter);
