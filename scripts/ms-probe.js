#!/usr/bin/env node
// Bench probe: run on the Mac Mini with Mixing Station desktop open, connected to the dLive,
// and Global Settings -> API -> HTTP REST enabled.
//
//   node scripts/ms-probe.js                 # default port 8091
//   node scripts/ms-probe.js --port 8091
//
// It saves everything it learns to ms-probe-report.json and ms-api-docs.html in this folder.
// Send those two files back; they tell us the real dLive paths for sends, pan, mute,
// bus masters, names, colors and meters, so config.json can be filled in for real.
import { writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, l) => (v.startsWith('--') ? [...a, [v.slice(2), l[i + 1]]] : a), []));
const host = args.host ?? '127.0.0.1';
const port = Number(args.port ?? 8091);
const report = { at: new Date().toISOString(), host, port, httpDocs: null, ws: null, appState: null, paths: {}, meters: null, errors: [] };

// 1. The in-app API documentation lists every endpoint and data path.
try {
  const res = await fetch(`http://${host}:${port}/`);
  const html = await res.text();
  await writeFile('ms-api-docs.html', html);
  report.httpDocs = { status: res.status, bytes: html.length, file: 'ms-api-docs.html' };
  console.log(`saved API docs page (${html.length} bytes)`);
} catch (e) {
  report.errors.push(`docs page: ${e.message}`);
  console.log(`could not load http://${host}:${port}/ - is HTTP REST enabled in Mixing Station?`);
}

// 2. Find the websocket endpoint.
const candidates = ['/', '/ws', '/websocket', '/api/ws'];
let ws = null;
for (const path of candidates) {
  ws = await new Promise((resolve) => {
    const s = new WebSocket(`ws://${host}:${port}${path}`);
    const t = setTimeout(() => (s.close(), resolve(null)), 2000);
    s.addEventListener('open', () => (clearTimeout(t), resolve(s)));
    s.addEventListener('error', () => (clearTimeout(t), resolve(null)));
  });
  if (ws) {
    report.ws = `ws://${host}:${port}${path}`;
    console.log(`websocket: ${report.ws}`);
    break;
  }
}
if (!ws) {
  report.errors.push('no websocket endpoint found');
  await writeFile('ms-probe-report.json', JSON.stringify(report, null, 2));
  console.log('no websocket endpoint answered; report saved');
  process.exit(1);
}

const raw = [];
ws.addEventListener('message', (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (raw.length < 300) raw.push(m);
  if (m.path === '/app/state') report.appState = m.body;
  if (typeof m.path === 'string' && m.path.startsWith('/console/metering2/')) report.meters ??= m.body;
  const b = m.body;
  const record = (p, v) => {
    if (typeof p === 'string') report.paths[p] = v;
  };
  if (b && typeof b === 'object' && 'path' in b) record(b.path, b.value);
  if (Array.isArray(b)) b.forEach((u) => record(u?.path, u?.value));
});
const send = (o) => ws.send(JSON.stringify(o));

send({ path: '/app/state', method: 'GET', body: null });
// Broad subscriptions for channel 1 and mix 1 so we see every parameter name that exists.
for (const p of ['ch.0.*', 'ch.0.*.*', 'ch.0.*.*.*', 'ch.0.*.*.*.*', 'aux.0.*', 'aux.0.*.*', 'aux.0.*.*.*', 'mix.0.*', 'mix.0.*.*', 'bus.0.*.*']) {
  send({ path: '/console/data/subscribe', method: 'POST', body: { path: p, format: 'val' } });
}
send({ path: '/console/metering2/subscribe', method: 'POST', body: { id: 0, interval: 200, binary: false, params: [{ type: 0, index: 0 }, { type: 0, index: 1 }] } });

await new Promise((r) => setTimeout(r, 4000));
report.sampleMessages = raw.slice(0, 60);
await writeFile('ms-probe-report.json', JSON.stringify(report, null, 2));
const n = Object.keys(report.paths).length;
console.log(`mixer state: ${report.appState?.topState ?? 'unknown'}`);
console.log(`data paths seen: ${n}${n ? ' e.g. ' + Object.keys(report.paths).slice(0, 8).join(', ') : ''}`);
console.log(`meters: ${report.meters ? 'yes' : 'none seen'}`);
console.log('saved ms-probe-report.json');
ws.close();
process.exit(0);
