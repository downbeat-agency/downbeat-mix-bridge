#!/usr/bin/env node
// Entry point: node src/index.js [--config path] [--driver fake|mixingstation] [--port n]
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Updater, confirmUpdate, lastUpdate } from './updater.js';
import { StatusReporter } from './statusReport.js';
import { attachWebSocket } from './wsServer.js';
import { Bridge } from './bridge.js';
import { FakeDliveDriver } from './drivers/fakeDlive.js';
import { MixingStationDriver } from './drivers/mixingStation.js';

const args = parseArgs(process.argv.slice(2));
const config = args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {};
const port = Number(args.port ?? config.port ?? 8790);
const driverName = args.driver ?? config.driver ?? 'mixingstation';
const rigName = config.rigName ?? 'Downbeat rig';
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(bridgeDir, 'package.json'), 'utf8'));
// Installed layout: ~/DownbeatMix/{mix-bridge, config.json, node}. Updates only run there.
const installDir = config.installDir ?? join(bridgeDir, '..');

const driver = driverName === 'fake' ? new FakeDliveDriver({ name: `${rigName} (fake dLive)` }) : new MixingStationDriver(config.mixingStation ?? {});
driver.on('error', (e) => log(`driver error: ${e.message}`));
driver.on('info', (e) => log(`driver: ${e.message}`));

const logDir = config.logDir ?? join(process.cwd(), 'logs');
await mkdir(logDir, { recursive: true });
const auditFile = join(logDir, 'mix-changes.jsonl');

const bridge = new Bridge(driver, {
  rigName,
  version,
  sharedToken: config.sharedToken ?? null,
  allowedBuses: config.allowedBuses ?? null,
  maxWritesPerSecond: config.maxWritesPerSecond ?? 400,
  meterIntervalMs: config.meterIntervalMs ?? 100,
  log,
  onAudit: (entry) => appendFile(auditFile, JSON.stringify(entry) + '\n').catch(() => {}),
});

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(bridge.health()));
  }
  res.writeHead(404).end();
});
attachWebSocket(server, '/v1/mix', (conn) => bridge.addConnection(conn));

bridge.start();
await driver.connect();
server.listen(port, '0.0.0.0', () => log(`mix bridge ${version} for ${rigName} on :${port} (driver: ${driverName})`));

// Self-update from GitHub when the rig has internet (warehouse), never while phones use it.
let updater = null;
if (args.config && config.update?.enabled !== false) {
  // Rig status on GitHub after every check (needs config.status.token; see statusReport.js).
  const reporter = new StatusReporter({ rigName, version, health: () => bridge.health(), log, config: config.status ?? {} });
  if (!reporter.enabled) log('rig status reporting off (no status token in config.json)');
  updater = new Updater({
    currentVersion: version,
    installDir,
    config: config.update ?? {},
    isIdle: () => bridge.isIdle(config.update?.idleMs ?? 10 * 60 * 1000),
    log,
    onChecked: async (result) => reporter.report(result, await lastUpdate(installDir)),
  });
  updater.start();
}
// A version that stays up for two minutes is good; the launcher stops watching it.
setTimeout(() => confirmUpdate(installDir), 2 * 60 * 1000).unref();

// Let phones find the bridge on the rig Wi-Fi without typing an IP (macOS has dns-sd built in).
let advert = null;
if (process.platform === 'darwin' && config.bonjour !== false) {
  advert = spawn('dns-sd', ['-R', `Downbeat Mix ${rigName}`, '_downbeatmix._tcp', 'local', String(port), `rig=${rigName}`], { stdio: 'ignore' });
  advert.on('error', () => log('bonjour advertisement unavailable'));
}

const shutdown = async () => {
  log('shutting down');
  advert?.kill();
  updater?.stop();
  bridge.stop();
  await driver.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') ? true : list[++i];
  }
  return out;
}
