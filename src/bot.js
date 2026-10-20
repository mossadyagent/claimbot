import { AMM, EVENT_LABEL, PUMP, decodeLogs, parseNotification } from './decoder.js';
import { poolBaseMint, receivedLamports, sweptMints } from './attribution.js';
import { formatClaimCard } from './format.js';
import { Rpc, sleep } from './rpc.js';
import { Market } from './market.js';
import { Telegram } from './telegram.js';
import { State } from './state.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_TOKENS_PER_ALERT = 8;
const WSOL = 'So11111111111111111111111111111111111111112';

export class Bot {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.rpc = new Rpc(cfg.rpcUrls, log);
    this.market = new Market(log);
    this.state = new State(cfg.statePath, log);
    this.telegram = cfg.dryRun ? null : new Telegram(cfg.telegramToken, cfg.telegramChatId, log);
    this.minLamports = BigInt(Math.round(cfg.minClaimSol * 1_000_000_000));

    this.ws = null;
    this.wsIdx = 0;
    this.rpcId = 0;
    this.reconnectAttempt = 0;
    this.lastMsgAt = 0;
    this.stopped = false;
    this.poolMints = new Map();
    this.queue = [];
    this.pending = 0;

    this.stats = {
      msgs: 0,
      bytes: 0,
      claims: 0,
      alerts: 0,
      rpc: 0,
      dropped: 0,
      skipped: new Map(),
      startedAt: Date.now(),
      lastReportAt: Date.now(),
      lastReportMsgs: 0,
      lastReportBytes: 0,
    };
  }

  start() {
    this.state.load();
    this.log.info('── ClaimBot ──────────────────────────────');
    this.log.info(`filtro: claim >= ${this.cfg.minClaimSol} SOL · mcap <= ${this.maxMcapLabel()} · cooldown ${this.cfg.cooldownMin}min`);
    this.log.info(`rpc: ${this.rpc.url}`);
    this.log.info(`modo: ${this.cfg.dryRun ? 'DRY-RUN (nao envia no telegram)' : 'AO VIVO'}`);
    this.log.info('aguardando claims... (stream da pump.fun: ~1,8 MB/s; Ctrl+C para parar)');

    this.statsTimer = setInterval(() => this.#report(), 60_000);
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), 15_000);
    this.#connect();

    if (!this.cfg.dryRun && this.cfg.startupMessage) this.#announceOnline();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.statsTimer);
    clearInterval(this.heartbeatTimer);
    try {
      this.ws?.close();
    } catch {}
    this.state.save();
  }

  maxMcapLabel() {
    return this.cfg.maxMcapSol > 0 ? `${this.cfg.maxMcapSol} SOL` : `$${this.cfg.maxMcapUsd}`;
  }

  // ── websocket ────────────────────────────────────────────────────────────

  #connect() {
    if (this.stopped) return;
    const url = this.cfg.wsUrls[this.wsIdx % this.cfg.wsUrls.length];
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.log.error(`ws invalido (${url}): ${err.message}`);
      return this.#scheduleReconnect('url invalida');
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.lastMsgAt = Date.now();
      this.log.info(`conectado: ${safeHost(url)}`);
      const programs = this.cfg.watchAmm ? [PUMP, AMM] : [PUMP];
      for (const program of programs) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: ++this.rpcId,
            method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: 'confirmed' }],
          }),
        );
      }
    });

    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.#scheduleReconnect('conexao fechada');
    });
  }

  #scheduleReconnect(reason) {
    if (this.stopped) return;
    this.reconnectAttempt++;
    this.wsIdx++;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 4));
    this.log.warn(`stream caiu (${reason}); reconectando em ${delay / 1000}s`);
    setTimeout(() => this.#connect(), delay);
  }

  #heartbeat() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState !== 1) return;
    const silentFor = Date.now() - this.lastMsgAt;
    if (silentFor > this.cfg.heartbeatMs) {
      this.log.warn(`stream mudo ha ${Math.round(silentFor / 1000)}s; forcando reconexao`);
      try {
        this.ws.close();
      } catch {}
    }
  }

  #onMessage(data) {
    this.lastMsgAt = Date.now();
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.stats.msgs++;
    this.stats.bytes += text.length;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id) return; // subscription ack

    const notification = parseNotification(msg);
    if (!notification || notification.err) return;

    const events = decodeLogs(notification.logs);
    if (events.length === 0) return;
    this.stats.claims += events.length;
    this.#enqueue(notification, events);
  }

  #enqueue(notification, events) {
    if (this.queue.length > 400) {
      this.stats.dropped++;
      return;
    }
    this.queue.push({ notification, events });
    this.#drain();
  }

  #drain() {
    while (this.pending < 5 && this.queue.length > 0) {
      const job = this.queue.shift();
      this.pending++;
      this.#process(job.notification, job.events)
        .catch((err) => this.log.error(`processamento: ${err.message}`))
        .finally(() => {
          this.pending--;
          this.#drain();
        });
    }
  }

  // ── claim pipeline ───────────────────────────────────────────────────────

  async #process(notification, events) {
    const { signature } = notification;
    if (this.state.hasSeen(signature)) return;
    this.state.markSeen(signature);

    let tx;
    let txFetched = false;
    const getTx = async () => {
      if (txFetched) return tx;
      txFetched = true;
      this.stats.rpc++;
      tx = await this.rpc.getTransaction(signature);
      return tx;
    };

    for (const event of events) {
      const label = EVENT_LABEL[event.type] ?? event.type;

      if (event.quoteMint) {
        this.#skip('moeda_em_outro_quote');
        continue;
      }

      let amountLamports = event.amountLamports;
      if (amountLamports !== null && amountLamports < this.minLamports) {
        this.#skip('abaixo_do_minimo');
        continue;
      }

      const limitUsd = await this.#limitUsd();
      const mints = [];

      // fee sharing: the event already names the coin, so check the market cap
      // before spending an RPC call on the amount.
      if (event.mint) {
        const info = await this.market.token(event.mint);
        const mcap = info?.mcapUsd ?? 0;
        if (mcap <= 0 || mcap > limitUsd) {
          this.#skip('mcap_acima_do_limite');
          continue;
        }
        mints.push(event.mint);
      }

      const parsed = await getTx();
      if (!parsed || parsed.meta?.err) {
        this.#skip('tx_indisponivel');
        continue;
      }

      if (amountLamports === null) amountLamports = receivedLamports(parsed);
      if (amountLamports < this.minLamports) {
        this.#skip('abaixo_do_minimo');
        continue;
      }

      const sweep = sweptMints(parsed);
      if (sweep.quotes.length > 0 && !sweep.quotes.includes(WSOL)) {
        this.#skip('moeda_em_outro_quote');
        continue;
      }
      for (const pool of sweep.pools) {
        const mint = await this.#poolMint(pool);
        if (mint) mints.push(mint);
      }
      mints.push(...sweep.mints);

      const uniqueMints = [...new Set(mints.filter(Boolean))].slice(0, MAX_TOKENS_PER_ALERT);
      if (uniqueMints.length === 0) {
        this.#skip('sem_atribuicao');
        continue;
      }

      const solUsd = await this.market.solUsd();
      const tokens = [];
      for (const mint of uniqueMints) {
        const info = await this.market.token(mint);
        const mcapUsd = info?.mcapUsd ?? 0;
        tokens.push({
          mint,
          name: info?.name ?? null,
          symbol: info?.symbol ?? null,
          mcapUsd,
          qualifies: mcapUsd > 0 && mcapUsd <= limitUsd,
        });
      }

      const amountSol = Number(amountLamports) / Number(LAMPORTS_PER_SOL);
      this.log.debug(
        `candidato ${amountSol.toFixed(2)} SOL (${label}): ${tokens
          .map((t) => `${t.symbol ?? t.mint.slice(0, 4)}=${Math.round(t.mcapUsd / 1000)}k${t.qualifies ? '' : '(alto)'}`)
          .join(' ')}`,
      );

      const winners = tokens.filter((t) => t.qualifies && !this.state.cooling(t.mint));
      if (winners.length === 0) {
        this.#skip(tokens.some((t) => t.qualifies) ? 'cooldown' : 'mcap_acima_do_limite');
        continue;
      }

      if (!this.cfg.dryRun && !(await this.#ensureChat())) {
        this.#skip('sem_grupo');
        continue;
      }
      const html = formatClaimCard({ amountSol, solUsd, tokens, signature, mcapLimit: limitUsd });
      this.stats.alerts++;

      if (this.cfg.dryRun) {
        this.log.info(`[DRY] ${html.replace(/<[^>]+>/g, '').replace(/\n/g, ' | ')}`);
        for (const winner of winners) this.state.setCooldown(winner.mint, this.cfg.cooldownMin);
      } else {
        const lag = parsed.blockTime ? Math.max(0, Math.round(Date.now() / 1000) - parsed.blockTime) : null;
        const ok = await this.telegram.send(html);
        if (!ok) {
          this.#skip('falha_no_telegram');
          continue;
        }
        for (const winner of winners) this.state.setCooldown(winner.mint, this.cfg.cooldownMin);
        this.log.info(
          `alerta: ${amountSol.toFixed(2)} SOL · ${winners.map((t) => t.symbol ?? t.mint.slice(0, 6)).join(', ')} · ${label}${lag !== null ? ` · +${lag}s` : ''}`,
        );
      }
    }
  }

  async #limitUsd() {
    if (!(this.cfg.maxMcapSol > 0)) return this.cfg.maxMcapUsd;
    const solUsd = await this.market.solUsd();
    return solUsd > 0 ? this.cfg.maxMcapSol * solUsd : this.cfg.maxMcapUsd;
  }

  async #poolMint(pool) {
    if (this.poolMints.has(pool)) return this.poolMints.get(pool);
    try {
      this.stats.rpc++;
      const account = await this.rpc.getAccountInfoBase64(pool);
      const mint = account ? poolBaseMint(account.data) : null;
      if (mint) this.poolMints.set(pool, mint);
      return mint;
    } catch (err) {
      this.log.debug(`pool ${pool.slice(0, 8)}: ${err.message}`);
      return null;
    }
  }

  #skip(reason) {
    this.stats.skipped.set(reason, (this.stats.skipped.get(reason) ?? 0) + 1);
  }

  /** Chat id comes from config, or is discovered from the group the bot was added to. */
  async #ensureChat() {
    if (!this.telegram) return true;
    if (this.telegram.chatId) return true;
    return Boolean(await this.telegram.discoverChat());
  }

  async #announceOnline() {
    for (let attempt = 0; !this.stopped; attempt++) {
      if (await this.#ensureChat()) {
        // espera 60s para o card de boot trazer o estado real do stream
        await sleep(60_000);
        const secs = Math.max(1, Math.round((Date.now() - this.stats.startedAt) / 1000));
        const rate = Math.round(this.stats.msgs / secs);
        const warnings = rate === 0 ? '\n⚠️ stream sem dados ainda — pode ser conexão' : '';
        this.telegram.send(
          `✅ <b>ClaimBot online</b>\nstream: ${rate} eventos/s · ${this.stats.claims} claims vistos\nfiltro: ≥ ${this.cfg.minClaimSol} SOL · mcap ≤ ${this.maxMcapLabel()}${warnings}`,
        );
        return;
      }
      if (attempt === 0 || attempt % 10 === 0) {
        this.log.info('esperando o bot ser adicionado a um grupo do Telegram...');
      }
      await sleep(60_000);
    }
  }

  summary() {
    const secs = Math.round((Date.now() - this.stats.startedAt) / 1000);
    const skipped = [...this.stats.skipped.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'nenhum';
    const gb = (this.stats.bytes / 1e9).toFixed(2);
    return `resumo: ${secs}s · ${gb} GB · claims=${this.stats.claims} · alertas=${this.stats.alerts} · rpc=${this.stats.rpc} · pulados: ${skipped}`;
  }

  #report() {
    const now = Date.now();
    const secs = (now - this.stats.lastReportAt) / 1000;
    const dMsgs = this.stats.msgs - this.stats.lastReportMsgs;
    const dBytes = this.stats.bytes - this.stats.lastReportBytes;
    this.stats.lastReportAt = now;
    this.stats.lastReportMsgs = this.stats.msgs;
    this.stats.lastReportBytes = this.stats.bytes;

    const skipped = [...this.stats.skipped.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'nenhum';
    const gb = this.stats.bytes / 1e9;
    this.log.info(
      `eventos/s=${(dMsgs / secs).toFixed(0)} · ${(dBytes / 1024 / secs).toFixed(0)} KB/s · sessao=${gb.toFixed(2)} GB · claims=${this.stats.claims} · alertas=${this.stats.alerts} · rpc=${this.stats.rpc} · fila=${this.queue.length} · pulados: ${skipped}`,
    );

    if (this.cfg.maxSessionGb > 0 && gb >= this.cfg.maxSessionGb) {
      this.log.warn(`limite de ${this.cfg.maxSessionGb} GB da sessao atingido; encerrando`);
      this.stop();
      this.onBudgetExhausted?.();
    }
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'ws';
  }
}
