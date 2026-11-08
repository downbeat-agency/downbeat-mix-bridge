import { createServer } from 'node:http';
import { attachWebSocket } from '../src/wsServer.js';
import { Bridge } from '../src/bridge.js';
import { FakeDliveDriver } from '../src/drivers/fakeDlive.js';

export async function startBridge({ driverOptions = {}, bridgeOptions = {} } = {}) {
  const driver = new FakeDliveDriver({ writeLatencyMs: 1, ...driverOptions });
  const bridge = new Bridge(driver, { flushIntervalMs: 10, meterIntervalMs: 30, ...bridgeOptions });
  const server = createServer();
  attachWebSocket(server, '/v1/mix', (c) => bridge.addConnection(c));
  bridge.start();
  await driver.connect();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/v1/mix`;
  const clients = [];
  return {
    url,
    bridge,
    driver,
    async client(hello) {
      const c = await connectClient(url);
      clients.push(c);
      if (hello) {
        c.send({ type: 'hello', ...hello });
        await c.next('welcome');
        if (Number.isInteger(hello.bus)) c.snapshot = await c.next('snapshot');
      }
      return c;
    },
    async close() {
      for (const c of clients) c.close();
      bridge.stop();
      await driver.close();
      await new Promise((r) => server.close(r));
    },
  };
}

export function connectClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    const c = {
      ws,
      queue,
      closed: false,
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
      /** Resolve with the next message of `type` (consuming earlier non-matching ones of that type only). */
      next(type, timeoutMs = 2000) {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { type, res };
          waiters.push(w);
          setTimeout(() => {
            const k = waiters.indexOf(w);
            if (k >= 0) {
              waiters.splice(k, 1);
              rej(new Error(`timed out waiting for ${type}`));
            }
          }, timeoutMs);
        });
      },
      drain: (type) => {
        const out = queue.filter((m) => m.type === type);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === type) queue.splice(i, 1);
        return out;
      },
    };
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const k = waiters.findIndex((w) => w.type === m.type);
      if (k >= 0) waiters.splice(k, 1)[0].res(m);
      else queue.push(m);
    });
    ws.addEventListener('open', () => resolve(c));
    ws.addEventListener('close', () => (c.closed = true));
    ws.addEventListener('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
