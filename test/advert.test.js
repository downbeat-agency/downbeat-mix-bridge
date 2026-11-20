import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advertTxt, localIPv4 } from '../src/advert.js';

test('lists reachable IPv4 addresses only, once each', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: '192.168.20.86', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    en1: [{ address: '10.0.30.212', family: 4, internal: false }],
    en9: [{ address: '169.254.3.4', family: 'IPv4', internal: false }],
    bridge0: [{ address: '192.168.20.86', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(localIPv4(ifaces), ['192.168.20.86', '10.0.30.212']);
});

test('TXT carries the rig name and its addresses', () => {
  assert.deepEqual(advertTxt('Wing Pink', '10.0.30.212,192.168.20.86'), ['rig=Wing Pink', 'addrs=10.0.30.212,192.168.20.86']);
  assert.deepEqual(advertTxt('Wing Pink', ''), ['rig=Wing Pink']);
});
