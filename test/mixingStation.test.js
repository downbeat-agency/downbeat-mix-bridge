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

function fakeMixingStation({ users = { admin: '' }, info = {}, targets = TARGETS, extraData = [] } = {}) {
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
    ...extraData,
  ]);
  for (let ch = 0; ch < 4; ch++) {
    for (const t of targets) {
      data.set(`ch.${ch}.mix.sends.${t.id}.lvl`, ch === 0 ? -12 : -90);
      data.set(`ch.${ch}.mix.sends.${t.id}.on`, ch !== 1);
      if (t.channelType.stereo) data.set(`ch.${ch}.mix.sends.${t.id}.pan`, ch === 0 ? 18.5 : 0);
    }
  }
  const conns = new Set();
  let silent = false;
  const server = createServer();
  attachWebSocket(server, '/', (conn) => {
    conns.add(conn);
    conn.authed = false;
    conn.on('close', () => conns.delete(conn));
    const reply = (msg, body, error) => conn.send(JSON.stringify({ path: msg.path, method: msg.method, ...(error ? { error } : { body }) }));
    const push = (c, p) => c.send(JSON.stringify({ path: `/console/data/get/${p}`, method: 'GET', body: { fade: 0, format: 'val', value: data.get(p) } }));
    conn.on('message', (text) => {
      if (silent) return;
      const msg = JSON.parse(text);
      if (msg.path === '/app/state') return reply(msg, { topState: 'connected', state: 'connected' });
      if (msg.path === '/auth/login') {
        if (msg.body.user in users && users[msg.body.user] === msg.body.password) {
          conn.authed = true;
          return reply(msg, { roles: ['apiWrite'], publicMixes: [], token: 't' });
        }
        return reply(msg, null, 'Invalid credentials');
      }
      if (msg.path === '/console/information') return reply(msg, { channelTypes: CHANNEL_TYPES, ...info });
      if (msg.path === '/console/mixTargets') return reply(msg, { targets });
      if (msg.path.startsWith('/console/data/definitions/')) {
        const def = /headamp\.gain$/.test(msg.path) ? { min: -2.5, max: 45 } : /preamp\.trim$/.test(msg.path) ? { min: -18, max: 18 } : { min: -37, max: 37 };
        return reply(msg, { definitions: { x: { definition: def } } });
      }
      if (msg.path === '/console/data/subscribe') {
        const re = new RegExp('^' + msg.body.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') + '$');
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
    /** Stop answering anything (an API that hangs) or start again. */
    silence(on) {
      silent = on;
    },
    connections: () => conns.size,
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
    assert.deepEqual(s.channels[0], { ch: 0, kind: 'input', number: 1, name: 'Kick', color: 'yellow', link: null, preamp: { source: 'trim', min: -18, max: 18, step: 0.5, phantom: false } });
    assert.deepEqual(s.channels[4], { ch: 4, kind: 'fx_return', number: 1, name: 'Vox Verb', color: 'purple', link: null, preamp: null });
    assert.deepEqual(s.channels[5], { ch: 5, kind: 'fx_return', number: 2, name: 'FX 2', color: null, link: null, preamp: null });
    assert.equal(s.values.get(paramKey(0, 4, 'level')), -10, 'ch.200 send into MC');
    await driver.set(0, 4, 'level', -6);
    assert.equal(ms.data.get('ch.200.mix.sends.4.lvl'), -6, 'phone ch 4 writes Mixing Station ch 200');
    assert.equal(ms.data.get('ch.4.mix.sends.4.lvl'), undefined, 'never the input with the same position');
    const change = new Promise((r) => driver.once('change', r));
    ms.push('ch.201.mix.sends.5.lvl', -2);
    assert.deepEqual(await change, { bus: 1, ch: 5, field: 'level', value: -2 });
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.201.cfg.name', 'Plate');
    assert.deepEqual((await layout).channels[0], { ch: 5, kind: 'fx_return', number: 2, name: 'Plate', color: null, link: null, preamp: null });
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
  const layoutOnly = await setup({}, { info: { channelTypes: [{ type: 0, name: 'Channel', count: 40, offset: 0 }, { type: 1, name: 'Aux', count: 8, offset: 40 }] } });
  try {
    assert.equal(layoutOnly.driver.snapshot().model, 'wing', 'no model text: 40 inputs + aux is a Wing');
  } finally {
    await layoutOnly.close();
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

test('linked L/R inputs reach phones and follow renames', async () => {
  const { driver, ms, close } = await setup();
  try {
    assert.equal(driver.snapshot().channels[2].link, null);
    const layouts = [];
    driver.on('layout', (l) => layouts.push(l));
    ms.push('ch.2.cfg.name', 'Keys L');
    ms.push('ch.3.cfg.name', 'Keys R');
    await new Promise((r) => setTimeout(r, 80));
    const s = driver.snapshot();
    assert.equal(s.channels[2].link, 3);
    assert.equal(s.channels[3].link, 2);
    assert.equal(s.channels[4].link, null, 'FX returns stay single');
    const last = layouts.at(-1).channels;
    assert.deepEqual(last.map((c) => [c.ch, c.link]).sort(), [[2, 3], [3, 2]], 'both halves are sent');
    assert.ok(last.every((c) => !('ms' in c)));

    ms.push('ch.3.cfg.name', 'Organ');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(driver.snapshot().channels[2].link, null, 'a rename breaks the pair');
  } finally {
    await close();
  }
});

test('a rig can list its linked pairs by input number', async () => {
  const { driver, close } = await setup({ stereoPairs: { pairs: [[1, 2]] } });
  try {
    const s = driver.snapshot();
    assert.equal(s.channels[0].link, 1);
    assert.equal(s.channels[1].link, 0);
  } finally {
    await close();
  }
});

test('dLive UFX returns follow the FX returns as their own kind; UFX sends are not returns', async () => {
  const info = { channelTypes: [
    ...CHANNEL_TYPES,
    { type: 102, name: 'UFX Ret', shortName: 'UFX R', count: 2, offset: 144 },
    { type: 101, name: 'UFX Snd', shortName: 'UFX', count: 2, offset: 183 },
    { type: 2, name: 'FX Send', shortName: 'FxSnd', count: 2, offset: 181 },
  ] };
  const { driver, ms, close } = await setup({}, { info });
  try {
    const s = driver.snapshot();
    assert.deepEqual(s.channels.slice(4).map((c) => [c.ch, c.kind, c.number, c.name]), [
      [4, 'fx_return', 1, 'Vox Verb'], [5, 'fx_return', 2, 'FX 2'],
      [6, 'ufx_return', 1, 'UFX 1'], [7, 'ufx_return', 2, 'UFX 2'],
    ]);
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.144.cfg.name', 'V1 VrbRT');
    assert.deepEqual((await layout).channels[0], { ch: 6, kind: 'ufx_return', number: 1, name: 'V1 VrbRT', color: null, link: null, preamp: null });
    ms.push('ch.144.cfg.name', '');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(driver.snapshot().channels[6].name, 'UFX 1');
  } finally {
    await close();
  }
});

test('Wing aux inputs follow the inputs as their own kind', async () => {
  const info = { channelTypes: [
    { type: 0, name: 'Input', shortName: 'Ch', count: 4, offset: 0 },
    { type: 1, name: 'Aux', shortName: 'Aux', count: 2, offset: 40 },
    { type: 4, name: 'Bus', shortName: 'Mix', count: 8, offset: 48 },
  ] };
  const { driver, ms, close } = await setup({}, { info });
  try {
    const s = driver.snapshot();
    assert.deepEqual(s.channels.slice(4).map((c) => [c.ch, c.kind, c.number, c.name]), [
      [4, 'aux', 1, 'Aux 1'], [5, 'aux', 2, 'Aux 2'],
    ]);
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.40.cfg.name', 'VOX VERB');
    assert.deepEqual((await layout).channels[0], { ch: 4, kind: 'aux', number: 1, name: 'VOX VERB', color: null, link: null, preamp: null });
  } finally {
    await close();
  }
});

test('Wing buses feed other buses: phones get them as kind "bus" and a mix never feeds itself', async () => {
  // Wing: one "Bus" type that Mixing Station says can feed buses (signalTargets type 4).
  const busType = { type: 4, name: 'Bus', shortName: 'Mix', count: 3, offset: 48, signalTargets: [{ count: 16, channelType: { type: 4, stereo: true } }] };
  const info = { channelTypes: [{ type: 0, name: 'Input', shortName: 'Ch', count: 4, offset: 0 }, busType] };
  const targets = ['MC', 'DRUMS', 'HALL V'].map((name, i) => ({ isChannel: true, name, id: i, channelIndex: 48 + i, channelType: { type: 4, stereo: true } }));
  const extraData = [['ch.48.cfg.name', 'MC'], ['ch.49.cfg.name', 'DRUMS'], ['ch.50.cfg.name', 'HALL V'], ['ch.50.mix.sends.1.lvl', -5], ['ch.50.mix.sends.1.on', true]];
  const { driver, ms, close } = await setup({ busFilter: { stereoOnly: true, hideUnnamed: true } }, { info, targets, extraData });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const s = driver.snapshot();
    assert.deepEqual(s.channels.slice(4).map((c) => [c.ch, c.kind, c.number, c.name]), [
      [4, 'bus', 1, 'MC'], [5, 'bus', 2, 'DRUMS'], [6, 'bus', 3, 'HALL V'],
    ]);
    assert.deepEqual(s.buses.map((b) => [b.name, b.self]), [['MC', 4], ['DRUMS', 5], ['HALL V', 6]], 'each mix names its own bus channel');
    assert.equal(s.values.get(paramKey(1, 6, 'level')), -5, 'the hall reverb bus feeds DRUMS at -5');

    await driver.set(1, 6, 'level', -90);
    assert.equal(ms.data.get('ch.50.mix.sends.1.lvl'), -90, 'pulled the hall reverb out of DRUMS');
    await assert.rejects(driver.set(1, 5, 'level', 0), /itself/);

    // Renaming the bus renames both the mix and the source channel.
    const layouts = [];
    driver.on('layout', (l) => layouts.push(l));
    ms.push('ch.50.cfg.name', 'HALL VERB');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(layouts.some((l) => l.channels?.[0]?.name === 'HALL VERB'));
    assert.ok(layouts.some((l) => l.buses?.[0]?.name === 'HALL VERB'));
  } finally {
    await close();
  }
});

test('dLive Mix types are never sources', async () => {
  const { driver, close } = await setup();
  try {
    assert.ok(!driver.snapshot().channels.some((c) => c.kind === 'bus'));
  } finally {
    await close();
  }
});

test('UFX returns can be turned off', async () => {
  const info = { channelTypes: [...CHANNEL_TYPES, { type: 102, name: 'UFX Ret', shortName: 'UFX R', count: 2, offset: 144 }] };
  const { driver, close } = await setup({ ufxReturns: { enabled: false } }, { info });
  try {
    assert.deepEqual(driver.snapshot().channels.map((c) => c.kind).filter((k) => k !== 'input'), ['fx_return', 'fx_return']);
  } finally {
    await close();
  }
});

test('a blank right half from the console pairs with the named input before it', async () => {
  const { driver, ms, close } = await setup();
  try {
    ms.push('ch.2.cfg.name', 'BGM');
    ms.push('ch.3.cfg.name', '');
    await new Promise((r) => setTimeout(r, 80));
    const s = driver.snapshot();
    assert.equal(s.channels[2].link, 3);
    assert.equal(s.channels[3].name, 'Ch 4');
    assert.ok(!('blankName' in s.channels[3]), 'internal flag stays on the rig');
  } finally {
    await close();
  }
});


test('a connection attempt that hangs is dropped and retried (Mixing Station still starting)', async () => {
  const { createServer: createTcp } = await import('node:net');
  let accepted = 0;
  const sockets = new Set();
  const hung = createTcp((sock) => { accepted++; sockets.add(sock); }); // accepts, never answers
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const driver = new MixingStationDriver({ wsUrl: `ws://127.0.0.1:${hung.address().port}/`, openTimeoutMs: 120, reconnectMs: [30] });
  await driver.connect();
  try {
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(accepted >= 2, `retried after a hung attempt (attempts: ${accepted})`);
  } finally {
    await driver.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => hung.close(r));
  }
});

test('a socket that goes silent is reopened and the console comes back by itself', async () => {
  const { driver, ms, close } = await setup({ keepAliveMs: 50, silenceMs: 250, requestTimeoutMs: 150, reconnectMs: [30] });
  try {
    const down = new Promise((r) => driver.on('status', (s) => !s.connected && r()));
    ms.silence(true);
    await down;
    const up = new Promise((r) => driver.on('status', (s) => s.connected && r()));
    ms.silence(false);
    await up;
    assert.equal(driver.snapshot().buses.length > 0, true);
  } finally {
    await close();
  }
});

test('Wing preamps: headamp gain and 48V where the source has a headamp, else trim', async () => {
  // ch 0: local input (headamp + 48V). ch 1: card input (trim only, like the Pink vocals).
  const extraData = [['ch.0.headamp.gain', 7.5], ['ch.0.headamp.+48v', true], ['ch.1.preamp.trim', -2]];
  const { driver, ms, close } = await setup({}, { extraData });
  try {
    const s = driver.snapshot();
    assert.deepEqual(s.channels[0].preamp, { source: 'headamp', min: -2.5, max: 45, step: 0.5, phantom: true });
    assert.deepEqual(s.channels[1].preamp, { source: 'trim', min: -18, max: 18, step: 0.5, phantom: false });
    assert.equal(s.channels[4].preamp, null, 'FX returns get no gain');
    assert.equal(s.values.get(paramKey(null, 0, 'gain')), 7.5);
    assert.equal(s.values.get(paramKey(null, 0, 'phantom')), true);
    assert.equal(s.values.get(paramKey(null, 1, 'gain')), -2);
    assert.deepEqual([s.capabilities.gain, s.capabilities.phantom], [true, true]);

    await driver.set(0, 0, 'gain', 50);
    assert.equal(ms.data.get('ch.0.headamp.gain'), 45, 'headamp write, clamped');
    await driver.set(3, 1, 'gain', 3.5);
    assert.equal(ms.data.get('ch.1.preamp.trim'), 3.5, 'card channel writes its trim');
    await driver.set(0, 0, 'phantom', false);
    assert.equal(ms.data.get('ch.0.headamp.+48v'), false);
    await assert.rejects(driver.set(0, 1, 'phantom', true), /no phantom/);
    await assert.rejects(driver.set(0, 4, 'gain', 0), /no gain/);

    const changes = [];
    driver.on('change', (c) => changes.push(c));
    ms.push('ch.0.headamp.gain', 12);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes.at(-1), { bus: null, ch: 0, field: 'gain', value: 12 });

    // Source patched away from the headamp: the channel falls back to its trim.
    const layout = new Promise((r) => driver.once('layout', r));
    ms.push('ch.0.headamp.gain', null);
    assert.equal((await layout).channels[0].preamp.source, 'trim');
  } finally {
    await close();
  }
});
