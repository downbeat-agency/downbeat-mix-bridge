import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, sleep } from './helpers.js';
import { paramKey } from '../src/model.js';

test('phone signs in, picks its mix and gets live names, colors and levels', async () => {
  const rig = await startBridge();
  try {
    const sax = await rig.client({ personId: 'p-sax', name: 'Sax', bus: 4 });
    const s = sax.snapshot;
    assert.equal(s.bus, 4);
    assert.equal(s.channels[0].name, 'Kick');
    assert.equal(s.channels[0].color, 'yellow');
    assert.equal(s.channels[40].color, null, 'uncolored channels stay uncolored');
    assert.equal(s.sends.length, 64);
    assert.equal(s.sends[0].level, -10);
    assert.equal(s.capabilities.sendPan, true);
    assert.equal(s.buses.length, 12);
  } finally {
    await rig.close();
  }
});

test('writes before a snapshot are refused (read before write)', async () => {
  const rig = await startBridge();
  try {
    const c = await rig.client({ personId: 'p1' });
    c.send({ type: 'set', bus: 2, ch: 0, field: 'level', value: -3, seq: 7 });
    const err = await c.next('error');
    assert.equal(err.code, 'not_ready');
    assert.equal(err.seq, 7);
  } finally {
    await rig.close();
  }
});

test('a fader move reaches the console and every other phone on that mix, not other mixes', async () => {
  const rig = await startBridge();
  try {
    const a = await rig.client({ personId: 'drums-1', bus: 8 });
    const b = await rig.client({ personId: 'drums-2', bus: 8 });
    const other = await rig.client({ personId: 'bass', bus: 9 });
    a.send({ type: 'set', bus: 8, ch: 1, field: 'level', value: -4.26 });
    const seen = await b.next('changed');
    assert.deepEqual({ bus: seen.bus, ch: seen.ch, field: seen.field, value: seen.value }, { bus: 8, ch: 1, field: 'level', value: -4.3 });
    assert.notEqual(seen.origin, 'console', 'origin is the sending phone, so it can ignore its own echo');
    await sleep(60);
    assert.equal(rig.driver.values.get(paramKey(8, 1, 'level')), -4.3);
    assert.equal(other.drain('changed').length, 0);
    assert.equal(a.drain('changed').length, 0, 'sender does not get its own move echoed back');
  } finally {
    await rig.close();
  }
});

test('rapid fader drags are merged so the console is not flooded', async () => {
  const rig = await startBridge({ bridgeOptions: { flushIntervalMs: 20 } });
  try {
    const c = await rig.client({ personId: 'p', bus: 0 });
    for (let i = 0; i < 300; i++) c.send({ type: 'set', bus: 0, ch: 3, field: 'level', value: -30 + i * 0.1 });
    await sleep(250);
    assert.equal(rig.driver.values.get(paramKey(0, 3, 'level')), -0.1);
    assert.ok(rig.driver.writes < 60, `expected merged writes, got ${rig.driver.writes}`);
    assert.ok(rig.bridge.stats.writesMerged > 200);
  } finally {
    await rig.close();
  }
});

test('only monitor mix parameters can be changed', async () => {
  const rig = await startBridge({ bridgeOptions: { allowedBuses: [0, 1, 2] } });
  try {
    const c = await rig.client({ personId: 'p', bus: 1 });
    const cases = [
      [{ bus: 1, ch: 0, field: 'trim', value: 10 }, 'bad_field'],
      [{ bus: 1, ch: 0, field: 'eq', value: 1 }, 'bad_field'],
      [{ bus: 1, ch: 999, field: 'level', value: 0 }, 'bad_channel'],
      [{ bus: 1, ch: 0, field: 'level', value: 'loud' }, 'bad_value'],
      [{ bus: 1, ch: 0, field: 'mute', value: 1 }, 'bad_value'],
      [{ bus: 5, ch: 0, field: 'level', value: 0 }, 'not_ready'],
    ];
    for (const [cmd, code] of cases) {
      c.send({ type: 'set', ...cmd });
      assert.equal((await c.next('error')).code, code, JSON.stringify(cmd));
    }
    c.send({ type: 'select', bus: 7 });
    assert.equal((await c.next('error')).code, 'bus_not_allowed');
  } finally {
    await rig.close();
  }
});

