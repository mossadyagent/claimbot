/** Minimal Solana JSON-RPC client: single-flight queue, rate limit, retry on 429/HTTP errors. */
export class Rpc {
  constructor(urls, log, { minGapMs = 250, maxSupportedTransactionVersion = 1 } = {}) {
    this.urls = urls.length ? urls : ['https://api.mainnet-beta.solana.com'];
    this.log = log;
    this.idx = 0;
    this.id = 0;
    this.minGapMs = minGapMs;
    this.txVersion = maxSupportedTransactionVersion;
    this.lastCallAt = 0;
    this.chain = Promise.resolve();
  }

  get url() {
    return this.urls[this.idx % this.urls.length];
  }

  rotate() {
    this.idx = (this.idx + 1) % this.urls.length;
  }

  /** Serialised so a burst of claims cannot trip the provider's rate limit. */
  call(method, params) {
    const run = () => this.#callWithRetry(method, params);
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async #callWithRetry(method, params) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const gap = this.minGapMs - (Date.now() - this.lastCallAt);
      if (gap > 0) await sleep(gap);
      this.lastCallAt = Date.now();

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          await sleep(Math.max(retryAfter * 1000, 800 * 2 ** attempt));
          this.rotate();
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        if (json.error) throw new Error(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
        return json.result;
      } catch (err) {
        if (attempt === 3) throw err;
        await sleep(600 * 2 ** attempt);
        this.rotate();
      }
    }
    return null;
  }

  async getTransaction(signature) {
    return (
      (await this.call('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: this.txVersion,
          commitment: 'confirmed',
        },
      ])) ?? null
    );
  }

  async getAccountInfoBase64(pubkey) {
    const res = await this.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
    const value = res?.value;
    if (!value) return null;
    return { owner: value.owner, data: Buffer.from(value.data[0], 'base64') };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
