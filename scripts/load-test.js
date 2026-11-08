#!/usr/bin/env node
// Simulates a full band moving faders at once.
//
//   node scripts/load-test.js                       # spins up a bridge + fake dLive in-process
//   node scripts/load-test.js --url ws://10.0.30.5:8790/v1/mix --token xyz --seconds 60
//
// Every musician drags a random fader ~30 times a second in bursts (how a thumb on a
// phone actually behaves). Pairs of musicians share a mix so we can time how long a
// move takes to show up on the other phone.
import { createServer } from 'node:http';
import { attachWebSocket } from '../src/wsServer.js';
import { Bridge } from '../src/bridge.js';
import { FakeDliveDriver } from '../src/drivers/fakeDlive.js';
import { connectClient, sleep } from '../test/helpers.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, l) => (v.startsWith('--') ? [...a, [v.slice(2), l[i + 1]]] : a), []));
const PHONES = Number(args.phones ?? 20);
const SECONDS = Number(args.seconds ?? 15);
const RATE_HZ = Number(args.rate ?? 30);

let url = args.url;
let local = null;
if (!url) {
  const driver = new FakeDliveDriver({ writeLatencyMs: 3 });
  const bridge = new Bridge(driver, { maxWritesPerSecond: 400 });
  const server = createServer();
  attachWebSocket(server, '/v1/mix', (c) => bridge.addConnection(c));
  bridge.start();
  await driver.connect();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${server.address().port}/v1/mix`;
  local = { driver, bridge, server };
  console.log(`no --url given: testing an in-process bridge with a fake dLive`);
}

console.log(`${PHONES} phones, ${SECONDS}s, ~${RATE_HZ} fader moves/s each -> ${url}`);
const phones = [];
for (let i = 0; i < PHONES; i++) {
  const bus = Math.floor(i / 2) % 12; // two phones per mix
  const c = await connectClient(url);
  c.stats = { sent: 0, received: 0, bytes: 0, errors: 0 };
  c.bus = bus;
  c.ws.addEventListener('message', (ev) => {
    c.stats.received++;
    c.stats.bytes += ev.data.length;
  });
  c.send({ type: 'hello', personId: `load-${i}`, name: `Musician ${i + 1}`, bus, meters: true, token: args.token });
  await c.next('welcome');
  c.snapshot = await c.next('snapshot');
  phones.push(c);
}

// Latency probe: phone A sets a unique value on ch 63, phone B (same mix) times its arrival.
const latencies = [];
const probe = async (a, b) => {
  const value = -40 - Math.round(Math.random() * 400) / 10;
  const t0 = performance.now();
  a.send({ type: 'set', bus: a.bus, ch: 63, field: 'level', value });
  for (;;) {
    const m = await b.next('changed', 3000).catch(() => null);
    if (!m) return;
    if (m.ch === 63 && m.value === value) return latencies.push(performance.now() - t0);
  }
};

const end = Date.now() + SECONDS * 1000;
const drivers = phones.map(async (c) => {
  while (Date.now() < end) {
    const ch = Math.floor(Math.random() * 22);
    let v = -20 + Math.random() * 20;
    const burst = 10 + Math.floor(Math.random() * 20);
    for (let k = 0; k < burst && Date.now() < end; k++) {
      v += Math.random() * 2 - 1;
      c.send({ type: 'set', bus: c.bus, ch, field: 'level', value: v });
      c.stats.sent++;
      await sleep(1000 / RATE_HZ);
    }
    await sleep(100 + Math.random() * 400); // thumb lifts, looks at the stage
  }
});
const probes = (async () => {
  while (Date.now() < end) {
    await probe(phones[0], phones[1]);
    await sleep(200);
  }
})();
await Promise.all([...drivers, probes]);
await sleep(300);

for (const c of phones) c.stats.errors = c.drain('error').length;
const sent = phones.reduce((s, c) => s + c.stats.sent, 0);
const errs = phones.reduce((s, c) => s + c.stats.errors, 0);
const kbps = phones.reduce((s, c) => s + c.stats.bytes, 0) / 1024 / SECONDS / PHONES;
latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1) : 'n/a');

console.log(`\nfader moves sent by phones: ${sent} (${Math.round(sent / SECONDS)}/s)`);
if (local) {
  const st = local.bridge.stats;
  console.log(`writes sent to console:     ${st.writesSent} (${Math.round(st.writesSent / SECONDS)}/s), merged ${st.writesMerged}, failed ${st.writesFailed}`);
}
console.log(`errors returned to phones:  ${errs}`);
console.log(`traffic per phone:          ${kbps.toFixed(1)} KB/s (meters + other phones' moves)`);
console.log(`move -> other phone:        p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(0.999)} ms (${latencies.length} probes)`);

for (const c of phones) c.close();
if (local) {
  local.bridge.stop();
  await local.driver.close();
  local.server.close();
}
process.exit(errs > 0 ? 1 : 0);
