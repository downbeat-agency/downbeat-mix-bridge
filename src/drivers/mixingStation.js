// Console driver that talks to Mixing Station desktop's local API on the same Mac Mini.
//
// Confirmed on the Green rig Mac Mini (Mixing Station 3.2.2, dLive offline model, 2026-11-07):
//   - websocket at ws://<host>:<port>/  (port 8080 is taken by UniFi there; we use 8091)
//   - envelope { path, method, body } -> reply { path, method, body | error }
//   - writes need a Mixing Station user with "API: Write": POST /auth/login { user, password }
//     over the websocket authenticates that connection. Without it writes return "Access Denied".
//   - GET /console/mixTargets lists every send target. A target's `id` is the send index
//     (ch.N.mix.sends.<id>.*) and its `channelIndex` is the bus's own channel (master fader,
//     name, color, meter). Monitor mixes are channelType.type 4 ("Mix" / "St Mix").
//   - GET /console/information: input channels are channelTypes[type 0].count (128 on dLive),
//     starting at its `offset` in the shared ch.N index space.
//   - FX returns (dLive) are another channel type in the same index space. Not yet seen on a
//     rig: we pick the type whose name looks like "FX return" (or cfg.fxReturns.type) and
//     log every channel type at startup so rig prep can confirm it (scripts/ms-probe.js).
//   - per-send paths: ch.{ch}.mix.sends.{send}.lvl (dB, -90..10), .on (true = not muted),
//     .pan (stereo targets only, -37..37). Bus master: ch.{bus}.mix.lvl / .on.
//   - names ch.{ch}.cfg.name, colors ch.{ch}.cfg.color (enum 0 Black .. 7 White).
//   - subscribe pushes updates as { path: "/console/data/get/<dataPath>", body: { value, format } };
//     value null means the parameter no longer exists.
//   - metering2 replies at /console/metering2/{id} with body.v: one entry per requested
//     channel, a number for mono or [L, R] for stereo.
//
// Measured on a live show (Green rig, 2026-11-07, read-only):
//   - full subscription = ~17,900 values / 2.4 MB, taking ~5.4 s to arrive. We wait until the
//     stream goes quiet before calling the console "connected", so phones never get a half
//     snapshot.
//   - real show layout: 4 mono mixes (sub + wedges) then 19 stereo mixes (12 IEMs + spares).
//     By default only named stereo mixes are offered to phones.
//   - meters read in dB relative to the console's scale (dbfsOffset 18): peaks reach about
//     +5, silence is about -110. Anything at or below -90 is sent as null.
//   - a musician dragging a fader in Mixing Station produces ~15 updates/s.
//   - live write test on spare Mix 19 (master down, values restored after): 60 send moves at
//     25/s all landed and echoed back; mute and pan writes echoed too. Successful sets get no
//     reply, so writes are fire-and-forget with a short window for an error.
import { EventEmitter } from 'node:events';
import { paramKey } from '../model.js';
import { DEFAULT_STEREO_PAIRS, findPairs } from '../stereoPairs.js';

