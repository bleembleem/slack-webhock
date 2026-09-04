/**
 * Slack edge adapter — classify handshake vs event and name signature headers.
 *
 * Do not verify HMAC here. Chat SDK verifies in POST /chat-process.
 */

import type { DispatchMode } from '../_forward';

export const slackEdgeAdapter = {
  name: 'slack' as const,
  headers: [
    'content-type',
    'x-slack-signature',
    'x-slack-request-timestamp',
    'x-slack-retry-num',
    'x-slack-retry-reason',
  ] as const,
  classify(rawBody: string): DispatchMode {
    try {
      const payload = JSON.parse(rawBody) as { type?: unknown };
      if (payload?.type === 'url_verification') return 'proxy';
    } catch {
      /* not JSON */
    }
    return 'ack';
  },
  summarize(rawBody: string, request: Request): string {
    const retryNum = request.headers.get('x-slack-retry-num')?.trim();
    let summary: string;
    try {
      const payload = JSON.parse(rawBody) as {
        type?: unknown;
        event_id?: unknown;
        event?: { type?: unknown };
      };
      const type = typeof payload.type === 'string' ? payload.type : '';
      const eventType = typeof payload.event?.type === 'string' ? payload.event.type : '';
      const eventId = typeof payload.event_id === 'string' ? payload.event_id : '';
      summary = `type=${type} event=${eventType} event_id=${eventId} body_len=${rawBody.length}`;
    } catch {
      summary = `type=unparsed body_len=${rawBody.length}`;
    }
    const sig = request.headers.get('x-slack-signature') ? 'yes' : 'no';
    const ts = request.headers.get('x-slack-request-timestamp') ? 'yes' : 'no';
    summary = `${summary} sig=${sig} ts=${ts}`;
    return retryNum ? `${summary} retry=${retryNum}` : summary;
  },
};
