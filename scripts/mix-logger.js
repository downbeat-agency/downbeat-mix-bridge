#!/usr/bin/env node
// Read-only show logger: who/what is pulling IEM faders down?
//
// Runs on the rig Mac Mini next to Mixing Station (connected to the dLive, API on port 8091).
// It never logs in, so it cannot change anything. It records every change to the IEM mixes:
// time, mix, channel, old -> new, and flags:
//   DOWN   a send fader dropped to -inf
//   MUTED  a send was switched off
//   BURST  many changes across several mixes within a fraction of a second (looks like a scene recall)
//
//   node scripts/mix-logger.js                 # ws://127.0.0.1:8091/
//   node scripts/mix-logger.js --port 8091 --out ~/Desktop/mix-log
//
// Writes <out>/mix-log-<date>.jsonl (every change) and prints flagged events live.
// Ctrl+C prints a summary: which faders dropped, how often, and whether drops came in bursts.
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, l) => (v.startsWith('--') ? [...a, [v.slice(2), l[i + 1]]] : a), []));
const url = args.url ?? `ws://127.0.0.1:${args.port ?? 8091}/`;
const outDir = (args.out ?? join(homedir(), 'Desktop', 'mix-log')).replace(/^~/, homedir());
const BURST_WINDOW_MS = Number(args.burstMs ?? 300);
const BURST_MIN_CHANGES = Number(args.burstChanges ?? 8);
const BURST_MIN_MIXES = Number(args.burstMixes ?? 3);

await mkdir(outDir, { recursive: true });
const file = join(outDir, `mix-log-${new Date().toISOString().slice(0, 10)}.jsonl`);
const write = (o) => appendFile(file, JSON.stringify(o) + '\n').catch(() => {});
const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const channelNames = new Map(); // ch index -> name
const mixes = new Map(); // send id -> { name, channel }
const mixByChannel = new Map(); // bus channel -> send id
const values = new Map();
const drops = new Map(); // "mix|channel" -> count
let recent = []; // changes in the current burst window
let bursts = 0;
let ready = false;
let lastData = 0;

function connect() {
  const ws = new WebSocket(url);
  const call = (path, method = 'GET', body = null) =>
    new Promise((resolve) => {
      const h = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.path === path && m.method === method) {
          ws.removeEventListener('message', h);
          resolve(m.body);
        }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ path, method, body }));
      setTimeout(() => resolve(null), 4000);
    });

  let keepAlive;
  ws.addEventListener('open', async () => {
    ready = false;
    // Seen live: Mixing Station closed a quiet websocket after ~40 s. Ask for app state every 5 s.
    keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ path: '/app/state', method: 'GET', body: null })), 5000);
    const state = await call('/app/state');
    if (state?.topState !== 'connected') console.log(`${stamp()} Mixing Station is not connected to the console yet (${state?.topState ?? 'no answer'}); waiting`);
    const tg = await call('/console/mixTargets');
    for (const t of tg?.targets ?? []) {
      if (t.isChannel && t.channelType?.type === 4) {
        mixes.set(t.id, { name: t.name, channel: t.channelIndex });
        mixByChannel.set(t.channelIndex, t.id);
      }
    }
    for (const p of ['ch.*.cfg.name', 'ch.*.mix.sends.*.lvl', 'ch.*.mix.sends.*.on', 'ch.*.mix.lvl', 'ch.*.mix.on']) {
      ws.send(JSON.stringify({ path: '/console/data/subscribe', method: 'POST', body: { path: p, format: 'val' } }));
    }
    lastData = Date.now();
    const wait = setInterval(() => {
      if (Date.now() - lastData > 1000) {
        clearInterval(wait);
        ready = true;
        console.log(`${stamp()} logging ${mixes.size} mixes -> ${file}`);
        write({ at: new Date().toISOString(), event: 'start', mixes: [...mixes.values()].map((m) => m.name) });
      }
    }, 200);
  });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.path === '/app/state' && m.body?.topState) {
      write({ at: new Date().toISOString(), event: 'app-state', state: m.body.topState });
      if (ready) console.log(`${stamp()} Mixing Station: ${m.body.topState}`);
      return;
    }
    if (typeof m.path !== 'string' || !m.path.startsWith('/console/data/get/') || !m.body) return;
    lastData = Date.now();
    onValue(m.path.slice(18), m.body.value);
  });

  ws.addEventListener('close', () => {
    clearInterval(keepAlive);
    console.log(`${stamp()} lost Mixing Station; retrying in 3 s`);
    write({ at: new Date().toISOString(), event: 'disconnected' });
    setTimeout(connect, 3000);
  });
  ws.addEventListener('error', () => {});
}

function onValue(path, value) {
  const p = path.split('.');
  const ch = Number(p[1]);
  if (p[2] === 'cfg' && p[3] === 'name') return void channelNames.set(ch, value || `Ch ${ch + 1}`);
  let mixId, channel, field;
  if (p[2] === 'mix' && p[3] === 'sends' && p.length === 6) {
    mixId = Number(p[4]);
    channel = ch;
    field = p[5];
  } else if (p[2] === 'mix' && p.length === 4 && mixByChannel.has(ch)) {
    mixId = mixByChannel.get(ch);
    channel = null;
    field = p[3];
  } else return;
  const mix = mixes.get(mixId);
  if (!mix) return;
  const old = values.get(path);
  values.set(path, value);
  if (!ready || old === value) return;

  const now = Date.now();
  const what = channel === null ? 'MASTER' : `ch ${channel + 1} ${channelNames.get(channel) ?? ''}`.trim();
  const flags = [];
  if (field === 'lvl' && Number(value) <= -89 && Number(old) > -89) flags.push('DOWN');
  if (field === 'on' && value === false && old === true) flags.push('MUTED');
  const entry = { at: new Date(now).toISOString(), mix: mix.name, channel: channel === null ? null : channel + 1, channelName: what, field, from: old, to: value, flags };
  write(entry);

  recent = recent.filter((r) => now - r.t <= BURST_WINDOW_MS);
  recent.push({ t: now, mix: mix.name });
  const mixesInBurst = new Set(recent.map((r) => r.mix));
  if (recent.length === BURST_MIN_CHANGES && mixesInBurst.size >= BURST_MIN_MIXES) {
    bursts++;
    console.log(`${stamp()} BURST  ${recent.length}+ changes across ${mixesInBurst.size} mixes at once (looks like a scene recall)`);
    write({ at: entry.at, event: 'burst', mixes: [...mixesInBurst] });
  }
  if (flags.length) {
    const key = `${mix.name} | ${what}`;
    drops.set(key, (drops.get(key) ?? 0) + 1);
    const inBurst = recent.length >= BURST_MIN_CHANGES && mixesInBurst.size >= BURST_MIN_MIXES ? ' (during a burst)' : '';
    console.log(`${stamp()} ${flags.join('+').padEnd(6)} ${mix.name}: ${what}  ${fmt(old)} -> ${fmt(value)}${inBurst}`);
  }
}

const fmt = (v) => (typeof v === 'number' ? (v <= -89 ? '-inf' : `${v.toFixed(1)} dB`) : v === true ? 'on' : v === false ? 'off' : String(v));

process.on('SIGINT', () => {
  console.log(`\nSummary (${file})`);
  console.log(`  scene-recall-like bursts: ${bursts}`);
  if (!drops.size) console.log('  no faders dropped or muted');
  for (const [k, n] of [...drops].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`);
  process.exit(0);
});

connect();
