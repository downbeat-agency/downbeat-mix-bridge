// Rig status on GitHub, so someone at home can see which rigs run the newest bridge
// without a phone. After every update check the bridge writes its own file,
// rigs/<rig>.json, in a small private repo (downbeat-agency/downbeat-rig-status). A GitHub
// Action there turns the files into a table on the repo's front page.
//
// Needs a GitHub token that can write that one repo (fine-grained, Contents: read and
// write), set once per rig in config.json as "status": { "token": "..." }. With no token
// the bridge simply does not report. No internet: the report fails quietly and the next
// check tries again.
import { hostname } from 'node:os';

export const DEFAULT_STATUS_CONFIG = {
  repo: 'downbeat-agency/downbeat-rig-status',
  token: null,
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

  get enabled() { return Boolean(this.cfg.token); }

  /** The JSON written for this rig. */
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
      reportedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Writes this rig's file. Never throws; returns what happened. */
  async report(result, lastUpdate = null) {
    if (!this.enabled) return { action: 'disabled' };
    const url = `https://api.github.com/repos/${this.cfg.repo}/contents/${this.path}`;
    const headers = {
      authorization: `Bearer ${this.cfg.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'downbeat-mix-bridge',
      'x-github-api-version': '2022-11-28',
    };
    try {
      const signal = AbortSignal.timeout(this.cfg.timeoutMs);
      const existing = await this.fetchImpl(url, { headers, signal });
      if (existing.status !== 200 && existing.status !== 404) throw new Error(`GitHub ${existing.status}`);
      const sha = existing.status === 200 ? (await existing.json()).sha : undefined;
      const body = this.body(result, lastUpdate);
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          message: `${this.rigName}: ${this.version} (${body.update.status ?? 'checked in'})`,
          content: Buffer.from(`${JSON.stringify(body, null, 2)}\n`).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      return { action: 'reported', path: this.path };
    } catch (e) {
      this.log(`status report failed: ${e.message}`);
      return { action: 'failed', error: e.message };
    }
  }
}
