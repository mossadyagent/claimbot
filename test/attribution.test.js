import test from 'node:test';
import assert from 'node:assert/strict';
import { SWEEP_DISC, poolBaseMint, receivedLamports, sweptMints } from '../src/attribution.js';
import { AMM, PUMP } from '../src/decoder.js';
import { decode, encode } from '../src/base58.js';

const MINT = 'CZeDLLXqSU8MFzvpcHBYDzn7BinUNmTfnrENd8gjpump';
const POOL = 'AmmpSnW5xVeKHTAU9fMjyKEMPgrzmUj3ah5vgvHhAB5J';
const sweepData = encode(Buffer.concat([Buffer.from(SWEEP_DISC, 'hex'), Buffer.alloc(4)]));

function txWith(instructions, balances) {
  return {
    transaction: { message: { instructions, accountKeys: ['payer', 'a', 'b', 'c'] } },
    meta: balances,
  };
}

test('sweep na curva entrega o mint em accounts[2]', () => {
  const tx = txWith([
    { programId: PUMP, accounts: ['payer', 'global', MINT, 'wsol'], data: sweepData },
  ]);
  assert.deepEqual(sweptMints(tx), { mints: [MINT], pools: [], quotes: ['wsol'] });
});

test('sweep na AMM entrega o pool em accounts[2]', () => {
  const tx = txWith([{ programId: AMM, accounts: ['payer', 'config', POOL], data: sweepData }]);
  assert.deepEqual(sweptMints(tx), { mints: [], pools: [POOL], quotes: [] });
});

test('ignora instrucoes que nao sao sweep', () => {
  const other = encode(Buffer.from('1416567bc61cdb84ffffffff', 'hex'));
  const tx = txWith([{ programId: PUMP, accounts: ['a', 'b', MINT], data: other }]);
  assert.deepEqual(sweptMints(tx), { mints: [], pools: [], quotes: [] });
});

test('sem duplicata quando o mesmo mint aparece duas vezes', () => {
  const tx = txWith([
    { programId: PUMP, accounts: ['p', 'g', MINT], data: sweepData },
    { programId: PUMP, accounts: ['p', 'g', MINT], data: sweepData },
  ]);
  assert.deepEqual(sweptMints(tx).mints, [MINT]);
});

test('pool -> base_mint no offset 43', () => {
  const buf = Buffer.alloc(150);
  decode(MINT).copy(buf, 43);
  assert.equal(poolBaseMint(buf), MINT);
  assert.equal(poolBaseMint(Buffer.alloc(40)), null);
});

test('recebido = soma dos saldos positivos, ignorando o pagador', () => {
  const tx = txWith([], {
    preBalances: [1_000_000_000, 0, 5_000_000, 0],
    postBalances: [999_775_000, 13_456_053, 5_000_000 - 4_685_757, 0],
  });
  assert.equal(receivedLamports(tx), 13_456_053n);
});
