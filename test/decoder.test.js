import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEvent, decodeLogs, parseNotification, EVENT_DISC } from '../src/decoder.js';
import { decode as decodeB58, encode } from '../src/base58.js';

const HEX = {
  collect:
    '7a027f010ebf0caf06b0d76a00000000f2e3fa4b94e147af5542f929fffa4f4cd4804bd0d1ab239738da68b0b284705115548b0c000000000000000000000000000000000000000000000000000000000000000000000000',
  coin:
    'e8f5c2eeeada3a5906b0d76a00000000b12d8cac65fa017baac57859bade57309f775bdb9bc6dd6e2620c1dbeddc2794e5f517000000000050c8d7dab32055b780d48e53fa4392a759b4ccb625fae16ec58e6107ff600332be5bfd04345349670f24c4e8c1ed768f19e6d5ef8918a8c7508278607926dbbf',
  distribute:
    'a537817004b3ca280ab0d76a00000000abcd37f3025874508d18efe45de99c906019fc6ec8654142a2979ddeffa42b8fde945f99ddd97220bd6b90e31976874e1c6ad0b1f16fac5b22433c7f7398399f91a974b5832f84a5126e90047179f1177964b4f6bb245a62ae383885e6e04212193bf9b1dc951988bff150dc1240fe62b92075fad4bf346c7d6bb63949d7593c01000000a14cf430c2150d07f4e43ba86cd067154930e12ccfde689645c4527b7b98c59210279ec1d000000000000000000000000000000000000000000000000000000000000000000000000000',
};

test('collect_creator_fee: valor, dev e quote SOL', () => {
  const ev = decodeEvent('collect_creator_fee', Buffer.from(HEX.collect, 'hex'));
  assert.equal(ev.amountLamports, 210457621n);
  assert.equal(ev.creator, 'HM9HgAprZCJnfotTADgeMN7ogex8usTg4v62Cy1AXF84');
  assert.equal(ev.quoteMint, null);
});

test('collect_coin_creator_fee: valor do claim na AMM', () => {
  const ev = decodeEvent('collect_coin_creator_fee', Buffer.from(HEX.coin, 'hex'));
  assert.equal(ev.amountLamports, 1570277n);
  assert.equal(ev.coinCreator, 'CvdSukvawHcciHifAYiMcxp7JjYqgtCpxzSeMWEd96EF');
});

test('distribute_creator_fees: mint no evento, valor vem dos saldos', () => {
  const ev = decodeEvent('distribute_creator_fees', Buffer.from(HEX.distribute, 'hex'));
  assert.equal(ev.mint, 'CZeDLLXqSU8MFzvpcHBYDzn7BinUNmTfnrENd8gjpump');
  assert.equal(ev.amountLamports, null);
});

test('buffers curtos nao quebram', () => {
  assert.equal(decodeEvent('collect_creator_fee', Buffer.alloc(10)), null);
  assert.equal(decodeEvent('collect_coin_creator_fee', Buffer.alloc(20)), null);
});

test('decodeLogs ignora ruido e acha o claim', () => {
  const data = 'Program data: ' + Buffer.from(HEX.collect, 'hex').toString('base64');
  const logs = ['Program log: Instruction: CollectCreatorFeeV2', data, 'Program log: done'];
  const events = decodeLogs(logs);
  assert.equal(events.length, 1);
  assert.equal(events[0].amountLamports, 210457621n);
});

test('discriminadores conferem com sha256(event:*)', () => {
  assert.equal(EVENT_DISC['7a027f010ebf0caf'], 'collect_creator_fee');
  assert.equal(EVENT_DISC['a537817004b3ca28'], 'distribute_creator_fees');
  assert.equal(EVENT_DISC['e8f5c2eeeada3a59'], 'collect_coin_creator_fee');
});

test('parseNotification extrai assinatura e logs', () => {
  const n = parseNotification({
    params: {
      result: { context: { slot: 42 }, value: { signature: 'sig', err: null, logs: ['a'] } },
    },
  });
  assert.equal(n.signature, 'sig');
  assert.equal(n.slot, 42);
  assert.deepEqual(n.logs, ['a']);
});

test('base58 ida e volta', () => {
  const bytes = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
  assert.equal(Buffer.from(decodeB58(encode(bytes))).toString('hex'), bytes.toString('hex'));
});
