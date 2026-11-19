'use strict';
// Length-prefixed frames over TCP, encrypted after the handshake.
const { EventEmitter } = require('events');

const MAX_FRAME = 2 * 1024 * 1024;
const T_JSON = 1;
const T_DATA = 2;

class FrameReader extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.len = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.len += chunk.length;
    while (this.len >= 4) {
      let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [buf];
      const n = buf.readUInt32BE(0);
      if (n > MAX_FRAME) {
        this.emit('error', new Error('Frame too large'));
        return;
      }
      if (buf.length < 4 + n) break;
      const frame = buf.subarray(4, 4 + n);
      const rest = buf.subarray(4 + n);
      this.chunks = rest.length ? [rest] : [];
      this.len = rest.length;
      this.emit('frame', frame);
    }
  }
}

function frame(buf) {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(buf.length, 0);
  return Buffer.concat([h, buf]);
}

/** Wraps a socket with encrypted JSON/data framing. */
class SecureChannel extends EventEmitter {
  constructor(socket, cipher) {
    super();
    this.socket = socket;
    this.cipher = cipher;
  }
  /** Feed raw frames (already de-framed) after handshake. */
  handleFrame(raw) {
    let plain;
    try {
      plain = this.cipher.open(raw);
    } catch (e) {
      this.emit('error', new Error('Decryption failed — office keys do not match'));
      return;
    }
    const type = plain[0];
    const body = plain.subarray(1);
    if (type === T_JSON) {
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { this.emit('error', new Error('Bad message')); return; }
      this.emit('json', msg);
    } else if (type === T_DATA) {
      this.emit('data', body);
    }
  }
  sendJson(obj) {
    const p = Buffer.concat([Buffer.from([T_JSON]), Buffer.from(JSON.stringify(obj), 'utf8')]);
    return this.socket.write(frame(this.cipher.seal(p)));
  }
  sendData(buf) {
    const p = Buffer.concat([Buffer.from([T_DATA]), buf]);
    return this.socket.write(frame(this.cipher.seal(p)));
  }
}

module.exports = { FrameReader, SecureChannel, frame, MAX_FRAME };
