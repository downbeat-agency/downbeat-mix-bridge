// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close).
// Zero dependencies so the rig Mac Mini needs nothing beyond Node.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024; // phones only send small JSON commands

export class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.remoteAddress = socket.remoteAddress;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  send(text) {
    if (!this.open) return false;
    const payload = Buffer.from(text, 'utf8');
    this.socket.write(Buffer.concat([frameHeader(0x1, payload.length), payload]));
    return true;
  }

  ping() {
    if (this.open) this.socket.write(frameHeader(0x9, 0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.socket.write(Buffer.concat([frameHeader(0x8, body.length), body]));
    this.socket.end();
    this.#finish();
  }

  #finish() {
    if (!this.open) return;
    this.open = false;
    this.socket.destroy();
    this.emit('close');
  }

  #onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009, 'too big');
        len = Number(big);
        off = 10;
      }
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len > MAX_FRAME) return this.close(1009, 'too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        if (this.open) this.socket.write(Buffer.concat([frameHeader(0xa, payload.length), payload]));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', text);
        }
        continue;
      }
      if (opcode === 0x2) continue; // binary not used
      return this.close(1002, 'bad opcode');
    }
  }
}

function frameHeader(opcode, len) {
  if (len < 126) return Buffer.from([0x80 | opcode, len]);
  if (len < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(len, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

/** Attach WebSocket upgrade handling to an http.Server. */
export function attachWebSocket(httpServer, path, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://bridge');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    onConnection(new WsConnection(socket, req));
  });
}
