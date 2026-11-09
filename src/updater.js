// Self-update from GitHub Releases, for rig Mac Minis that sit on the warehouse internet
// during the week and on a show network with no internet at gigs.
//
// Every few hours: ask GitHub for the latest release of the public bridge repo. If it is
// newer than this version AND no phone has been connected for a while (never mid-show),
// download the bundle, check its SHA-256 against the release's SHA256SUMS, unpack it next
// to the current install, swap folders (keeping the old one as mix-bridge.previous) and
// exit with RESTART_CODE. The launcher (deploy/launcher.js) starts the new version and
// rolls back to the previous one if it keeps crashing. No internet: the check fails
// quietly and runs again later.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const RESTART_CODE = 75;
export const BUNDLE_ASSET = 'DownbeatMixBridge.tar.gz';
export const SUMS_ASSET = 'SHA256SUMS';

export const DEFAULT_UPDATE_CONFIG = {
  enabled: true,
  repo: 'downbeat-agency/downbeat-mix-bridge',
  checkEveryMs: 12 * 60 * 60 * 1000,
  firstCheckAfterMs: 2 * 60 * 1000,
  idleMs: 10 * 60 * 1000,
  // An update held back because phones were connected is tried again this soon.
  retryWhileBusyMs: 15 * 60 * 1000,
  timeoutMs: 60 * 1000,
};

/** -1, 0 or 1 for "1.2.3" style versions (a leading "v" is ignored). */
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

export class Updater {
  /**
   * @param {object} o
   * @param {string} o.currentVersion
   * @param {string} o.installDir   ~/DownbeatMix (holds mix-bridge/, mix-bridge.previous/)
   * @param {() => boolean} o.isIdle  true when no show is using the bridge
   * @param {(m: string) => void} o.log
   * @param {(code: number) => void} [o.exit]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {(file: string, dir: string) => Promise<void>} [o.extract]
   */
  constructor({ currentVersion, installDir, isIdle, log, exit = (c) => process.exit(c), fetchImpl = fetch, extract = untar, config = {} }) {
    this.cfg = { ...DEFAULT_UPDATE_CONFIG, ...config };
    Object.assign(this, { currentVersion, installDir, isIdle, log, exit, fetchImpl, extract });
    this.timer = null;
    this.busy = false;
    this.lastResult = null;
  }

  start() {
    if (!this.cfg.enabled) return;
    const schedule = (ms) => {
      this.timer = setTimeout(async () => {
        const result = await this.checkNow().catch(() => null);
        schedule(result?.action === 'waiting' ? this.cfg.retryWhileBusyMs : this.cfg.checkEveryMs);
      }, ms);
      this.timer.unref?.();
    };
    schedule(this.cfg.firstCheckAfterMs);
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** One check. Returns what happened, for logs and tests. */
  async checkNow() {
    if (this.busy) return { action: 'busy' };
    this.busy = true;
    try {
      const release = await this.#latestRelease();
      if (!release) return (this.lastResult = { action: 'offline' });
      const version = release.tag_name;
      if (compareVersions(version, this.currentVersion) <= 0) return (this.lastResult = { action: 'current', version });
      if (await this.#rolledBack(version)) return (this.lastResult = { action: 'skipped-rolled-back', version });
      if (!this.isIdle()) {
        this.log(`update ${version} waiting: bridge in use`);
        return (this.lastResult = { action: 'waiting', version });
      }
      const bundle = release.assets?.find((a) => a.name === BUNDLE_ASSET);
      const sums = release.assets?.find((a) => a.name === SUMS_ASSET);
      if (!bundle || !sums) return (this.lastResult = { action: 'incomplete', version });

      this.log(`updating ${this.currentVersion} -> ${version}`);
      const [archive, sumsText] = await Promise.all([
        this.#download(bundle.browser_download_url, 'buffer'),
        this.#download(sums.browser_download_url, 'text'),
      ]);
      const expected = sumsText.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === BUNDLE_ASSET)?.[0];
      const actual = createHash('sha256').update(archive).digest('hex');
      if (!expected || expected.toLowerCase() !== actual) {
        this.log(`update ${version} rejected: checksum mismatch`);
        return (this.lastResult = { action: 'bad-checksum', version });
      }
      // Re-check: a phone may have joined during the download.
      if (!this.isIdle()) return (this.lastResult = { action: 'waiting', version });

      const staging = join(this.installDir, 'update-staging');
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const file = join(staging, BUNDLE_ASSET);
      await writeFile(file, archive);
      await this.extract(file, staging);
      const fresh = join(staging, 'DownbeatMixBridge', 'mix-bridge');
      await stat(join(fresh, 'src', 'index.js'));

      const live = join(this.installDir, 'mix-bridge');
      const previous = join(this.installDir, 'mix-bridge.previous');
      await rm(previous, { recursive: true, force: true });
      await rename(live, previous);
      await rename(fresh, live);
      await rm(staging, { recursive: true, force: true });
      await writeFile(join(this.installDir, 'update-state.json'), JSON.stringify({
        justUpdated: true, from: this.currentVersion, to: version, at: new Date().toISOString(),
      }));
      this.log(`installed ${version}; restarting`);
      this.lastResult = { action: 'installed', version };
      this.exit(RESTART_CODE);
      return this.lastResult;
    } catch (e) {
      this.log(`update check failed: ${e.message}`);
      return (this.lastResult = { action: 'error', error: e.message });
    } finally {
      this.busy = false;
    }
  }

  // A release the launcher had to roll back is not tried again; the next one is.
  async #rolledBack(version) {
    try {
      const state = JSON.parse(await readFile(join(this.installDir, 'update-state.json'), 'utf8'));
      return Boolean(state.rolledBackAt) && compareVersions(state.to, version) === 0;
    } catch {
      return false;
    }
  }

  async #latestRelease() {
    try {
      const res = await this.#fetch(`https://api.github.com/repos/${this.cfg.repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'downbeat-mix-bridge' },
      });
      if (res.status === 404) return null; // no releases yet
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      return await res.json();
    } catch {
      return null; // show network, no internet
    }
  }

  async #download(url, as) {
    const res = await this.#fetch(url, { headers: { 'user-agent': 'downbeat-mix-bridge' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`download ${res.status}`);
    return as === 'text' ? res.text() : Buffer.from(await res.arrayBuffer());
  }

  #fetch(url, options) {
    return this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
  }
}

/** Marks the running version as good once it has stayed up (launcher stops watching). */
export async function confirmUpdate(installDir) {
  const file = join(installDir, 'update-state.json');
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state.justUpdated) await writeFile(file, JSON.stringify({ ...state, justUpdated: false, confirmedAt: new Date().toISOString() }));
  } catch {
    /* nothing pending */
  }
}

function untar(file, dir) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', file, '-C', dir], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}
