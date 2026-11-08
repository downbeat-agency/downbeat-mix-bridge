// Drives the real MixingStationDriver against a pretend Mixing Station that copies the
// behaviour seen on the Green rig Mac Mini (Mixing Station 3.2.2, dLive offline, 2026-11-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { attachWebSocket } from '../src/wsServer.js';
import { MixingStationDriver } from '../src/drivers/mixingStation.js';
import { paramKey } from '../src/model.js';

// 4 inputs; send targets laid out like the real Green rig show file (2026-11-07):
// mono BandSUB + wedges, then stereo IEMs, then an unnamed spare, then groups/FX.
const MONO = ['BandSUB', 'MON 1', 'MON 2', 'MON 3'];
const STEREO = ['MC', 'VOX 2', 'DRUMS', 'Mix 13'];
const TARGETS = [
  ...MONO.map((name, i) => ({ isChannel: true, name, id: i, channelIndex: 152 + i, channelType: { type: 4, stereo: false } })),
  ...STEREO.map((name, i) => ({ isChannel: true, name, id: 4 + i, channelIndex: 156 + i, channelType: { type: 4, stereo: true } })),
  { isChannel: true, name: 'Grp 1', id: 7, channelIndex: 159, channelType: { type: 5, stereo: false } },
  { isChannel: true, name: 'FxSnd 1', id: 11, channelIndex: 163, channelType: { type: 2, stereo: false } },
];

// Inputs at 0..3; FX returns live elsewhere in the shared index space (200, 201).
const CHANNEL_TYPES = [
  { type: 0, name: 'Input', count: 4, offset: 0 },
  { type: 4, name: 'Mix', count: 8, offset: 152 },
  { type: 7, name: 'FX Return', shortName: 'FX Ret', count: 2, offset: 200 },
];

