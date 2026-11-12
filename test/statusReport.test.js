import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusReporter, rigSlug, updateStatus } from '../src/statusReport.js';

const health = () => ({ console: { connected: true, name: 'dLive Green', model: 'dlive' }, phones: [{ personId: 'p1' }, { personId: 'p2' }] });

function github({ existing = null, putStatus = 201, getStatus } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? 'GET') === 'GET') {
      const status = getStatus ?? (existing ? 200 : 404);
      return { status, ok: status === 200, json: async () => ({ sha: existing }) };
    }
    return { status: putStatus, ok: putStatus < 300, json: async () => ({}) };
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

test('without a token the rig does not report and makes no request', async () => {
  const { fetchImpl, calls } = github();
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.2', health, fetchImpl });
  assert.equal(r.enabled, false);
  assert.deepEqual(await r.report({ action: 'current', version: 'v0.5.2' }), { action: 'disabled' });
  assert.equal(calls.length, 0);
});

test('writes rigs/<rig>.json with version, update result, console and phones', async () => {
  const { fetchImpl, calls } = github({ existing: 'abc123' });
  const now = Date.parse('2026-11-12T17:00:00Z');
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.2', health, fetchImpl, now: () => now,
    startedAt: now - 3600_000, config: { token: 'secret-token' } });
  const out = await r.report({ action: 'current', version: 'v0.5.2' }, { from: '0.5.1', to: 'v0.5.2', at: '2026-11-12T09:00:00Z' });
  assert.deepEqual(out, { action: 'reported', path: 'rigs/dlive-green.json' });
  const [get, put] = calls;
  assert.equal(get.url, 'https://api.github.com/repos/downbeat-agency/downbeat-rig-status/contents/rigs/dlive-green.json');
  assert.equal(get.headers.authorization, 'Bearer secret-token');
  assert.equal(put.method, 'PUT');
  assert.equal(put.body.sha, 'abc123', 'updates the existing file');
  assert.match(put.body.message, /dLive Green: 0\.5\.2 \(up_to_date\)/);
  const file = JSON.parse(Buffer.from(put.body.content, 'base64').toString());
  assert.equal(file.rig, 'dLive Green');
  assert.equal(file.version, '0.5.2');
  assert.equal(file.latestRelease, 'v0.5.2');
  assert.equal(file.update.status, 'up_to_date');
  assert.deepEqual(file.lastUpdate, { from: '0.5.1', to: 'v0.5.2', at: '2026-11-12T09:00:00Z' });
  assert.deepEqual(file.console, { connected: true, name: 'dLive Green', model: 'dlive' });
  assert.equal(file.phones, 2);
  assert.equal(file.uptimeSeconds, 3600);
  assert.equal(file.reportedAt, '2026-11-12T17:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(file), /secret-token/, 'the token is never written');
});

test('the first report creates the file; GitHub errors and no internet fail quietly', async () => {
  const first = github();
  const r = new StatusReporter({ rigName: 'Wing Blue', version: '0.5.2', health, fetchImpl: first.fetchImpl, config: { token: 't' } });
  assert.equal((await r.report({ action: 'current', version: 'v0.5.2' })).action, 'reported');
  assert.equal(first.calls[1].body.sha, undefined, 'no sha for a new file');

  const logs = [];
  const denied = github({ putStatus: 403 });
  const r2 = new StatusReporter({ rigName: 'Wing Blue', version: '0.5.2', health, fetchImpl: denied.fetchImpl, log: (m) => logs.push(m), config: { token: 't' } });
  assert.deepEqual(await r2.report({ action: 'current' }), { action: 'failed', error: 'GitHub 403' });
  const offline = new StatusReporter({ rigName: 'Wing Blue', version: '0.5.2', health, config: { token: 't' },
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }, log: (m) => logs.push(m) });
  assert.equal((await offline.report({ action: 'offline' })).action, 'failed');
  assert.equal(logs.length, 2);
});

test('a failed update check is reported with its message', async () => {
  const { fetchImpl, calls } = github();
  const r = new StatusReporter({ rigName: 'dLive Green', version: '0.5.1', health, fetchImpl, config: { token: 't' } });
  await r.report({ action: 'error', error: 'GitHub 503' });
  const file = JSON.parse(Buffer.from(calls[1].body.content, 'base64').toString());
  assert.deepEqual([file.update.status, file.update.message, file.latestRelease], ['check_failed', 'GitHub 503', null]);
});
