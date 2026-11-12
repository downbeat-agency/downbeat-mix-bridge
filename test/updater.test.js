import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updater, compareVersions, RESTART_CODE, confirmUpdate } from '../src/updater.js';

test('versions compare numerically', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0', 'v0.2.0'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
});

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'mixrig-'));
  await mkdir(join(dir, 'mix-bridge', 'src'), { recursive: true });
  await writeFile(join(dir, 'mix-bridge', 'src', 'index.js'), '// old');
  return dir;
}

function github({ version = 'v0.2.0', archive = Buffer.from('bundle'), sums } = {}) {
  const hash = createHash('sha256').update(archive).digest('hex');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: version, assets: [
        { name: 'DownbeatMixBridge.tar.gz', browser_download_url: 'https://dl/bundle' },
        { name: 'SHA256SUMS', browser_download_url: 'https://dl/sums' },
      ] }) };
    }
    if (url === 'https://dl/bundle') return { ok: true, arrayBuffer: async () => archive };
    if (url === 'https://dl/sums') return { ok: true, text: async () => sums ?? `${hash}  DownbeatMixBridge.tar.gz\n` };
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}

// Stand-in for tar: lays out what a real bundle unpacks to.
const fakeExtract = async (_file, dir) => {
  await mkdir(join(dir, 'DownbeatMixBridge', 'mix-bridge', 'src'), { recursive: true });
  await writeFile(join(dir, 'DownbeatMixBridge', 'mix-bridge', 'src', 'index.js'), '// new');
};

test('installs a newer release when idle, keeps the old one, and restarts', async () => {
  const dir = await rig();
  const exits = [];
  const { fetchImpl } = github();
  const u = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: (c) => exits.push(c), fetchImpl, extract: fakeExtract });
  const result = await u.checkNow();
  assert.equal(result.action, 'installed');
  assert.deepEqual(exits, [RESTART_CODE]);
  assert.equal(await readFile(join(dir, 'mix-bridge', 'src', 'index.js'), 'utf8'), '// new');
  assert.equal(await readFile(join(dir, 'mix-bridge.previous', 'src', 'index.js'), 'utf8'), '// old');
  const state = JSON.parse(await readFile(join(dir, 'update-state.json'), 'utf8'));
  assert.deepEqual([state.justUpdated, state.from, state.to], [true, '0.1.0', 'v0.2.0']);
  await confirmUpdate(dir);
  assert.equal(JSON.parse(await readFile(join(dir, 'update-state.json'), 'utf8')).justUpdated, false);
});

test('never updates while phones are using the bridge', async () => {
  const dir = await rig();
  const { fetchImpl, calls } = github();
  const u = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => false, log: () => {}, exit: () => assert.fail('must not restart'), fetchImpl, extract: fakeExtract });
  assert.equal((await u.checkNow()).action, 'waiting');
  assert.equal(calls.length, 1, 'no download mid-show');
});

test('a bad checksum is refused and nothing changes', async () => {
  const dir = await rig();
  const { fetchImpl } = github({ sums: `${'0'.repeat(64)}  DownbeatMixBridge.tar.gz\n` });
  const u = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: () => assert.fail('must not restart'), fetchImpl, extract: fakeExtract });
  assert.equal((await u.checkNow()).action, 'bad-checksum');
  assert.equal(await readFile(join(dir, 'mix-bridge', 'src', 'index.js'), 'utf8'), '// old');
});

test('no internet (show network) or same version is a quiet no-op', async () => {
  const dir = await rig();
  const offline = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: () => assert.fail(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await offline.checkNow()).action, 'offline');
  const { fetchImpl } = github({ version: 'v0.1.0' });
  const current = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: () => assert.fail(), fetchImpl });
  assert.equal((await current.checkNow()).action, 'current');
});

test('a release that was rolled back is not installed again', async () => {
  const dir = await rig();
  await writeFile(join(dir, 'update-state.json'), JSON.stringify({ from: '0.1.0', to: 'v0.2.0', rolledBackAt: '2026-11-08T00:00:00Z' }));
  const { fetchImpl } = github({ version: 'v0.2.0' });
  const u = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: () => assert.fail(), fetchImpl, extract: fakeExtract });
  assert.equal((await u.checkNow()).action, 'skipped-rolled-back');
  const next = github({ version: 'v0.2.1' });
  const u2 = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {}, exit: () => {}, fetchImpl: next.fetchImpl, extract: fakeExtract });
  assert.equal((await u2.checkNow()).action, 'installed');
});

test('an update held back by connected phones is retried soon, not 12 hours later', async () => {
  const dir = await rig();
  const { fetchImpl, calls } = github();
  let idle = false;
  const exits = [];
  const u = new Updater({
    currentVersion: '0.1.0', installDir: dir, isIdle: () => idle, log: () => {}, exit: (c) => exits.push(c), fetchImpl, extract: fakeExtract,
    config: { firstCheckAfterMs: 5, retryWhileBusyMs: 30, checkEveryMs: 60 * 60 * 1000 },
  });
  u.start();
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(u.lastResult?.action, 'waiting');
    idle = true;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(u.lastResult?.action, 'installed');
    assert.deepEqual(exits, [RESTART_CODE]);
    assert.ok(calls.length >= 2);
  } finally {
    u.stop();
  }
});

test('an install is reported before the restart, and lastUpdate reads it back', async () => {
  const { lastUpdate } = await import('../src/updater.js');
  const dir = await rig();
  const events = [];
  const { fetchImpl } = github();
  const u = new Updater({ currentVersion: '0.1.0', installDir: dir, isIdle: () => true, log: () => {},
    exit: (c) => events.push(`exit ${c}`), fetchImpl, extract: fakeExtract,
    onChecked: (r) => { events.push(`report ${r.action} ${r.version}`); } });
  await u.checkNow();
  assert.deepEqual(events, ['report installed v0.2.0', `exit ${RESTART_CODE}`], 'reported first, then restarted');
  const last = await lastUpdate(dir);
  assert.deepEqual([last.from, last.to], ['0.1.0', 'v0.2.0']);
  assert.equal(await lastUpdate(join(dir, 'nowhere')), null);
});
