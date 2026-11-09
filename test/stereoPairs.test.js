import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPairs, sideOf } from '../src/stereoPairs.js';

const inputs = (names) => names.map((name, i) => ({ ch: i, kind: 'input', number: i + 1, name }));
const pairs = (links) => [...links].filter(([a, b]) => a < b).map(([a, b]) => [a + 1, b + 1]);

test('reads left/right endings people actually type', () => {
  assert.deepEqual(sideOf('Keys L'), { base: 'Keys', side: 'L' });
  assert.deepEqual(sideOf('Keys-R'), { base: 'Keys', side: 'R' });
  assert.deepEqual(sideOf('Keys (L)'), { base: 'Keys', side: 'L' });
  assert.deepEqual(sideOf('Keys(R)'), { base: 'Keys', side: 'R' });
  assert.deepEqual(sideOf('Keys Left'), { base: 'Keys', side: 'L' });
  assert.deepEqual(sideOf('GtrL'), { base: 'Gtr', side: 'L' });
  assert.deepEqual(sideOf('Trk2R'), { base: 'Trk2', side: 'R' });
  for (const name of ['Pedal', 'Bass', 'Snare', 'KeysTOP', 'Guitar', 'L', '', 'ROLL', 'VOCAL']) {
    assert.equal(sideOf(name), null, name);
  }
});

test('links neighbouring L/R inputs, left first', () => {
  const links = findPairs(inputs(['Kick', 'Keys L', 'Keys R', 'Gtr R', 'Gtr L', 'Pad L', 'Pad R']));
  assert.deepEqual(pairs(links), [[2, 3], [6, 7]], 'R before L is not a pair');
  assert.equal(links.get(1), 2);
  assert.equal(links.get(2), 1);
});

test('same names stay separate unless the rig turns it on', () => {
  const names = ['Guitar', 'Guitar', 'KeysTOP', 'KeysTOP', 'Ch 5', 'Ch 5'];
  assert.deepEqual(pairs(findPairs(inputs(names))), []);
  assert.deepEqual(pairs(findPairs(inputs(names), { sameName: true })), [[1, 2], [3, 4]], 'default names never pair');
});

test('rig config adds and blocks pairs', () => {
  const names = ['Guitar', 'Guitar', 'Keys L', 'Keys R', 'Synth', 'Synth'];
  const links = findPairs(inputs(names), { pairs: [[6, 5], [8, 9]], unpair: [[3, 4]] });
  assert.deepEqual(pairs(links), [[5, 6]], 'reversed order is fine; missing channels are ignored');
  assert.deepEqual(pairs(findPairs(inputs(names), { pairs: [[1, 3]] })), [[3, 4]], 'only neighbours pair');
});

test('FX returns are never paired', () => {
  const channels = [
    { ch: 0, kind: 'input', number: 1, name: 'Keys L' },
    { ch: 1, kind: 'fx_return', number: 1, name: 'Verb L' },
    { ch: 2, kind: 'fx_return', number: 2, name: 'Verb R' },
  ];
  assert.equal(findPairs(channels).size, 0);
});
