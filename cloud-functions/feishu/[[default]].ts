/**
 * Catch-all so POST /feishu/ does not fall through to the SPA HTML.
 * Same handshake as /feishu.
 */

export {
  handleFeishuRequest as onRequest,
  handleFeishuRequest as onRequestGet,
  handleFeishuRequest as onRequestPost,
  handleFeishuRequest as onRequestHead,
  handleFeishuRequest as onRequestOptions,
} from './_handshake';
