import { discriminatorOf, encode as b58 } from './base58.js';
import { PUMP, AMM } from './decoder.js';

/** sweep_creator_fee / sweep_protocol_fee share the same discriminator on both programs. */
export const SWEEP_DISC = '20f6bf3408c949ba';

/** Offset of `base_mint` inside a PumpSwap Pool account (8 disc + 1 bump + 2 index + 32 creator). */
const POOL_BASE_MINT_OFFSET = 43;

/**
 * Mints touched by sweeps in a claim transaction.
 * Pump sweep: accounts[2] is `base_mint`.
 * PumpSwap sweep: accounts[2] is `pool`; the mint needs one more read.
 */
export function sweptMints(tx) {
  const ixs = tx?.transaction?.message?.instructions ?? [];
  const mints = [];
  const pools = [];
  const quotes = [];
  for (const ix of ixs) {
    if (!ix || ix.parsed || !ix.data) continue;
    if (discriminatorOf(ix.data) !== SWEEP_DISC) continue;
    const accounts = ix.accounts ?? [];
    const target = accounts[2];
    if (!target) continue;
    if (ix.programId === PUMP) mints.push(target);
    else if (ix.programId === AMM) pools.push(target);
    if (accounts[3]) quotes.push(accounts[3]);
  }
  return { mints: [...new Set(mints)], pools: [...new Set(pools)], quotes: [...new Set(quotes)] };
}

/** base_mint from a PumpSwap Pool account buffer. */
export function poolBaseMint(buf) {
  if (!buf || buf.length < POOL_BASE_MINT_OFFSET + 32) return null;
  return b58(buf.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
}

/**
 * Lamports that actually landed in recipients' wallets in this transaction.
 * Used for fee-sharing claims, whose event does not expose the paid amount.
 * Index 0 is the fee payer, so its balance change is ignored.
 */
export function receivedLamports(tx) {
  const meta = tx?.meta;
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  if (!meta?.preBalances || !meta?.postBalances) return 0n;
  let sum = 0n;
  for (let i = 1; i < keys.length; i++) {
    const delta = BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
    if (delta > 0n) sum += delta;
  }
  return sum;
}
