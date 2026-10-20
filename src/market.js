const DS = 'https://api.dexscreener.com/latest/dex/tokens';
const WSOL = 'So11111111111111111111111111111111111111112';
const TTL_MS = 60_000;
const MISS_TTL_MS = 30_000;

/** DexScreener market data: token name/symbol + USD market cap, with a short cache. */
export class Market {
  constructor(log) {
    this.log = log;
    this.cache = new Map();
    this.solCache = { at: 0, price: 0 };
    this.inflight = new Map();
    this.active = 0;
    this.queue = [];
  }

  async token(mint) {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value;
    if (this.inflight.has(mint)) return this.inflight.get(mint);

    const promise = this.#fetchToken(mint)
      .then((value) => {
        this.cache.set(mint, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, promise);
    return promise;
  }

  async solUsd() {
    if (Date.now() - this.solCache.at < TTL_MS) return this.solCache.price;
    try {
      const pairs = await this.#get(`${DS}/${WSOL}`);
      const best = bestPair(pairs);
      const price = Number(best?.priceUsd) || 0;
      if (price > 0) this.solCache = { at: Date.now(), price };
    } catch (err) {
      this.log.debug(`sol price: ${err.message}`);
    }
    return this.solCache.price;
  }

  async #fetchToken(mint) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pairs = await this.#get(`${DS}/${mint}`);
        const best = bestPair(pairs);
        if (!best) return null;
        const mcap = Number(best.marketCap) || Number(best.fdv) || 0;
        return {
          mint,
          name: String(best.baseToken?.name ?? '').trim() || null,
          symbol: String(best.baseToken?.symbol ?? '').trim() || null,
          mcapUsd: mcap,
          dexId: best.dexId ?? null,
          liquidityUsd: Number(best.liquidity?.usd) || 0,
        };
      } catch (err) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
        else this.log.debug(`dexscreener ${mint.slice(0, 8)}: ${err.message}`);
      }
    }
    return null;
  }

  async #get(url) {
    await this.#acquire();
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json?.pairs ?? [];
    } finally {
      this.active--;
      this.#drain();
    }
  }

  #acquire() {
    if (this.active < 4) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  #drain() {
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

function bestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  // Pools sem liquidez são pares mortos: o par "pumpfun" antigo fica congelado no
  // preço da graduação (~US$ 44k) e mentia o market cap. Só usa pool viva.
  const live = pairs.filter((p) => (Number(p.liquidity?.usd) || 0) > 0);
  const pool = live.length > 0 ? live : pairs;
  return pool.reduce((a, b) => ((Number(b.liquidity?.usd) || 0) > (Number(a.liquidity?.usd) || 0) ? b : a));
}
