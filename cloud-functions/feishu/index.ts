/**
 * Feishu webhook — EdgeOne Makers Node Function
 * =============================================
 *
 * cloud-functions/feishu/index.ts            → /feishu
 * cloud-functions/feishu/[[default]].ts      → /feishu/  (SPA would otherwise win)
 *
 * URL verification must return `{ challenge }` JSON within 1s.
 * Real events are forwarded to POST /feishu-events.
 */

export {
  handleFeishuRequest as onRequest,
  handleFeishuRequest as onRequestGet,
  handleFeishuRequest as onRequestPost,
  handleFeishuRequest as onRequestHead,
  handleFeishuRequest as onRequestOptions,
} from './_handshake';
