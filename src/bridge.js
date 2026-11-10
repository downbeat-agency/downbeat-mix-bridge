// The bridge: one console connection in, many phones out.
//
// Rules this file enforces (see mix-bridge/PROTOCOL.md):
// - Phones touch monitor buses: per-input sends (level, mute, pan) and the bus master.
//   The one exception is a channel's gain and phantom power, which the app keeps locked until
//   someone unlocks that one channel. Nothing else on the console is reachable.
// - Any phone may switch to any allowed bus (takeover is allowed by product decision).
// - Read before write: a phone must have received a snapshot of its bus, taken while the
//   console was connected, before its writes are accepted.
// - Fast fader moves are merged per parameter (latest wins) and paced so the console
//   never sees more than `maxWritesPerSecond`.
// - When the console drops, queued writes are discarded, never replayed later.
import { randomUUID } from 'node:crypto';
import { CHANNEL_FIELDS, normalizeValue, paramKey } from './model.js';

export const PROTOCOL_VERSION = 1;

const CAPABILITY_FOR = {
  send: { level: 'sendLevel', mute: 'sendMute', pan: 'sendPan' },
  master: { level: 'busMaster', mute: 'busMaster' },
  channel: { gain: 'gain', phantom: 'phantom' },
};

export class Bridge {
  constructor(driver, options = {}) {
    this.driver = driver;
    this.opts = {
      rigName: options.rigName ?? 'Downbeat rig',
      version: options.version ?? null,
      sharedToken: options.sharedToken ?? null,
      allowedBuses: options.allowedBuses ?? null, // null = every bus the driver reports
      flushIntervalMs: options.flushIntervalMs ?? 20,
      maxWritesPerSecond: options.maxWritesPerSecond ?? 400,
      // A single fader never needs more than ~25 updates/s to sound smooth.
      perParamIntervalMs: options.perParamIntervalMs ?? 40,
      meterIntervalMs: options.meterIntervalMs ?? 100,
      heartbeatMs: options.heartbeatMs ?? 10_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 35_000,
      maxClientBufferBytes: options.maxClientBufferBytes ?? 256 * 1024,
      onAudit: options.onAudit ?? (() => {}),
      log: options.log ?? (() => {}),
    };
    this.sessions = new Map();
    this.connected = false;
    this.state = null; // { console, capabilities, channels, buses, values: Map }
    this.pending = new Map(); // key -> { bus, ch, field, value, sessionId }
    this.inFlight = new Set();
    this.lastWriteAt = new Map();
    this.lastMeters = null;
    this.stats = { writesSent: 0, writesMerged: 0, writesFailed: 0, writesRejected: 0 };

    driver.on('status', (s) => this.#onConsoleStatus(s));
    driver.on('change', (c) => this.#onConsoleChange(c));
    driver.on('layout', (l) => this.#onLayout(l));
    driver.on('meters', (m) => {
      this.lastMeters = m;
    });
  }

  start() {
    this.flushTimer = setInterval(() => this.#flush(), this.opts.flushIntervalMs);
    this.meterTimer = setInterval(() => this.#sendMeters(), this.opts.meterIntervalMs);
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.opts.heartbeatMs);
    if (this.driver.connected) this.#onConsoleStatus({ connected: true });
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.meterTimer);
    clearInterval(this.heartbeatTimer);
    for (const s of this.sessions.values()) s.conn.close(1001, 'bridge stopping');
  }

  health() {
    return {
      rig: this.opts.rigName,
      version: this.opts.version ?? null,
      console: { connected: this.connected, name: this.state?.console ?? null, model: this.state?.model ?? null },
      phones: [...this.sessions.values()].filter((s) => s.personId).map((s) => ({ personId: s.personId, name: s.name, bus: s.bus })),
      pendingWrites: this.pending.size,
      stats: { ...this.stats },
    };
  }

  // --- phone connections -------------------------------------------------

  /** True when no phone is connected and none has been for `ms` (safe to update). */
  isIdle(ms, now = Date.now()) {
    return this.sessions.size === 0 && now - (this.lastPhoneAt ?? 0) >= ms;
  }

  addConnection(conn) {
    const session = { id: randomUUID(), conn, personId: null, name: null, bus: null, ready: false, meters: false };
    this.sessions.set(session.id, session);
    this.lastPhoneAt = Date.now();
    conn.on('message', (text) => this.#onMessage(session, text));
    conn.on('close', () => {
      this.sessions.delete(session.id);
      this.lastPhoneAt = Date.now();
      if (session.bus !== null) this.#broadcastPresence(session.bus);
      this.opts.log(`phone left ${session.name ?? session.id}`);
    });
  }

  #onMessage(session, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.#error(session, 'bad_json', 'Message was not valid JSON');
    }
    if (!msg || typeof msg.type !== 'string') return this.#error(session, 'bad_message', 'Missing type');

    if (msg.type !== 'hello' && !session.personId) return this.#error(session, 'not_signed_in', 'Send hello first');

    switch (msg.type) {
      case 'hello':
        return this.#hello(session, msg);
      case 'select':
        return this.#select(session, msg.bus);
      case 'set':
        return this.#set(session, msg);
      case 'meters':
        session.meters = msg.on === true;
        return;
      default:
        return this.#error(session, 'bad_message', `Unknown type ${msg.type}`);
    }
  }

  #hello(session, msg) {
    if (this.opts.sharedToken && msg.token !== this.opts.sharedToken) {
      this.#send(session, { type: 'error', code: 'unauthorized', message: 'Wrong rig token' });
      return session.conn.close(4001, 'unauthorized');
    }
    if (typeof msg.personId !== 'string' || !msg.personId) return this.#error(session, 'bad_message', 'personId is required');
    session.personId = msg.personId;
    session.name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : null;
    session.meters = msg.meters === true;
    this.#send(session, {
      type: 'welcome',
      bridgeVersion: this.opts.version ?? null,
      protocol: PROTOCOL_VERSION,
      session: session.id,
      rig: this.opts.rigName,
      console: { connected: this.connected, name: this.state?.console ?? null, model: this.state?.model ?? null },
      buses: this.#allowedBuses(),
    });
    this.opts.log(`phone joined ${session.name ?? session.personId}`);
    if (Number.isInteger(msg.bus)) this.#select(session, msg.bus);
  }

  #select(session, bus) {
    if (!this.#busAllowed(bus)) return this.#error(session, 'bus_not_allowed', `Bus ${bus} is not available`);
    const previous = session.bus;
    session.bus = bus;
    session.ready = false;
    if (previous !== null && previous !== bus) this.#broadcastPresence(previous);
    if (!this.connected) {
      // Nothing to show yet; the snapshot goes out as soon as the console comes back.
      this.#send(session, { type: 'console', connected: false });
    } else {
      this.#sendSnapshot(session);
    }
    this.#broadcastPresence(bus);
  }

  // Who else is on a mix, so the owner sees "Diego is also on this mix" and a helper
  // sees whose mix they are on. Sent to every phone on that bus whenever it changes.
  #broadcastPresence(bus) {
    const people = [...this.sessions.values()]
      .filter((s) => s.personId && s.bus === bus)
      .map((s) => ({ session: s.id, personId: s.personId, name: s.name }));
    const text = JSON.stringify({ type: 'presence', bus, people });
    for (const s of this.sessions.values()) if (s.personId && s.bus === bus) s.conn.send(text);
  }

  #set(session, msg) {
    const reject = (code, message) => {
      this.stats.writesRejected++;
      this.#error(session, code, message, msg.seq);
    };
    if (!this.connected) return reject('console_offline', 'Console is not connected');
    if (CHANNEL_FIELDS.has(msg.field)) return this.#setChannel(session, msg, reject);
    const { bus, field } = msg;
    const ch = msg.ch ?? null;
    if (bus !== session.bus || !session.ready) return reject('not_ready', 'Select this bus and wait for its snapshot first');
    if (!this.#busAllowed(bus)) return reject('bus_not_allowed', `Bus ${bus} is not available`);
    const target = ch === null ? 'master' : 'send';
    const cap = CAPABILITY_FOR[target][field];
    if (!cap) return reject('bad_field', `Cannot set ${field} on ${target}`);
    if (!this.state.capabilities[cap]) return reject('unsupported', `${target} ${field} is not supported on this console`);
    if (target === 'send' && !(Number.isInteger(ch) && ch >= 0 && ch < this.state.channels.length)) {
      return reject('bad_channel', `No channel ${ch}`);
    }
    const norm = normalizeValue(field, msg.value);
    if (!norm.ok) return reject('bad_value', norm.reason);
    if (field === 'pan' && !this.state.buses[bus]?.stereo) return reject('unsupported', 'Pan needs a stereo mix');

    const key = paramKey(bus, ch, field);
    if (this.pending.has(key)) this.stats.writesMerged++;
    this.pending.set(key, { bus, ch, field, value: norm.value, sessionId: session.id });
    this.state.values.set(key, norm.value);
    // Other phones on this mix see the move right away.
    this.#broadcastBus(bus, { type: 'changed', bus, ch, field, value: norm.value, origin: session.id }, session.id);
  }

  // Gain and phantom belong to the channel, not to one mix: every phone hears the change, so
  // every phone is told. The phone still needs a ready snapshot (it has seen the current value).
  #setChannel(session, msg, reject) {
    const { field } = msg;
    const ch = msg.ch;
    if (!session.ready) return reject('not_ready', 'Select a mix and wait for its snapshot first');
    if (!this.state.capabilities[CAPABILITY_FOR.channel[field]]) return reject('unsupported', `${field} is not supported on this console`);
    if (!(Number.isInteger(ch) && ch >= 0 && ch < this.state.channels.length)) return reject('bad_channel', `No channel ${ch}`);
    const preamp = this.state.channels[ch]?.preamp;
    if (!preamp) return reject('unsupported', 'This channel has no gain control');
    if (field === 'phantom' && !preamp.phantom) return reject('unsupported', 'This channel has no phantom power');
    const norm = normalizeValue(field, msg.value);
    if (!norm.ok) return reject('bad_value', norm.reason);
    let value = norm.value;
    if (field === 'gain') value = Math.max(preamp.min, Math.min(preamp.max, value));

    const key = paramKey(null, ch, field);
    if (this.pending.has(key)) this.stats.writesMerged++;
    this.pending.set(key, { bus: null, ch, field, value, sessionId: session.id });
    this.state.values.set(key, value);
    this.#broadcastAll({ type: 'changed', bus: null, ch, field, value, origin: session.id }, session.id);
  }

  // --- console side -------------------------------------------------------

  #onConsoleStatus({ connected }) {
    if (connected) {
      this.state = this.driver.snapshot();
      this.connected = true;
      this.opts.log(`console connected: ${this.state.console}`);
      for (const s of this.sessions.values()) {
        this.#send(s, { type: 'console', connected: true, name: this.state.console, model: this.state.model ?? null, buses: this.#allowedBuses() });
        if (s.bus !== null && this.#busAllowed(s.bus)) this.#sendSnapshot(s);
      }
    } else {
      this.connected = false;
      const dropped = this.pending.size;
      this.pending.clear(); // never replay stale writes after a reconnect
      this.opts.log(`console disconnected (${dropped} queued writes dropped)`);
      for (const s of this.sessions.values()) {
        s.ready = false;
        this.#send(s, { type: 'console', connected: false });
      }
    }
  }

  #onConsoleChange({ bus, ch, field, value }) {
    if (!this.state) return;
    const key = paramKey(bus, ch, field);
    // While a phone's write to this parameter is queued or in flight, the console is
    // just echoing older values; skip them so faders don't jump backwards.
    if (this.pending.has(key) || this.inFlight.has(key)) return;
    if (this.state.values.get(key) === value) return;
    this.state.values.set(key, value);
    const msg = { type: 'changed', bus, ch, field, value, origin: 'console' };
    if (bus === null || bus === undefined) this.#broadcastAll({ ...msg, bus: null });
    else this.#broadcastBus(bus, msg);
  }

  #onLayout({ channels = [], buses = [] }) {
    if (!this.state) return;
    for (const c of channels) this.state.channels[c.ch] = { ...this.state.channels[c.ch], ...c };
    for (const b of buses) this.state.buses[b.bus] = { ...this.state.buses[b.bus], ...b };
    for (const s of this.sessions.values()) if (s.personId) this.#send(s, { type: 'layout', channels, buses });
  }

  #flush() {
    if (!this.connected || this.pending.size === 0) return;
    let budget = Math.max(1, Math.floor((this.opts.maxWritesPerSecond * this.opts.flushIntervalMs) / 1000));
    for (const [key, w] of this.pending) {
      if (budget <= 0) break;
      if (this.inFlight.has(key)) continue;
      const now = Date.now();
      if (now - (this.lastWriteAt.get(key) ?? 0) < this.opts.perParamIntervalMs) continue;
      this.lastWriteAt.set(key, now);
      this.pending.delete(key);
      this.inFlight.add(key);
      budget--;
      this.stats.writesSent++;
      this.driver
        .set(w.bus, w.ch, w.field, w.value)
        .then(() => {
          const s = this.sessions.get(w.sessionId);
          this.opts.onAudit({ at: new Date().toISOString(), personId: s?.personId ?? null, name: s?.name ?? null, bus: w.bus, ch: w.ch, field: w.field, value: w.value });
        })
        .catch((err) => {
          this.stats.writesFailed++;
          const s = this.sessions.get(w.sessionId);
          if (s) this.#error(s, 'write_failed', err.message);
        })
        .finally(() => this.inFlight.delete(key));
    }
  }

  #sendMeters() {
    if (!this.connected || !this.lastMeters || !this.state.capabilities.meters) return;
    const ch = this.lastMeters.ch.map((v) => (v === null || v === undefined ? null : Math.round(v)));
    for (const s of this.sessions.values()) {
      if (!s.meters || !s.ready) continue;
      // A phone on bad Wi-Fi skips meter frames instead of building a backlog.
      if (s.conn.bufferedAmount > this.opts.maxClientBufferBytes) continue;
      const master = this.lastMeters.bus?.[s.bus];
      this.#send(s, { type: 'meters', ch, master: master === undefined || master === null ? null : Math.round(master) });
    }
  }

  #heartbeat() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.conn.lastSeen > this.opts.idleTimeoutMs) s.conn.close(4000, 'idle');
      else s.conn.ping();
    }
  }

  // --- helpers ------------------------------------------------------------

  #busAllowed(bus) {
    if (!Number.isInteger(bus) || !this.state) return Number.isInteger(bus) && (this.opts.allowedBuses?.includes(bus) ?? true);
    if (bus < 0 || bus >= this.state.buses.length) return false;
    return this.opts.allowedBuses ? this.opts.allowedBuses.includes(bus) : true;
  }

  #allowedBuses() {
    if (!this.connected || !this.state) return [];
    return this.state.buses.filter((b) => this.#busAllowed(b.bus));
  }

  #sendSnapshot(session) {
    const bus = session.bus;
    const v = this.state.values;
    const buses = this.#allowedBuses();
    this.#send(session, {
      type: 'snapshot',
      bus,
      console: { connected: true, name: this.state.console, model: this.state.model ?? null },
      capabilities: this.state.capabilities,
      buses,
      channels: this.state.channels,
      master: { level: v.get(paramKey(bus, null, 'level')) ?? null, mute: v.get(paramKey(bus, null, 'mute')) ?? false },
      sends: this.state.channels.map((c) => ({
        ch: c.ch,
        level: v.get(paramKey(bus, c.ch, 'level')) ?? null,
        mute: v.get(paramKey(bus, c.ch, 'mute')) ?? false,
        pan: this.state.capabilities.sendPan ? (v.get(paramKey(bus, c.ch, 'pan')) ?? 0) : null,
      })),
      // Channel-wide values for channels with a preamp (see channels[i].preamp).
      preamps: this.state.channels.filter((c) => c.preamp).map((c) => ({
        ch: c.ch,
        gain: v.get(paramKey(null, c.ch, 'gain')) ?? null,
        phantom: c.preamp.phantom ? (v.get(paramKey(null, c.ch, 'phantom')) ?? false) : null,
      })),
    });
    session.ready = true;
  }

  #broadcastBus(bus, msg, exceptSessionId = null) {
    const text = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (s.id !== exceptSessionId && s.ready && s.bus === bus) s.conn.send(text);
    }
  }

  #broadcastAll(msg, exceptSessionId = null) {
    const text = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (s.id !== exceptSessionId && s.ready) s.conn.send(text);
    }
  }

  #send(session, msg) {
    session.conn.send(JSON.stringify(msg));
  }

  #error(session, code, message, seq) {
    this.#send(session, { type: 'error', code, message, ...(seq !== undefined ? { seq } : {}) });
  }
}