test('values are clamped and -inf is null', async () => {
  const rig = await startBridge();
  try {
    const a = await rig.client({ personId: 'a', bus: 0 });
    const b = await rig.client({ personId: 'b', bus: 0 });
    a.send({ type: 'set', bus: 0, ch: 0, field: 'level', value: 40 });
    assert.equal((await b.next('changed')).value, 10);
    a.send({ type: 'set', bus: 0, ch: 0, field: 'level', value: -200 });
    assert.equal((await b.next('changed')).value, null);
    a.send({ type: 'set', bus: 0, ch: 0, field: 'pan', value: -3 });
    assert.equal((await b.next('changed')).value, -1);
  } finally {
    await rig.close();
  }
});

test('changes made on the desk show up on phones', async () => {
  const rig = await startBridge();
  try {
    const c = await rig.client({ personId: 'p', bus: 3 });
    rig.driver.deskChange(3, 5, 'mute', true);
    const m = await c.next('changed');
    assert.deepEqual([m.ch, m.field, m.value, m.origin], [5, 'mute', true, 'console']);
    rig.driver.deskRelabel(5, { name: 'Lead Vox', color: 'blue' });
    const l = await c.next('layout');
    assert.equal(l.channels[0].name, 'Lead Vox');
  } finally {
    await rig.close();
  }
});

test('console drop refuses writes, drops the queue, and re-sends snapshots on reconnect', async () => {
  const rig = await startBridge({ bridgeOptions: { flushIntervalMs: 200 } });
  try {
    const c = await rig.client({ personId: 'p', bus: 2 });
    c.send({ type: 'set', bus: 2, ch: 0, field: 'level', value: 5 }); // queued, not yet flushed
    await sleep(20);
    rig.driver.dropConnection();
    assert.equal((await c.next('console')).connected, false);
    assert.equal(rig.bridge.pending.size, 0, 'queued write discarded');
    c.send({ type: 'set', bus: 2, ch: 0, field: 'level', value: 6 });
    assert.equal((await c.next('error')).code, 'console_offline');
    await rig.driver.connect();
    assert.equal((await c.next('console')).connected, true);
    const snap = await c.next('snapshot');
    assert.equal(snap.bus, 2);
    assert.equal(rig.driver.values.get(paramKey(2, 0, 'level')), -10, 'stale write never reached the console');
  } finally {
    await rig.close();
  }
});

test('rig token is required when configured', async () => {
  const rig = await startBridge({ bridgeOptions: { sharedToken: 'secret' } });
  try {
    const bad = await rig.client();
    bad.send({ type: 'hello', personId: 'x', token: 'nope' });
    assert.equal((await bad.next('error')).code, 'unauthorized');
    const good = await rig.client({ personId: 'y', token: 'secret', bus: 0 });
    assert.equal(good.snapshot.bus, 0);
  } finally {
    await rig.close();
  }
});

test('meters are only sent to phones that ask for them', async () => {
  const rig = await startBridge();
  try {
    const on = await rig.client({ personId: 'a', bus: 0, meters: true });
    const off = await rig.client({ personId: 'b', bus: 0 });
    const m = await on.next('meters');
    assert.equal(m.ch.length, 64);
    assert.equal(typeof m.master, 'number');
    await sleep(100);
    assert.equal(off.drain('meters').length, 0);
  } finally {
    await rig.close();
  }
});

test('phones on a mix are told who else is on it, and when someone leaves', async () => {
  const rig = await startBridge();
  try {
    const owner = await rig.client({ personId: 'p-keys', name: 'Keys', bus: 10 });
    const first = await owner.next('presence');
    assert.deepEqual(first.people.map((p) => p.name), ['Keys']);
    const helper = await rig.client({ personId: 'p-diego', name: 'Diego', bus: 10 });
    const both = await owner.next('presence');
    assert.deepEqual(both.people.map((p) => p.name).sort(), ['Diego', 'Keys']);
    assert.equal((await helper.next('presence')).people.length, 2);
    helper.send({ type: 'select', bus: 3 });
    const after = await owner.next('presence');
    assert.deepEqual(after.people.map((p) => p.name), ['Keys']);
  } finally {
    await rig.close();
  }
});

