import { sleep } from './rpc.js';

const MIN_GAP_MS = 1100; // keeps a single group under Telegram's ~20 msg/min soft limit

/** Telegram sendMessage with retry, backoff and a small outbound queue. */
export class Telegram {
  constructor(token, chatId, log) {
    this.token = token;
    this.chatId = chatId;
    this.log = log;
    this.lastSent = 0;
    this.chain = Promise.resolve();
    this.sent = 0;
    this.failed = 0;
  }

  send(html) {
    this.chain = this.chain.then(() => this.#send(html)).catch((err) => {
      this.log.error(`telegram: ${err.message}`);
    });
    return this.chain;
  }

  async #send(text) {
    const gap = MIN_GAP_MS - (Date.now() - this.lastSent);
    if (gap > 0) await sleep(gap);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => ({ ok: false, status: 0, json: async () => ({ description: err.message }) }));

      const body = await res.json().catch(() => ({}));
      this.lastSent = Date.now();

      if (res.ok && body.ok) {
        this.sent++;
        return true;
      }

      const retryAfter = body?.parameters?.retry_after;
      if (res.status === 429 && retryAfter) {
        this.log.warn(`telegram 429: aguardando ${retryAfter}s`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      this.log.error(`telegram ${res.status}: ${body?.description ?? 'erro desconhecido'}`);
      break;
    }
    this.failed++;
    return false;
  }
}
