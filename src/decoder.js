import { encode as b58 } from './base58.js';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

/** Anchor event discriminators: sha256("event:Name")[0..8]. */
export const EVENT_DISC = {
  '7a027f010ebf0caf': 'collect_creator_fee',
  'a537817004b3ca28': 'distribute_creator_fees',
  'e8f5c2eeeada3a59': 'collect_coin_creator_fee',
};

export const EVENT_LABEL = {
  collect_creator_fee: 'claim (curva)',
  collect_coin_creator_fee: 'claim (AMM)',
  distribute_creator_fees: 'claim (fee sharing)',
};

const WSOL = 'So11111111111111111111111111111111111111112';
const ZERO = '11111111111111111111111111111111';

/**
 * Decode one anchor event payload (bytes after the 8-byte discriminator is included).
 * Returns null when the buffer is too short or the layout is unknown.
 */
export function decodeEvent(type, buf) {
  if (!buf || buf.length < 16) return null;
  const quoteMint = (off) => {
    if (buf.length < off + 32) return null;
    const pk = b58(buf.subarray(off, off + 32));
    return pk === WSOL || pk === ZERO ? null : pk;
  };

  if (type === 'collect_creator_fee') {
    if (buf.length < 56) return null;
    const amountLamports = buf.readBigUInt64LE(48);
    const creator = b58(buf.subarray(16, 48));
    return { type, amountLamports, creator, recipient: creator, quoteMint: quoteMint(56) };
  }

  if (type === 'collect_coin_creator_fee') {
    if (buf.length < 56) return null;
    const amountLamports = buf.readBigUInt64LE(48);
    const coinCreator = b58(buf.subarray(16, 48));
    return { type, amountLamports, coinCreator, recipient: coinCreator, quoteMint: null };
  }

  if (type === 'distribute_creator_fees') {
    // timestamp(8) mint(32) bonding_curve(32) sharing_config(32) admin(32)
    // Vec<Shareholder{address(32), share_bps(u16)}>  distributed(u64)  quote_mint(32)
    if (buf.length < 148) return null;
    const count = buf.readUInt32LE(144);
    const off = 148 + count * 34;
    if (count > 64 || buf.length < off + 8) return null;
    const recipient = count > 0 ? b58(buf.subarray(148, 180)) : null;
    return {
      type,
      mint: b58(buf.subarray(16, 48)),
      amountLamports: buf.readBigUInt64LE(off),
      admin: b58(buf.subarray(112, 144)),
      recipient,
      quoteMint: quoteMint(off + 8),
    };
  }

  return null;
}

/** All claim events contained in a log array. */
export function decodeLogs(logs) {
  const out = [];
  for (const line of logs || []) {
    if (!line.startsWith('Program data: ')) continue;
    let bytes;
    try {
      bytes = Buffer.from(line.slice('Program data: '.length).trim(), 'base64');
    } catch {
      continue;
    }
    if (bytes.length < 8) continue;
    const disc = bytes.subarray(0, 8).toString('hex');
    const type = EVENT_DISC[disc];
    if (!type) continue;
    const event = decodeEvent(type, bytes);
    if (event) out.push(event);
  }
  return out;
}

/** Normalise a logsSubscribe notification. */
export function parseNotification(message) {
  const value = message?.params?.result?.value;
  if (!value || typeof value.signature !== 'string') return null;
  return {
    signature: value.signature,
    slot: message.params.result.context?.slot ?? 0,
    err: value.err ?? null,
    logs: value.logs ?? [],
  };
}
