/**
 * DingTalk webhook — EdgeOne Makers Node Function
 * ===============================================
 *
 * File path cloud-functions/dingtalk/index.ts maps to **POST /dingtalk**.
 *
 * Point the robot HTTP callback here. Events are acked 200; the adapter
 * verifies timestamp/sign and handles the update without awaiting the HTTP
 * response. Replies use OpenAPI, not sessionWebhook.
 */

import { dingtalkAdapter } from '../_adapters';
import { createVendorWebhook } from '../_process';

export const onRequestPost = createVendorWebhook(dingtalkAdapter);
