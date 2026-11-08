#!/usr/bin/env node
// Keeps the mix bridge running on a rig Mac Mini (started by the LaunchAgent).
// Restarts it straight away after a self-update (exit 75). If a freshly updated version
// keeps crashing (3 exits within a minute of starting), puts the previous version back.
// Installed once by install.sh and never replaced by self-updates.
import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const RESTART_CODE = 75;
const FAST_EXIT_MS = 60 * 1000;
const log = (m) => console.log(`${new Date().toISOString()} launcher: ${m}`);
let fastExits = 0;
let stopping = false;

async function readState() {
  try { return JSON.parse(await readFile(join(dir, 'update-state.json'), 'utf8')); } catch { return {}; }
}

async function rollback(state) {
  try {
    await stat(join(dir, 'mix-bridge.previous'));
  } catch {
    log('no previous version to roll back to');
    return;
  }
  await rm(join(dir, 'mix-bridge.failed'), { recursive: true, force: true });
  await rename(join(dir, 'mix-bridge'), join(dir, 'mix-bridge.failed'));
  await rename(join(dir, 'mix-bridge.previous'), join(dir, 'mix-bridge'));
  await writeFile(join(dir, 'update-state.json'), JSON.stringify({ ...state, justUpdated: false, rolledBackAt: new Date().toISOString() }));
  log(`rolled back from ${state.to} to ${state.from}`);
}

function run() {
  const started = Date.now();
  const child = spawn(process.execPath, [join(dir, 'mix-bridge', 'src', 'index.js'), '--config', join(dir, 'config.json')], { stdio: 'inherit', cwd: dir });
  // launchd stopping us (bootout, logout): stop the bridge and do not start it again.
  const forward = (signal) => {
    stopping = true;
    child.kill(signal);
  };
  process.once('SIGTERM', forward);
  process.once('SIGINT', forward);
  child.on('exit', async (code, signal) => {
    process.off('SIGTERM', forward);
    process.off('SIGINT', forward);
    if (stopping || signal === 'SIGTERM' || signal === 'SIGINT') process.exit(0);
    if (code === RESTART_CODE) {
      log('restarting after update');
      fastExits = 0;
      return run();
    }
    fastExits = Date.now() - started < FAST_EXIT_MS ? fastExits + 1 : 0;
    log(`bridge exited (${code ?? signal}); fast exits ${fastExits}`);
    const state = await readState();
    if (state.justUpdated && fastExits >= 3) {
      await rollback(state);
      fastExits = 0;
    }
    setTimeout(run, Math.min(10000, 1000 * Math.max(1, fastExits)));
  });
}

run();
