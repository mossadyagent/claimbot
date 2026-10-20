import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('cooldown por mint e dedupe por assinatura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claimbot-'));
  try {
    const path = join(dir, 'state.json');
    const st = new State(path, log);
    st.load();

    assert.equal(st.hasSeen('sig1'), false);
    st.markSeen('sig1');
    assert.equal(st.hasSeen('sig1'), true);

    assert.equal(st.cooling('mint1'), false);
    st.setCooldown('mint1', 30);
    assert.equal(st.cooling('mint1'), true);

    st.save();
    const reloaded = new State(path, log);
    reloaded.load();
    assert.equal(reloaded.hasSeen('sig1'), true);
    assert.equal(reloaded.cooling('mint1'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