export const DEFAULT_MS_CONFIG = {
  wsUrl: 'ws://127.0.0.1:8091/',
  // Mixing Station user with "API: Write" (Global settings -> Permissions -> Users).
  auth: null, // { user: 'admin', password: '...' }
  // Optional cap on input channels shown to phones (dLive has 128).
  maxInputs: null,
  // Console model sent to phones; picks the standard Mix groups ("dlive", "wing").
  // 'auto' reads it from Mixing Station, so one install works on dLive and Wing rigs.
  consoleModel: 'auto',
  // FX returns shown to phones after the inputs (so a "Verbs" group works). `type` forces
  // a Mixing Station channel type number when the name match is not enough.
  fxReturns: { enabled: true, type: null, namePattern: 'fx\\s*ret|fx\\s*return|^fx$' },
  // dLive UFX returns (the external effects rack: most show reverbs come back here), shown
  // after the FX returns. Mixing Station 3.2 calls the type "UFX Ret" (type 102).
  ufxReturns: { enabled: true, type: null, namePattern: 'ufx\\s*ret|ufx\\s*return|^ufx\\s*r$' },
  // Wing aux inputs (Aux 1-8): stereo line inputs where reverb and playback returns usually
  // come in. Mixing Station 3.2 calls the type "Aux" (type 1). Phone kind "aux".
  auxInputs: { enabled: true, type: null, namePattern: '^aux$|aux\\s*in' },
  // Wing buses as sources: a Wing bus can feed other buses, and Wing shows put reverbs and
  // delays on buses (13 HALL V, 15 DELAY...). Phones get each bus as kind "bus" (Bus 1-16)
  // and control its send into their mix, so a hall reverb can be turned down in one ear mix.
  // Only a channel type named "Bus" that Mixing Station says can feed buses (the Wing);
  // dLive Mix/St Mix types are never sources.
  busSends: { enabled: true, namePattern: '^bus$' },
  // Linked stereo inputs shown as one strip on phones (see src/stereoPairs.js).
  // pairs/unpair are input numbers for this rig, e.g. { pairs: [[17, 18]], unpair: [[13, 14]] }.
  stereoPairs: DEFAULT_STEREO_PAIRS,
  // Mixing Station color enum -> our names. 0 (Black) is "no color" on dLive.
  colorMap: { 0: null, 1: 'red', 2: 'green', 3: 'yellow', 4: 'blue', 5: 'purple', 6: 'lightblue', 7: 'white' },
  meters: { enabled: true, intervalMs: 100 },
  // Which mixes phones may use. stereoOnly hides the sub and wedges (mono mixes);
  // hideUnnamed hides spare mixes still called "Mix 13" etc. includeNames, if set, wins.
  busFilter: { stereoOnly: true, hideUnnamed: true, includeNames: null, excludeNames: [] },
  // Initial sync: wait until no value has arrived for quietMs (at least settleMs, at most maxSyncMs).
  settleMs: 300,
  quietMs: 600,
  maxSyncMs: 30000,
  requestTimeoutMs: 3000,
  // How long to listen for an "Access Denied"-style error after a write before treating it as done.
  writeErrorWindowMs: 250,
  keepAliveMs: 5000,
  // A connection attempt that neither opens nor fails in this time is dropped and retried.
  // Seen on the Green rig (2026-11-09): after a restart the bridge reached Mixing Station
  // while it was still starting, the attempt hung, and the bridge never retried.
  openTimeoutMs: 8000,
  // An open socket that has heard nothing from Mixing Station for this long (it answers the
  // 5 s keep-alive) is treated as dead and reopened.
  silenceMs: 20000,
  reconnectMs: [500, 1000, 2000, 5000],
};

const MIX_TYPE = 4;