test('welcome lists the mixes so a phone can open on its own mix by name', async () => {
  const rig = await startBridge({ bridgeOptions: { allowedBuses: [0, 1, 2], version: '9.9.9' } });
  try {
    const c = await rig.client();
    c.send({ type: 'hello', personId: 'p' });
    const w = await c.next('welcome');
    assert.equal(w.bridgeVersion, '9.9.9', 'phones show the bridge version');
    assert.equal(rig.bridge.health().version, '9.9.9');
    assert.equal(rig.bridge.isIdle(0), false, 'a phone is connected');
    assert.deepEqual(w.buses.map((b) => b.bus), [0, 1, 2]);
    assert.equal(w.buses[0].name, 'Stereo Mix 1 MC');
  } finally {
    await rig.close();
  }
});

test('gain is channel-wide: every phone on every mix hears about it, clamped to the preamp', async () => {
  const audit = [];
  const rig = await startBridge({ bridgeOptions: { onAudit: (e) => audit.push(e) } });
  try {
    const gtr = await rig.client({ personId: 'p-gtr', name: 'Gtr', bus: 7 });
    const sax = await rig.client({ personId: 'p-sax', name: 'Sax', bus: 4 });
    assert.deepEqual(gtr.snapshot.channels[8].preamp, { source: 'headamp', min: 5, max: 60, step: 0.5, phantom: true });
    assert.deepEqual(gtr.snapshot.preamps[8], { ch: 8, gain: 30, phantom: false });
    assert.equal(gtr.snapshot.capabilities.gain, true);

    gtr.send({ type: 'set', bus: 7, ch: 8, field: 'gain', value: 34.5 });
    const seen = await sax.next('changed');
    assert.deepEqual([seen.bus, seen.ch, seen.field, seen.value], [null, 8, 'gain', 34.5], 'a phone on another mix sees it');
    await sleep(80);
    assert.equal(rig.driver.values.get(paramKey(null, 8, 'gain')), 34.5);
    assert.deepEqual(audit.at(-1), { ...audit.at(-1), name: 'Gtr', bus: null, ch: 8, field: 'gain', value: 34.5 });

    gtr.send({ type: 'set', bus: 7, ch: 8, field: 'gain', value: 99 });
    assert.equal((await sax.next('changed')).value, 60, 'clamped to the preamp top');

    await sleep(80); // let the phone's write land before the desk moves it
    rig.driver.deskChange(null, 8, 'gain', 28);
    assert.equal((await gtr.next('changed')).value, 28, 'the A1 moving gain shows on phones');
  } finally {
    await rig.close();
  }
});

test('phantom power: only where the channel has it, and only once the phone has a snapshot', async () => {
  const rig = await startBridge();
  try {
    const c = await rig.client({ personId: 'p', bus: 0 });
    const other = await rig.client({ personId: 'q', bus: 2 });
    assert.equal(c.snapshot.channels[40].preamp.phantom, false, 'card input: trim only');
    assert.equal(c.snapshot.preamps[40].phantom, null);

    c.send({ type: 'set', ch: 40, field: 'phantom', value: true });
    assert.equal((await c.next('error')).code, 'unsupported');
    c.send({ type: 'set', ch: 0, field: 'phantom', value: 'on' });
    assert.equal((await c.next('error')).code, 'bad_value');
    c.send({ type: 'set', ch: 999, field: 'gain', value: 10 });
    assert.equal((await c.next('error')).code, 'bad_channel');

    c.send({ type: 'set', ch: 0, field: 'phantom', value: true });
    const seen = await other.next('changed');
    assert.deepEqual([seen.ch, seen.field, seen.value], [0, 'phantom', true]);
    await sleep(60);
    assert.equal(rig.driver.values.get(paramKey(null, 0, 'phantom')), true);

    const late = await rig.client({ personId: 'r' }); // signed in, no mix picked yet
    late.send({ type: 'set', ch: 0, field: 'gain', value: 40 });
    assert.equal((await late.next('error')).code, 'not_ready');
  } finally {
    await rig.close();
  }
});
