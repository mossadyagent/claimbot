import { sleep } from './rpc.js';

const MIN_GAP_MS = 1100; // keeps a single group under Telegram's ~20 msg/min soft limit

/** Telegram sendMessage with retry, backoff and a small outbound queue. */
export class Telegram {
  constructor(token, chatId, log) {
    this.token = token;
    this.chatId = chatId || '';
    this.log = log;
    this.lastSent = 0;
    this.chain = Promise.resolve();
    this.sent = 0;
    this.failed = 0;
  }

  /**
   * When no chat id is configured, find the group the bot was added to.
   * Reads pending updates without confirming them, so another run can read them too.
   */
  async discoverChat() {
    if (this.chatId) return this.chatId;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?limit=100&timeout=0`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) return null;
      let found = null;
      for (const update of body.result ?? []) {
        const chat =
          update.my_chat_member?.chat ??
          update.message?.chat ??
          update.channel_post?.chat ??
          update.edited_message?.chat;
        if (chat && ['group', 'supergroup', 'channel'].includes(chat.type)) found = chat;
      }
      if (!found) return null;
      this.chatId = String(found.id);
      this.log.info(`chat detectado: ${found.title ?? found.id} (${found.id})`);
      return this.chatId;
    } catch (err) {
      this.log.debug(`getUpdates: ${err.message}`);
      return null;
    }
  }

  send(html) {
    this.chain = this.chain.then(() => this.#send(html)).catch((err) => {
      this.log.error(`telegram: ${err.message}`);
    });
    return this.chain;
  }

  async #send(text) {
    if (!this.chatId) {
      this.log.warn('sem chat id: adicione o bot a um grupo');
      this.failed++;
      return false;
    }
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
