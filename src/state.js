import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_SEEN = 5000;

/** Durable dedupe + cooldown state, written atomically (tmp + rename). */
export class State {
  constructor(path, log) {
    this.path = path;
    this.log = log;
    this.seen = new Set();
    this.seenOrder = [];
    this.cooldowns = new Map();
    this.dirty = false;
    this.timer = null;
  }

  load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const sig of raw.seen ?? []) this.seen.add(sig);
      this.seenOrder = [...this.seen];
      const now = Date.now();
      for (const [mint, until] of Object.entries(raw.cooldowns ?? {})) {
        if (Number(until) > now) this.cooldowns.set(mint, Number(until));
      }
      this.log.info(`estado: ${this.seen.size} assinaturas, ${this.cooldowns.size} cooldowns`);
    } catch (err) {
      this.log.warn(`estado corrompido, comecando limpo: ${err.message}`);
    }
  }

  hasSeen(sig) {
    return this.seen.has(sig);
  }

  markSeen(sig) {
    if (this.seen.has(sig)) return;
    this.seen.add(sig);
    this.seenOrder.push(sig);
    if (this.seenOrder.length > MAX_SEEN) {
      const drop = this.seenOrder.shift();
      this.seen.delete(drop);
    }
    this.#touch();
  }

  cooling(mint) {
    const until = this.cooldowns.get(mint) ?? 0;
    return until > Date.now();
  }

  setCooldown(mint, minutes) {
    this.cooldowns.set(mint, Date.now() + minutes * 60_000);
    this.#touch();
  }

  #touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 2000);
  }

  save() {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload = JSON.stringify({
        seen: this.seenOrder,
        cooldowns: Object.fromEntries(this.cooldowns),
      });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, payload);
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (err) {
      this.log.warn(`nao consegui salvar estado: ${err.message}`);
    }
  }
}
