const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** First 8 bytes of an instruction data field (anchor discriminator) as hex. */
export function discriminatorOf(dataB58) {
  try {
    return decode(dataB58).subarray(0, 8).toString('hex');
  } catch {
    return null;
  }
}
