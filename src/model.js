// Driver-agnostic mix model shared by the bridge and every console driver.
//
// Indices are zero-based internally (ch 0 = channel 1, bus 0 = Stereo Mix 1).
// Levels are dB numbers; null means -inf (fully off). Pan is -1 (L) .. 1 (R).

export const LEVEL_MIN_DB = -90; // anything at or below is treated as -inf
export const LEVEL_MAX_DB = 10;

// dLive offers 7 colours or none; Wing has more. Phones get one of these names or null.
export const COLORS = ['red', 'green', 'yellow', 'blue', 'purple', 'lightblue', 'white', 'orange', 'pink'];

export const FIELDS = {
  level: 'level',
  mute: 'mute',
  pan: 'pan',
  gain: 'gain',
  phantom: 'phantom',
};

// Channel-wide fields: they belong to the input itself, not to one mix, so a change is heard
// in every ear mix, front of house and the recording. Phones unlock them one channel at a time.
export const CHANNEL_FIELDS = new Set(['gain', 'phantom']);

export function paramKey(bus, ch, field) {
  if (bus === null || bus === undefined) return `p:${ch}:${field}`; // channel-wide (gain, phantom)
  return ch === null || ch === undefined ? `${bus}:m:${field}` : `${bus}:${ch}:${field}`;
}

/** Validate and normalize a value for a field. Returns { ok, value } or { ok:false, reason }. */
export function normalizeValue(field, value) {
  switch (field) {
    case 'level': {
      if (value === null) return { ok: true, value: null };
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'level must be a number or null' };
      if (value <= LEVEL_MIN_DB) return { ok: true, value: null };
      return { ok: true, value: Math.round(Math.min(value, LEVEL_MAX_DB) * 10) / 10 };
    }
    case 'mute':
      if (typeof value !== 'boolean') return { ok: false, reason: 'mute must be true or false' };
      return { ok: true, value };
    case 'pan': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'pan must be a number' };
      return { ok: true, value: Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100 };
    }
    case 'gain': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'gain must be a number' };
      return { ok: true, value: Math.round(value * 10) / 10 };
    }
    case 'phantom':
      if (typeof value !== 'boolean') return { ok: false, reason: 'phantom must be true or false' };
      return { ok: true, value };
    default:
      return { ok: false, reason: `unknown field ${field}` };
  }
}

export function emptyCapabilities() {
  return { sendLevel: false, sendMute: false, sendPan: false, busMaster: false, meters: false, names: false, colors: false, gain: false, phantom: false };
}
