/**
 * Slack webhook ack — EdgeOne Makers Edge Function
 * ================================================
 *
 * File path edge-functions/slack/index.ts maps to **POST /slack**.
 *
 * Point Slack's Events API Request URL here. url_verification is answered
 * immediately with `{ challenge }`. Events are acked 200 then waitUntil
 * forwarded to POST /chat-process, where Chat SDK verifies HMAC.
 *
 * Edge console.log is not reported; lines are flushed to POST /debug-log.
 */

import { createVendorWebhook, slackEdgeAdapter } from '../_adapters';

export const onRequestPost = createVendorWebhook(slackEdgeAdapter);
