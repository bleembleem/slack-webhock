/**
 * Slack webhook ack — EdgeOne Makers Edge Function
 * ================================================
 *
 * File path edge-functions/slack/index.ts maps to **POST /slack**.
 *
 * Point Slack's Events API Request URL here. This function does not verify
 * the signature. It classifies url_verification (proxy, await process) vs
 * events (ack 200, waitUntil process). Chat SDK verifies HMAC in
 * POST /chat-process.
 *
 * Edge console.log is not reported; lines are flushed to POST /debug-log.
 */

import { createVendorWebhook, slackEdgeAdapter } from '../_adapters';

export const onRequestPost = createVendorWebhook(slackEdgeAdapter);