function fakeMixingStation({ users = { admin: '' }, info = {} } = {}) {
  const data = new Map([
    ['ch.200.cfg.name', 'Vox Verb'],
    ['ch.200.cfg.color', 5],
    ['ch.200.mix.sends.4.lvl', -10],
    ['ch.0.cfg.name', 'Kick'],
    ['ch.0.cfg.color', 3],
    ['ch.1.cfg.name', 'Vox 2'],
    ['ch.1.cfg.color', 0],
    ['ch.156.cfg.name', 'MC'],
    ['ch.156.mix.lvl', 0],
    ['ch.156.mix.on', true],
    ['ch.0.preamp.trim', 0],
  ]);
  for (let ch = 0; ch < 4; ch++) {
    for (const t of TARGETS) {
      data.set(`ch.${ch}.mix.sends.${t.id}.lvl`, ch === 0 ? -12 : -90);
      data.set(`ch.${ch}.mix.sends.${t.id}.on`, ch !== 1);
      if (t.channelType.stereo) data.set(`ch.${ch}.mix.sends.${t.id}.pan`, ch === 0 ? 18.5 : 0);
    }
  }
  const conns = new Set();
  const server = createServer();
  attachWebSocket(server, '/', (conn) => {
    conns.add(conn);
    conn.authed = false;
    conn.on('close', () => conns.delete(conn));
    const reply = (msg, body, error) => conn.send(JSON.stringify({ path: msg.path, method: msg.method, ...(error ? { error } : { body }) }));
    const push = (c, p) => c.send(JSON.stringify({ path: `/console/data/get/${p}`, method: 'GET', body: { fade: 0, format: 'val', value: data.get(p) } }));
    conn.on('message', (text) => {
      const msg = JSON.parse(text);
      if (msg.path === '/app/state') return reply(msg, { topState: 'connected', state: 'connected' });
      if (msg.path === '/auth/login') {
        if (msg.body.user in users && users[msg.body.user] === msg.body.password) {
          conn.authed = true;
          return reply(msg, { roles: ['apiWrite'], publicMixes: [], token: 't' });
        }
        return reply(msg, null, 'Invalid credentials');
      }
      if (msg.path === '/console/information') return reply(msg, { ...info, channelTypes: CHANNEL_TYPES });
      if (msg.path === '/console/mixTargets') return reply(msg, { targets: TARGETS });
      if (msg.path.startsWith('/console/data/definitions/')) return reply(msg, { definitions: { x: { definition: { min: -37, max: 37 } } } });
      if (msg.path === '/console/data/subscribe') {
        const re = new RegExp('^' + msg.body.path.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
        for (const p of data.keys()) if (re.test(p)) push(conn, p);
        return;
      }
      if (msg.path === '/console/metering2/subscribe') {
        conn.send(JSON.stringify({ path: '/console/metering2/0', body: { v: msg.body.params.map((p) => (p.index >= 156 ? [-20, -22] : -30 - p.index)) } }));
        return;
      }
      if (msg.path.startsWith('/console/data/set/')) {
        if (!conn.authed) return reply(msg, null, 'Access Denied');
        const p = msg.path.slice('/console/data/set/'.length).replace(/\/val$/, '');
        data.set(p, msg.body.value);
        // Like the real thing: no reply on success, just the value update.
        for (const c of conns) push(c, p);
      }
    });
  });
  return {
    data,
    server,
    push(p, v) {
      data.set(p, v);
      for (const c of conns) c.send(JSON.stringify({ path: `/console/data/get/${p}`, method: 'GET', body: { fade: 0, format: 'val', value: v } }));
    },
    mixerOffline() {
      for (const c of conns) c.send(JSON.stringify({ path: '/app/state', method: 'GET', body: { topState: 'connecting' } }));
    },
  };
}

async function setup(driverConfig = {}, msOptions = {}) {
  const ms = fakeMixingStation(msOptions);
  await new Promise((r) => ms.server.listen(0, '127.0.0.1', r));
  const driver = new MixingStationDriver({ wsUrl: `ws://127.0.0.1:${ms.server.address().port}/`, settleMs: 50, quietMs: 150, writeErrorWindowMs: 60, auth: { user: 'admin', password: '' }, ...driverConfig });
  const connected = new Promise((r) => driver.once('status', r));
  driver.firstMeters = new Promise((r) => driver.once('meters', r));
  await driver.connect();
  await connected;
  return {
    ms,
    driver,
    close: async () => {
      await driver.close();
      ms.server.closeAllConnections?.();
      await new Promise((r) => ms.server.close(r));
    },
  };
}

test('offers only named stereo IEM mixes: no sub, wedges, spares, groups or FX', async () => {
  const { driver, close } = await setup();
  try {
    const s = driver.snapshot();
    assert.deepEqual(s.buses.map((b) => b.name), ['MC', 'VOX 2', 'DRUMS']);
    assert.deepEqual(s.buses[0], { bus: 0, name: 'MC', stereo: true });
    assert.equal(s.channels.length, 6, '4 inputs then 2 FX returns');
    assert.equal(s.channels[0].name, 'Kick');
    assert.equal(s.channels[0].color, 'yellow');
    assert.equal(s.channels[1].color, null, 'black (0) means no color');
    assert.equal(s.capabilities.sendPan, true);
  } finally {
    await close();
  }
});

test('busFilter can opt mono mixes back in by name', async () => {
  const { driver, close } = await setup({ busFilter: { includeNames: ['MON 1', 'MC'] } });
  try {
    const s = driver.snapshot();
    assert.deepEqual(s.buses.map((b) => [b.name, b.stereo]), [['MON 1', false], ['MC', true]]);
    await assert.rejects(driver.set(0, 0, 'pan', 0), /not supported/, 'mono mixes have no pan');
  } finally {
    await close();
  }
});

test('reads sends, mute, pan and master through the mix target mapping', async () => {
  const { driver, close } = await setup();
  try {
    const v = driver.snapshot().values;
    assert.equal(v.get(paramKey(0, 0, 'level')), -12);
    assert.equal(v.get(paramKey(0, 0, 'mute')), false, 'on=true means not muted');
    assert.equal(v.get(paramKey(0, 1, 'mute')), true);
    assert.equal(v.get(paramKey(0, 0, 'pan')), 0.5, '18.5 on a -37..37 scale');
    assert.equal(v.get(paramKey(0, 1, 'level')), null, '-90 dB is off');
    assert.equal(v.get(paramKey(0, null, 'level')), 0, 'MC master is ch.156');
  } finally {
    await close();
  }
});

test('writes land on the right Mixing Station paths', async () => {
  const { ms, driver, close } = await setup();
  try {
    await driver.set(1, 2, 'level', -6); // VOX 2 = send 5
    await driver.set(1, 2, 'mute', true);
    await driver.set(1, 2, 'pan', -1);
    await driver.set(0, null, 'level', null);
    assert.equal(ms.data.get('ch.2.mix.sends.5.lvl'), -6);
    assert.equal(ms.data.get('ch.2.mix.sends.5.on'), false);
    assert.equal(ms.data.get('ch.2.mix.sends.5.pan'), -37);
    assert.equal(ms.data.get('ch.156.mix.lvl'), -90);
    assert.equal(ms.data.get('ch.0.preamp.trim'), 0, 'nothing else was touched');
    assert.equal(ms.data.get('ch.0.mix.sends.0.lvl'), -12, 'BandSUB untouched');
  } finally {
    await close();
  }
});

test('a write refused by Mixing Station is reported as a failure', async () => {
  const { ms, driver, close } = await setup();
  try {
    await driver.set(0, 0, 'level', -3); // signed in: succeeds with no reply
    assert.equal(ms.data.get('ch.0.mix.sends.4.lvl'), -3);
  } finally {
    await close();
  }
  const denied = await setup({ auth: { user: 'admin', password: 'wrong' } });
  try {
    denied.driver.canWrite = true; // force the write out to see Mixing Station refuse it
    await assert.rejects(denied.driver.set(0, 0, 'level', 0), /Access Denied/);
    assert.equal(denied.ms.data.get('ch.0.mix.sends.4.lvl'), -12);
  } finally {
    await denied.close();
  }
});

test('without a Mixing Station login, writes are refused before they are sent', async () => {
  const { ms, driver, close } = await setup({ auth: null });
  try {
    await assert.rejects(driver.set(0, 0, 'level', 0), /write access/);
    assert.equal(ms.data.get('ch.0.mix.sends.4.lvl'), -12);
  } finally {
    await close();
  }
});

test('desk changes, relabels and mono/stereo meters come through', async () => {
  const { ms, driver, close } = await setup();
  try {
    const meters = await driver.firstMeters;
    assert.deepEqual(meters.ch, [-30, -31, -32, -33, -20, -20], 'inputs then FX returns');
    assert.equal(meters.bus[0], -20, 'stereo bus meter is the louder side');
    const change = new Promise((r) => driver.once('change', r));
    ms.push('ch.3.mix.sends.6.lvl', -3);
    assert.deepEqual(await change, { bus: 2, ch: 3, field: 'level', value: -3 }, 'send 6 = DRUMS');
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.3.cfg.color', 5);
    assert.equal((await layout).channels[0].color, 'purple');
  } finally {
    await close();
  }
});

test('FX returns follow the inputs with their own numbers and Mixing Station paths', async () => {
  const { ms, driver, close } = await setup();
  try {
    const s = driver.snapshot();
    assert.equal(s.model, 'dlive');
    assert.deepEqual(s.channels[0], { ch: 0, kind: 'input', number: 1, name: 'Kick', color: 'yellow' });
    assert.deepEqual(s.channels[4], { ch: 4, kind: 'fx_return', number: 1, name: 'Vox Verb', color: 'purple' });
    assert.deepEqual(s.channels[5], { ch: 5, kind: 'fx_return', number: 2, name: 'FX 2', color: null });
    assert.equal(s.values.get(paramKey(0, 4, 'level')), -10, 'ch.200 send into MC');
    await driver.set(0, 4, 'level', -6);
    assert.equal(ms.data.get('ch.200.mix.sends.4.lvl'), -6, 'phone ch 4 writes Mixing Station ch 200');
    assert.equal(ms.data.get('ch.4.mix.sends.4.lvl'), undefined, 'never the input with the same position');
    const change = new Promise((r) => driver.once('change', r));
    ms.push('ch.201.mix.sends.5.lvl', -2);
    assert.deepEqual(await change, { bus: 1, ch: 5, field: 'level', value: -2 });
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.201.cfg.name', 'Plate');
    assert.deepEqual((await layout).channels[0], { ch: 5, kind: 'fx_return', number: 2, name: 'Plate', color: null });
    await assert.rejects(driver.set(0, 9, 'level', 0), /no channel/);
  } finally {
    await close();
  }
});

test('console model comes from Mixing Station, so one install fits dLive and Wing rigs', async () => {
  const wing = await setup({}, { info: { consoleName: 'Behringer Wing', version: '3.1' } });
  try {
    assert.equal(wing.driver.snapshot().model, 'wing');
    assert.equal(wing.driver.snapshot().console, 'Behringer Wing');
  } finally {
    await wing.close();
  }
  const dlive = await setup({}, { info: { mixer: { name: 'dLive DM64' } } });
  try {
    assert.equal(dlive.driver.snapshot().model, 'dlive');
  } finally {
    await dlive.close();
  }
  const forced = await setup({ consoleModel: 'wing' }, { info: { consoleName: 'dLive' } });
  try {
    assert.equal(forced.driver.snapshot().model, 'wing', 'config wins over detection');
  } finally {
    await forced.close();
  }
});

test('FX returns can be turned off', async () => {
  const { driver, close } = await setup({ fxReturns: { enabled: false } });
  try {
    assert.equal(driver.snapshot().channels.length, 4);
  } finally {
    await close();
  }
});

test('mixer going offline in Mixing Station reports the console as disconnected', async () => {
  const { ms, driver, close } = await setup();
  try {
    const status = new Promise((r) => driver.once('status', r));
    ms.mixerOffline();
    assert.equal((await status).connected, false);
    await assert.rejects(driver.set(0, 0, 'level', 0), /offline/);
  } finally {
    await close();
  }
});
