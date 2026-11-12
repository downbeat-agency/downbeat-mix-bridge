import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusReporter, rigSlug, updateStatus } from '../src/statusReport.js';

const health = () => ({ console: { connected: true, name: 'dLive Green', model: 'dlive' }, phones: [{ personId: 'p1' }, { personId: 'p2' }] });

function service({ status = 200, fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (fail) throw new Error(fail);
    return { status, ok: status < 300, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('rig names become file names', () => {
  assert.equal(rigSlug('dLive Green'), 'dlive-green');
  assert.equal(rigSlug('  Wing #2 / Blue  '), 'wing-2-blue');
  assert.equal(rigSlug(''), 'rig');
});

test('updater results map to the statuses on the rig table', () => {
  assert.equal(updateStatus({ action: 'current' }), 'up_to_date');
  assert.equal(updateStatus({ action: 'installed' }), 'updated');
  assert.equal(updateStatus({ action: 'waiting' }), 'waiting_for_phones');
  assert.equal(updateStatus({ action: 'skipped-rolled-back' }), 'rolled_back');
  assert.equal(updateStatus({ action: 'bad-checksum' }), 'failed');
  assert.equal(updateStatus({ action: 'error' }), 'check_failed');
  assert.equal(updateStatus(null), null);
});

test('turned off with status.url null: no request', async () => {
  const { fetchImpl, calls } = service();
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.2', health, fetchImpl, config: { url: null } });
  assert.equal(r.enabled, false);
  assert.deepEqual(await r.report({ action: 'current', version: 'v0.5.2' }), { action: 'disabled' });
  assert.equal(calls.length, 0);
});

test('on by default: posts the check-in with version, update result, console and phones, no secret', async () => {
  const { fetchImpl, calls } = service();
  const now = Date.parse('2026-11-12T17:00:00Z');
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.2', health, fetchImpl, now: () => now, startedAt: now - 3600_000 });
  assert.equal(r.enabled, true);
  const out = await r.report({ action: 'current', version: 'v0.5.2' }, { from: '0.5.1', to: 'v0.5.2', at: '2026-11-12T09:00:00Z' });
  assert.deepEqual(out, { action: 'reported', path: 'rigs/dlive-green.json' });
  assert.equal(calls.length, 1);
  const [post] = calls;
  assert.equal(post.url, 'https://checkin-production-441c6f38.up.railway.app/checkin');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.authorization, undefined, 'no secret is sent');
  const b = post.body;
  assert.equal(b.rig, 'dLive Green');
  assert.equal(b.version, '0.5.2');
  assert.equal(b.latestRelease, 'v0.5.2');
  assert.equal(b.update.status, 'up_to_date');
  assert.deepEqual(b.lastUpdate, { from: '0.5.1', to: 'v0.5.2', at: '2026-11-12T09:00:00Z' });
  assert.deepEqual(b.console, { connected: true, name: 'dLive Green', model: 'dlive' });
  assert.equal(b.phones, 2);
  assert.equal(b.uptimeSeconds, 3600);
});

test('service errors and no internet fail quietly', async () => {
  const logs = [];
  const busy = service({ status: 429 });
  const r = new StatusReporter({ rigName: 'Wing Blue', version: '0.5.2', health, fetchImpl: busy.fetchImpl, log: (m) => logs.push(m) });
  assert.deepEqual(await r.report({ action: 'current' }), { action: 'failed', error: 'check-in 429' });
  const offline = service({ fail: 'getaddrinfo ENOTFOUND' });
  const r2 = new StatusReporter({ rigName: 'Wing Blue', version: '0.5.2', health, fetchImpl: offline.fetchImpl, log: (m) => logs.push(m) });
  assert.equal((await r2.report({ action: 'offline' })).action, 'failed');
  assert.equal(logs.length, 2);
});

test('a failed update check is reported with its message', async () => {
  const { fetchImpl, calls } = service();
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.1', health, fetchImpl });
  await r.report({ action: 'error', error: 'GitHub 503' });
  const b = calls[0].body;
  assert.deepEqual([b.update.status, b.update.message, b.latestRelease], ['check_failed', 'GitHub 503', null]);
});
