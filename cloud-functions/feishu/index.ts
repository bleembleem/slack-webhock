/**
 * Feishu webhook — EdgeOne Makers Node Function
 * =============================================
 *
 * File path cloud-functions/feishu/index.ts maps to **POST /feishu**.
 *
 * Feishu URL verification must return `{ challenge }` as JSON within 1s
 * (https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq).
 * Importing `_process` / `_adapters` pulls Chat SDK and every vendor, which
 * cold-starts past that window — Feishu aborts and Makers may never log the
 * invocation. Keep this file's static imports tiny and lazy-load the rest.
 */

import type { CloudFunctionContext } from '@edgeone/types';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readBody(request: CloudFunctionContext['request']): Promise<string> {
  const asRequest = request as unknown as Request & { rawBody?: unknown };
  if (typeof asRequest.rawBody === 'string' && asRequest.rawBody) return asRequest.rawBody;
  if (typeof asRequest.text === 'function') {
    try {
      const text = await asRequest.text();
      if (text) return text;
    } catch {
      /* already consumed */
    }
  }
  const resolved = await Promise.resolve(request?.body);
  if (typeof resolved === 'string') return resolved;
  if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    try {
      return JSON.stringify(resolved);
    } catch {
      return '';
    }
  }
  return '';
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const request = context.request;
  if (!request) return jsonResponse({ status: 'error', message: 'missing request' }, 400);

  const rawBody = await readBody(request);
  (request as unknown as { rawBody?: string }).rawBody = rawBody;
  const payload = parseObject(rawBody);

  if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') {
    return jsonResponse({ challenge: payload.challenge });
  }

  if (typeof payload?.encrypt === 'string' && payload.encrypt) {
    const { verifyFeishuUrl } = await import('@edgeone/chat-adapter-feishu');
    const encryptKey = String(
      context.env?.FEISHU_ENCRYPT_KEY || process.env.FEISHU_ENCRYPT_KEY || '',
    )
      .trim()
      .replace(/^['"]|['"]$/g, '');
    const verified = verifyFeishuUrl(rawBody, encryptKey);
    if (verified) return jsonResponse({ challenge: verified.challenge });
    return jsonResponse({ status: 'error', message: 'feishu url_verification decrypt failed' }, 400);
  }

  const [{ createVendorWebhook }, { feishuAdapter }] = await Promise.all([
    import('../_process'),
    import('../_adapters'),
  ]);
  return createVendorWebhook(feishuAdapter)(context);
}
