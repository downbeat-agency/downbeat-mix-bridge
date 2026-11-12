// Rig status, so someone at home can see which rigs run the newest bridge without a
// phone. After every update check the bridge posts a small check-in (version, update
// result, console, phone count) to the rig check-in service on Railway. That service
// writes rigs/<rig>.json in the private repo downbeat-agency/downbeat-rig-status, and a
// GitHub Action there turns the files into a table on the repo's front page.
//
// Nothing to set up on a rig: no token or secret lives here. To turn it off, set
// "status": { "url": null } in config.json. No internet: the check-in fails quietly and
// the next update check tries again.
import { hostname } from 'node:os';

export const DEFAULT_STATUS_CONFIG = {
  url: 'https://checkin-production-441c6f38.up.railway.app/checkin',
  timeoutMs: 20 * 1000,
};

/** Updater result -> the status shown on the rig table. */
export function updateStatus(result) {
  switch (result?.action) {
    case 'current': return 'up_to_date';
    case 'installed': return 'updated';
    case 'waiting': return 'waiting_for_phones';
    case 'skipped-rolled-back': return 'rolled_back';
    case 'bad-checksum':
    case 'incomplete': return 'failed';
    case 'offline':
    case 'error': return 'check_failed';
    default: return null;
  }
}

/** "dLive Green" -> "dlive-green": one file per rig name. */
export function rigSlug(name) {
  const slug = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'rig';
}

export class StatusReporter {
  /**
   * @param {object} o
   * @param {string} o.rigName
   * @param {string} o.version
   * @param {() => object} o.health   the bridge's /health (console, phones)
   * @param {(m: string) => void} [o.log]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {() => number} [o.now]
   */
  constructor({ rigName, version, health, log = () => {}, fetchImpl = fetch, now = Date.now, config = {}, startedAt = Date.now() }) {
    this.cfg = { ...DEFAULT_STATUS_CONFIG, ...config };
    Object.assign(this, { rigName, version, health, log, fetchImpl, now, startedAt });
    this.path = `rigs/${rigSlug(rigName)}.json`;
  }

  get enabled() { return Boolean(this.cfg.url); }

  /** The check-in sent for this rig. */
  body(result, lastUpdate = null) {
    const h = this.health?.() ?? {};
    return {
      rig: this.rigName,
      version: this.version,
      latestRelease: result?.version && result.action !== 'error' ? result.version : null,
      update: {
        status: updateStatus(result),
        message: result?.error ?? null,
        at: new Date(this.now()).toISOString(),
      },
      lastUpdate,
      console: { connected: Boolean(h.console?.connected), name: h.console?.name ?? null, model: h.console?.model ?? null },
      phones: Array.isArray(h.phones) ? h.phones.length : 0,
      uptimeSeconds: Math.max(0, Math.round((this.now() - this.startedAt) / 1000)),
      host: hostname(),
    };
  }

  /** Posts this rig's check-in. Never throws; returns what happened. */
  async report(result, lastUpdate = null) {
    if (!this.enabled) return { action: 'disabled' };
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `downbeat-mix-bridge/${this.version}` },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        body: JSON.stringify(this.body(result, lastUpdate)),
      });
      if (!res.ok) throw new Error(`check-in ${res.status}`);
      return { action: 'reported', path: this.path };
    } catch (e) {
      this.log(`status check-in failed: ${e.message}`);
      return { action: 'failed', error: e.message };
    }
  }
}
