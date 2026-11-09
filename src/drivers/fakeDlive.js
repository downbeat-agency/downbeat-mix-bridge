// A pretend dLive for development, tests and load tests. Behaves like a console:
// writes land after a short delay, the "A1" can change things from the desk,
// meters move, and it can drop off the network and come back.
import { EventEmitter } from 'node:events';
import { paramKey } from '../model.js';
import { findPairs } from '../stereoPairs.js';

const DEFAULT_CHANNELS = [
  ['Kick', 'yellow'], ['Snare', 'yellow'], ['Hat', 'yellow'], ['Tom 1', 'yellow'], ['Tom 2', 'yellow'],
  ['OH L', 'yellow'], ['OH R', 'yellow'], ['Bass', 'red'], ['Gtr', 'red'], ['Keys L', 'red'], ['Keys R', 'red'],
  ['Sax', 'white'], ['Tpt', 'white'], ['Bone', 'white'], ['MC', 'blue'], ['Vox 2', 'blue'], ['Vox 3', 'blue'],
  ['Vox 4', 'blue'], ['Perc', 'yellow'], ['Click', null], ['Tracks L', null], ['Tracks R', null],
];
const DEFAULT_BUSES = ['MC', 'Vox 2', 'Vox 3', 'Vox 4', 'Sax', 'Trumpet', 'Bone', 'Guitar', 'Drums', 'Bass', 'Keys', 'Perc'];

export class FakeDliveDriver extends EventEmitter {
  constructor({ channelCount = 64, writeLatencyMs = 4, meterIntervalMs = 50, uncolored = false, name = 'Fake dLive' } = {}) {
    super();
    this.name = name;
    this.writeLatencyMs = writeLatencyMs;
    this.meterIntervalMs = meterIntervalMs;
    this.connected = false;
    this.writes = 0;
    this.channels = Array.from({ length: channelCount }, (_, ch) => {
      const preset = DEFAULT_CHANNELS[ch];
      return { ch, kind: 'input', number: ch + 1, name: preset ? preset[0] : `Ch ${ch + 1}`, color: uncolored || !preset ? null : preset[1], link: null };
    });
    for (const [ch, partner] of findPairs(this.channels)) this.channels[ch].link = partner;
    this.buses = DEFAULT_BUSES.map((n, bus) => ({ bus, name: `Stereo Mix ${bus + 1} ${n}`, stereo: true }));
    this.values = new Map();
    for (const b of this.buses) {
      this.values.set(paramKey(b.bus, null, 'level'), 0);
      this.values.set(paramKey(b.bus, null, 'mute'), false);
      for (const c of this.channels) {
        this.values.set(paramKey(b.bus, c.ch, 'level'), c.ch < DEFAULT_CHANNELS.length ? -10 : null);
        this.values.set(paramKey(b.bus, c.ch, 'mute'), false);
        this.values.set(paramKey(b.bus, c.ch, 'pan'), 0);
      }
    }
    this.meterPhase = 0;
  }

  get capabilities() {
    return { sendLevel: true, sendMute: true, sendPan: true, busMaster: true, meters: true, names: true, colors: true };
  }

  async connect() {
    this.connected = true;
    this.emit('status', { connected: true, console: this.name });
    this.meterTimer = setInterval(() => this.#emitMeters(), this.meterIntervalMs);
    this.meterTimer.unref?.();
  }

  async close() {
    clearInterval(this.meterTimer);
    this.connected = false;
  }

  snapshot() {
    return {
      console: this.name,
      model: 'dlive',
      capabilities: this.capabilities,
      channels: this.channels.map((c) => ({ ...c })),
      buses: this.buses.map((b) => ({ ...b })),
      values: new Map(this.values),
    };
  }

  async set(bus, ch, field, value) {
    if (!this.connected) throw new Error('console offline');
    this.writes++;
    await new Promise((r) => setTimeout(r, this.writeLatencyMs));
    if (!this.connected) throw new Error('console offline');
    const key = paramKey(bus, ch, field);
    if (!this.values.has(key)) throw new Error(`no such parameter ${key}`);
    this.values.set(key, value);
    this.emit('change', { bus, ch, field, value });
  }

  // --- test / demo hooks -------------------------------------------------
  /** Simulate the A1 changing something on the desk. */
  deskChange(bus, ch, field, value) {
    this.values.set(paramKey(bus, ch, field), value);
    this.emit('change', { bus, ch, field, value });
  }

  /** Simulate the A1 naming or coloring channels mid-show. */
  deskRelabel(ch, { name, color }) {
    const c = this.channels[ch];
    if (name !== undefined) c.name = name;
    if (color !== undefined) c.color = color;
    this.emit('layout', { channels: [{ ...c }] });
  }

  dropConnection() {
    this.connected = false;
    clearInterval(this.meterTimer);
    this.emit('status', { connected: false, console: this.name });
  }

  #emitMeters() {
    this.meterPhase += 0.35;
    const ch = this.channels.map((c, i) => {
      if (i >= DEFAULT_CHANNELS.length) return null;
      const v = -18 + 9 * Math.sin(this.meterPhase + i * 0.7) + (Math.random() * 4 - 2);
      return Math.round(v * 10) / 10;
    });
    const bus = this.buses.map((b, i) => Math.round((-14 + 5 * Math.sin(this.meterPhase + i)) * 10) / 10);
    this.emit('meters', { ch, bus });
  }
}