export class MixingStationDriver extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cfg = {
      ...DEFAULT_MS_CONFIG,
      ...config,
      meters: { ...DEFAULT_MS_CONFIG.meters, ...(config.meters ?? {}) },
      busFilter: { ...DEFAULT_MS_CONFIG.busFilter, ...(config.busFilter ?? {}) },
      fxReturns: { ...DEFAULT_MS_CONFIG.fxReturns, ...(config.fxReturns ?? {}) },
      ufxReturns: { ...DEFAULT_MS_CONFIG.ufxReturns, ...(config.ufxReturns ?? {}) },
      auxInputs: { ...DEFAULT_MS_CONFIG.auxInputs, ...(config.auxInputs ?? {}) },
      busSends: { ...DEFAULT_MS_CONFIG.busSends, ...(config.busSends ?? {}) },
      stereoPairs: { ...DEFAULT_STEREO_PAIRS, ...(config.stereoPairs ?? {}) },
    };
    this.lastDataAt = 0;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0;
    // Phone-facing channels: `ch` is dense (inputs 0..n-1, then FX returns), `ms` is the
    // Mixing Station channel index used in paths and meters.
    this.channels = []; // { ch, ms, kind, number, name, color, link }
    this.byMs = new Map();
    this.buses = []; // { bus, name, stereo, send, channel }
    this.values = new Map();
    this.panRange = [-37, 37];
    this.canWrite = false;
    this.waiters = new Map();
  }

  get capabilities() {
    const anyStereo = this.buses.some((b) => b.stereo);
    return {
      sendLevel: true,
      sendMute: true,
      sendPan: anyStereo,
      busMaster: true,
      meters: !!this.cfg.meters.enabled,
      names: true,
      colors: true,
    };
  }

  async connect() {
    this.stopped = false;
    this.#open();
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepAlive);
    this.ws?.close();
  }

  snapshot() {
    return {
      console: this.consoleName ?? 'Mixing Station',
      model: this.consoleModel ?? null,
      capabilities: this.capabilities,
      channels: this.channels.map(({ ms, blankName, ...c }) => ({ ...c })),
      buses: this.buses.map(({ bus, name, stereo, channel }) => ({ bus, name, stereo, ...this.#selfOf(channel) })),
      values: new Map(this.values),
    };
  }

  async set(bus, ch, field, value) {
    if (!this.connected) throw new Error('console offline');
    if (!this.canWrite) throw new Error('Mixing Station write access is not set up (auth)');
    const b = this.buses[bus];
    if (!b) throw new Error(`no bus ${bus}`);
    let path;
    if (ch === null) path = this.#masterPath(b, field);
    else {
      const c = this.channels[ch];
      if (!c) throw new Error(`no channel ${ch}`);
      if (c.ms === b.channel) throw new Error('a mix cannot be sent into itself');
      path = this.#sendPath(b, c.ms, field);
    }
    if (!path) throw new Error(`${field} not supported here`);
    await this.#write(`/console/data/set/${path}/val`, { value: this.#toMs(field, value) });
  }

  // Confirmed on the live Green rig (2026-11-07): a successful set gets NO reply; only a
  // refused one answers with { path, method, error }. The change itself comes back as a
  // normal /console/data/get/ update. So a write succeeds unless an error arrives quickly.
  #write(path, body) {
    return new Promise((resolve, reject) => {
      const key = `POST ${path}`;
      const prev = this.waiters.get(key);
      if (prev) prev.resolve(); // a newer write to the same path supersedes the older one
      const timer = setTimeout(() => {
        if (this.waiters.get(key)?.timer === timer) this.waiters.delete(key);
        resolve();
      }, this.cfg.writeErrorWindowMs);
      this.waiters.set(key, {
        timer,
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#send({ path, method: 'POST', body });
    });
  }

  // Never throw from an event: an 'error' event with no listener would crash the process.
  // `info` notes go to the 'info' event (logged by index.js), not 'error'.
  #warn(err, level = 'error') {
    if (this.listenerCount(level) > 0) this.emit(level, err);
  }

  // --- paths -----------------------------------------------------------------

  /** `self`: the phone channel that is this mix's own bus (Wing bus sends), so phones hide it. */
  #selfOf(channel) {
    const c = this.byMs?.get(channel);
    return c ? { self: c.ch } : {};
  }

  #sendPath(b, ch, field) {
    const leaf = { level: 'lvl', mute: 'on', pan: 'pan' }[field];
    if (!leaf || (field === 'pan' && !b.stereo)) return null;
    return `ch.${ch}.mix.sends.${b.send}.${leaf}`;
  }

  #masterPath(b, field) {
    const leaf = { level: 'lvl', mute: 'on' }[field];
    return leaf ? `ch.${b.channel}.mix.${leaf}` : null;
  }

  // --- websocket -------------------------------------------------------------

  #open() {
    let ws;
    try {
      ws = new WebSocket(this.cfg.wsUrl);
    } catch (err) {
      this.#warn(err);
      return this.#retry();
    }
    this.ws = ws;
    let finished = false;
    // Exactly one retry per socket, however it ends (close event, timeout or watchdog).
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(openTimer);
      if (this.ws === ws) this.#onClose();
    };
    const drop = (why) => {
      this.#warn(new Error(`Mixing Station connection ${why}; reconnecting`), 'info');
      try { ws.close(); } catch { /* already closing */ }
      setTimeout(finish, 2000); // a stuck socket may never send its close event
    };
    const openTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) drop('did not open');
    }, this.cfg.openTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(openTimer);
      this.attempt = 0;
      this.lastHeardAt = Date.now();
      // Measured live (Green rig, 2026-11-07): Mixing Station closes a websocket after 30 s
      // with no traffic (close code 1001). Either direction counts: a 5 s /app/state request
      // or a 1 s meter subscription each kept test sockets open indefinitely. The bridge does
      // both (meters when enabled). Node timers are not throttled, unlike a hidden browser
      // tab, which is what caused the browser logger's once-a-minute reconnects.
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        if (Date.now() - this.lastHeardAt > this.cfg.silenceMs) return drop('went silent');
        this.#send({ path: '/app/state', method: 'GET', body: null });
      }, this.cfg.keepAliveMs);
      this.#sync().catch((err) => {
        this.#warn(err);
        ws.close();
      });
    });
    ws.addEventListener('message', (ev) => {
      this.lastHeardAt = Date.now();
      this.#onMessage(ev.data);
    });
    ws.addEventListener('close', finish);
    ws.addEventListener('error', () => {});
  }

  #retry() {
    if (this.stopped) return;
    const d = this.cfg.reconnectMs;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#open(), d[Math.min(this.attempt++, d.length - 1)]);
  }

  #onClose() {
    clearInterval(this.keepAlive);
    for (const w of this.waiters.values()) w.reject(new Error('Mixing Station connection closed'));
    this.waiters.clear();
    const was = this.connected;
    this.connected = false;
    if (was) this.emit('status', { connected: false });
    this.syncing = false;
    this.mixerOnline = false;
    this.#retry();
  }

  async #sync() {
    if (this.syncing) return;
    this.syncing = true;
    const ws = this.ws;
    try {
      const state = await this.#request('/app/state', 'GET', null);
      this.mixerOnline = state?.topState === 'connected';
      if (!this.mixerOnline) return; // wait for /app/state to report the mixer

      if (this.cfg.auth) {
        try {
          const r = await this.#request('/auth/login', 'POST', { user: this.cfg.auth.user, password: this.cfg.auth.password ?? '' });
          this.canWrite = Array.isArray(r?.roles) ? r.roles.length > 0 || !!r.token : true;
        } catch (e) {
          this.canWrite = false;
          this.#warn(new Error(`Mixing Station login failed: ${e.message}`));
        }
      }

      const info = await this.#request('/console/information', 'GET', null);
      this.#detectConsole(info);
      this.#buildChannels(info?.channelTypes ?? []);

      const tg = await this.#request('/console/mixTargets', 'GET', null);
      const f = this.cfg.busFilter;
      const unnamed = /^(st\s*)?mix\s*\d+$/i;
      const mixes = (tg?.targets ?? []).filter((t) => {
        if (!t.isChannel || t.channelType?.type !== MIX_TYPE) return false;
        const name = String(t.name ?? '').trim();
        if (f.includeNames) return f.includeNames.includes(name);
        if (f.excludeNames?.includes(name)) return false;
        if (f.stereoOnly && !t.channelType.stereo) return false;
        if (f.hideUnnamed && (!name || unnamed.test(name))) return false;
        return true;
      });
      this.buses = mixes.map((t, bus) => ({ bus, name: t.name, stereo: !!t.channelType.stereo, send: t.id, channel: t.channelIndex }));
      this.sendToBus = new Map(this.buses.map((b) => [b.send, b.bus]));
      this.channelToBus = new Map(this.buses.map((b) => [b.channel, b.bus]));

      try {
        const firstStereo = this.buses.find((b) => b.stereo);
        if (firstStereo) {
          const defs = await this.#request(`/console/data/definitions/ch.0.mix.sends.${firstStereo.send}.pan`, 'GET', null);
          const d = Object.values(defs?.definitions ?? {})[0]?.definition;
          if (Number.isFinite(d?.min) && Number.isFinite(d?.max) && d.max > d.min) this.panRange = [d.min, d.max];
        }
      } catch {
        /* keep default */
      }

      for (const p of ['ch.*.cfg.name', 'ch.*.cfg.color', 'ch.*.mix.sends.*.lvl', 'ch.*.mix.sends.*.on', 'ch.*.mix.sends.*.pan', 'ch.*.mix.lvl', 'ch.*.mix.on']) {
        this.#send({ path: '/console/data/subscribe', method: 'POST', body: { path: p, format: 'val' } });
      }
      if (this.cfg.meters.enabled) {
        const params = [...this.channels.map((c) => ({ type: 0, index: c.ms })), ...this.buses.map((b) => ({ type: 0, index: b.channel }))];
        this.#send({ path: '/console/metering2/subscribe', method: 'POST', body: { id: 0, interval: this.cfg.meters.intervalMs, binary: false, params } });
      }
      // Subscriptions answer with every current value straight away (thousands on a real show).
      // Wait for the stream to go quiet so phones never get a half-filled snapshot.
      const started = Date.now();
      this.lastDataAt = Date.now();
      await new Promise((r) => setTimeout(r, this.cfg.settleMs));
      while (Date.now() - this.lastDataAt < this.cfg.quietMs && Date.now() - started < this.cfg.maxSyncMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.ws !== ws || ws?.readyState !== WebSocket.OPEN) return;
      this.connected = true;
      this.emit('status', { connected: true });
    } finally {
      if (this.ws === ws) this.syncing = false;
    }
  }

  // Which console Mixing Station is driving. The /console/information field names for the
  // model are not documented, so look for "dLive" or "Wing" in any of its text values.
  #detectConsole(info) {
    const texts = [];
    for (const [key, value] of Object.entries(info ?? {})) {
      if (typeof value === 'string') texts.push([key, value]);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) if (typeof v === 'string') texts.push([`${key}.${k}`, v]);
      }
    }
    const found = texts.find(([, v]) => /d\s*live|wing/i.test(v));
    // Mixing Station 3.2 sends no model text (seen on the Green dLive, 2026-11-08), so fall
    // back to the channel layout: a dLive has 128 inputs and "FX Return" channels; a Wing has
    // 40 inputs and "Aux" inputs.
    const types = Array.isArray(info?.channelTypes) ? info.channelTypes : [];
    const inputs = types.find((t) => t.type === 0)?.count ?? 0;
    const hasAux = types.some((t) => /\baux\b/i.test(`${t.name ?? ''} ${t.shortName ?? ''}`));
    const byLayout = inputs === 40 || (hasAux && inputs <= 48) ? 'wing' : inputs >= 64 ? 'dlive' : null;
    const detected = found ? (/wing/i.test(found[1]) ? 'wing' : 'dlive') : byLayout;
    const configured = this.cfg.consoleModel && this.cfg.consoleModel !== 'auto' ? this.cfg.consoleModel : null;
    this.consoleModel = configured ?? detected ?? 'dlive';
    this.consoleName = found?.[1] ?? (this.consoleModel === 'wing' ? 'Wing' : 'dLive');
    this.#warn(new Error(`console: ${JSON.stringify(Object.fromEntries(texts))} -> ${this.consoleModel}`), 'info');
  }

  // Inputs first (ch 0..n-1 keep their console numbers), then FX returns numbered FX 1…
  #buildChannels(types) {
    const offsetOf = (t, index) => {
      if (Number.isInteger(t.offset)) return t.offset;
      return types.slice(0, index).reduce((sum, x) => sum + (Number(x.count) || 0), 0);
    };
    const inputIndex = types.findIndex((t) => t.type === 0);
    const inputs = types[inputIndex];
    let count = inputs?.count ?? 0;
    if (this.cfg.maxInputs) count = Math.min(count, this.cfg.maxInputs);
    const inputStart = inputs ? offsetOf(inputs, inputIndex) : 0;
    const channels = Array.from({ length: count }, (_, i) => ({
      ch: i, ms: inputStart + i, kind: 'input', number: i + 1, name: `Ch ${i + 1}`, color: null, link: null,
    }));

    // Effect returns follow the inputs, each kind numbered from 1 ("FX 2", "UFX 5").
    const isUfx = (t) => /ufx/i.test(String(t.name ?? '')) || /ufx/i.test(String(t.shortName ?? ''));
    const addReturns = (cfg, kind, label, accept) => {
      if (!cfg?.enabled) return null;
      const pattern = new RegExp(cfg.namePattern, 'i');
      const index = types.findIndex((t) => (Number.isInteger(cfg.type)
        ? t.type === cfg.type
        : t.type !== 0 && accept(t) && (pattern.test(String(t.name ?? '')) || pattern.test(String(t.shortName ?? '')))));
      const type = types[index];
      if (!type || !(type.count > 0)) return null;
      const start = offsetOf(type, index);
      for (let i = 0; i < type.count; i++) {
        channels.push({ ch: channels.length, ms: start + i, kind, number: i + 1, name: `${label} ${i + 1}`, color: null, link: null });
      }
      return type;
    };
    const fxType = addReturns(this.cfg.fxReturns, 'fx_return', 'FX', (t) => !isUfx(t));
    const ufxType = addReturns(this.cfg.ufxReturns, 'ufx_return', 'UFX', isUfx);
    const auxType = addReturns(this.cfg.auxInputs, 'aux', 'Aux', (t) => !/send|snd/i.test(`${t.name ?? ''} ${t.shortName ?? ''}`));
    const feedsBuses = (t) => (t.signalTargets ?? []).some((s) => s?.channelType?.type === t.type);
    const busType = addReturns(this.cfg.busSends, 'bus', 'Bus', (t) => t.type === MIX_TYPE && feedsBuses(t));
    const found = (t) => (t ? `type ${t.type} x${t.count}` : 'not found');
    this.#warn(new Error(`channel types: ${JSON.stringify(types.map(({ type, name, shortName, count, offset }) => ({ type, name, shortName, count, offset })))}; FX returns ${found(fxType)}; UFX returns ${found(ufxType)}; aux inputs ${found(auxType)}; bus sends ${found(busType)}`), 'info');
    this.channels = channels;
    this.byMs = new Map(channels.map((c) => [c.ms, c]));
    this.#relink();
  }

  /** Recomputes linked pairs; returns the channels whose link changed. */
  #relink() {
    const links = findPairs(this.channels, this.cfg.stereoPairs);
    const changed = [];
    for (const c of this.channels) {
      const next = links.get(c.ch) ?? null;
      if (c.link !== next) {
        c.link = next;
        changed.push(c);
      }
    }
    return changed;
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  #request(path, method, body) {
    return new Promise((resolve, reject) => {
      const key = `${method} ${path}`;
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`Mixing Station did not answer ${path}`));
      }, this.cfg.requestTimeoutMs);
      this.waiters.set(key, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#send({ path, method, body });
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    const w = this.waiters.get(`${msg.method} ${msg.path}`);
    if (w) {
      this.waiters.delete(`${msg.method} ${msg.path}`);
      msg.error ? w.reject(new Error(String(msg.error))) : w.resolve(msg.body);
      if (msg.path === '/app/state') return;
    }
    if (msg.path === '/app/state') return this.#onAppState(msg.body);
    if (typeof msg.path !== 'string') return;
    if (msg.path.startsWith('/console/metering2/')) return this.#onMeters(msg.body);
    if (msg.path.startsWith('/console/data/get/') && msg.body && 'value' in msg.body) {
      this.lastDataAt = Date.now();
      this.#applyUpdate(msg.path.slice('/console/data/get/'.length), msg.body.value);
    }
  }

  #onAppState(body) {
    const online = body?.topState === 'connected';
    if (online === this.mixerOnline) return;
    this.mixerOnline = online;
    if (!online && this.connected) {
      this.connected = false;
      this.emit('status', { connected: false });
    } else if (online && !this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.#sync().catch((e) => this.#warn(e));
    }
  }

  #applyUpdate(path, v) {
    const p = path.split('.');
    if (p[0] !== 'ch') return;
    const ch = Number(p[1]); // Mixing Station index
    if (p[2] === 'cfg' && (p[3] === 'name' || p[3] === 'color')) {
      const c = this.byMs.get(ch);
      if (c) {
        if (p[3] === 'name') {
          c.name = v ? String(v) : `${{ input: 'Ch', fx_return: 'FX', ufx_return: 'UFX', aux: 'Aux', bus: 'Bus' }[c.kind] ?? c.kind} ${c.number}`;
          // An empty name from the console (not just "no name yet") marks a stereo right half.
          c.blankName = v === '' || (typeof v === 'string' && !v.trim());
        }
        else c.color = this.cfg.colorMap[Math.round(Number(v))] ?? null;
        // A rename can make or break an L/R pair.
        const touched = new Set([c, ...(p[3] === 'name' ? this.#relink() : [])]);
        this.#layout({ channels: [...touched].map(({ ms, blankName, ...pub }) => pub) });
        // A Wing bus is both a mix and a source channel: rename the mix too.
        if (c.kind !== 'bus' || p[3] !== 'name') return;
      }
      const bus = this.channelToBus?.get(ch);
      if (bus !== undefined && p[3] === 'name' && v) {
        this.buses[bus].name = String(v);
        return this.#layout({ buses: [{ bus, name: this.buses[bus].name, stereo: this.buses[bus].stereo }] });
      }
      return;
    }
    if (p[2] !== 'mix') return;
    if (p[3] === 'sends' && p.length === 6) {
      const bus = this.sendToBus?.get(Number(p[4]));
      const c = this.byMs.get(ch);
      if (bus === undefined || !c) return;
      const field = { lvl: 'level', on: 'mute', pan: 'pan' }[p[5]];
      if (field) this.#setValue(bus, c.ch, field, this.#fromMs(field, v));
      return;
    }
    if (p.length === 4) {
      const bus = this.channelToBus?.get(ch);
      const field = { lvl: 'level', on: 'mute' }[p[3]];
      if (bus !== undefined && field) this.#setValue(bus, null, field, this.#fromMs(field, v));
    }
  }

  #setValue(bus, ch, field, value) {
    const key = paramKey(bus, ch, field);
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    if (this.connected) this.emit('change', { bus, ch, field, value });
  }

  #layout(l) {
    if (this.connected) this.emit('layout', l);
  }

  #onMeters(body) {
    const v = body?.v;
    if (!Array.isArray(v)) return;
    const peak = (x) => {
      const v = Array.isArray(x) ? (x.length ? Math.max(...x) : null) : x;
      return Number.isFinite(v) && v > -90 ? v : null;
    };
    const n = this.channels.length;
    this.emit('meters', { ch: v.slice(0, n).map(peak), bus: v.slice(n, n + this.buses.length).map(peak) });
  }

  // --- value conversion --------------------------------------------------------

  #toMs(field, value) {
    if (field === 'mute') return !value; // Mixing Station "on" = not muted
    if (field === 'pan') {
      const [lo, hi] = this.panRange;
      return lo + ((value + 1) / 2) * (hi - lo);
    }
    return value === null ? -90 : value; // level
  }

  #fromMs(field, v) {
    if (field === 'mute') return v === null ? false : !v;
    if (field === 'pan') {
      const [lo, hi] = this.panRange;
      return v === null ? 0 : Math.round((((Number(v) - lo) / (hi - lo)) * 2 - 1) * 100) / 100;
    }
    const n = Number(v);
    return v === null || !Number.isFinite(n) || n <= -90 ? null : Math.round(n * 10) / 10;
  }
}
