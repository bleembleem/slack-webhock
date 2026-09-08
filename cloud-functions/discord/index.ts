/**
 * Discord Interactions webhook — EdgeOne Makers Node Function
 * ===========================================================
 *
 * File path cloud-functions/discord/index.ts maps to **POST /discord**.
 *
 * Point Discord's Interactions Endpoint URL here. PING is verified by
 * Chat SDK (Ed25519) and answered with `{ type: 1 }`. Slash commands
 * return DEFERRED; Chat SDK then posts the final reply.
 *
 * Regular channel messages are not delivered here. Start POST /discord-gateway.
 */

import { discordAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(discordAdapter);
