import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClaimCard, formatMcap } from '../src/format.js';

const MINT = 'CZeDLLXqSU8MFzvpcHBYDzn7BinUNmTfnrENd8gjpump';

const base = {
  amountSol: 12.43,
  solUsd: 170,
  signature: '5eRtBDTjSLHjz4UpttytX7n9pa5iGqd4hHjwzwg97QMDsJECURQdTt4jE5z9Ek8g4aDAKuQkiuM66NsY9vBTL6ho',
  mcapLimit: 500000,
};

test('card de um token traz nome, valor, CA e mcap', () => {
  const html = formatClaimCard({
    ...base,
    tokens: [{ mint: MINT, name: 'Hoard Capital', symbol: 'HOARD', mcapUsd: 412000, qualifies: true }],
  });
  assert.match(html, /CLAIM 12\.43 SOL/);
  assert.match(html, /Hoard Capital/);
  assert.match(html, /HOARD/);
  assert.match(html, /\$412K/);
  assert.match(html, new RegExp(MINT));
  assert.match(html, /axiom\.trade\/t\//);
  assert.match(html, /✅/);
});

test('card escapa HTML vindo do token', () => {
  const html = formatClaimCard({
    ...base,
    tokens: [{ mint: MINT, name: '<b>hack</b>', symbol: null, mcapUsd: 1000, qualifies: true }],
  });
  assert.ok(!html.includes('<b>hack</b>'));
  assert.ok(html.includes('&lt;b&gt;hack&lt;/b&gt;'));
});

test('card com varios tokens marca quais passaram', () => {
  const html = formatClaimCard({
    ...base,
    tokens: [
      { mint: MINT, name: 'A', symbol: 'A', mcapUsd: 100000, qualifies: true },
      { mint: 'So11111111111111111111111111111111111111112', name: 'B', symbol: 'B', mcapUsd: 900000, qualifies: false },
    ],
  });
  assert.match(html, /2 tokens/);
  assert.match(html, /✅ A/);
  assert.match(html, /▫️ B/);
});

test('formatMcap', () => {
  assert.equal(formatMcap(412000), '$412K');
  assert.equal(formatMcap(1_250_000), '$1.25M');
  assert.equal(formatMcap(0), '?');
});
