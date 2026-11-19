'use strict';
// Encrypted TCP transfers between Office Share laptops.
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { FrameReader, SecureChannel, frame } = require('./framing');
const { FrameCipher, hkdf } = require('./crypto');

const MAGIC = Buffer.from('OSH1');
const CHUNK = 512 * 1024;
const MAX_ITEMS = 20000;

class TransferError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- channel helpers ---------- */

function attachQueue(channel, socket) {
  const queue = [];
  const waiters = [];
  let failure = null;
  const fail = (err) => {
    if (failure) return;
    failure = err;
    while (waiters.length) waiters.shift().reject(err);
  };
  channel.on('json', (m) => {
    if (waiters.length) waiters.shift().resolve(m); else queue.push(m);
  });
  channel.on('error', (e) => { fail(e); socket.destroy(); });
  socket.on('error', (e) => fail(new TransferError('NETWORK', e.message)));
  socket.on('close', () => fail(new TransferError('CLOSED', 'Connection closed')));
  channel.waitJson = (ms = 30000) => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new TransferError('TIMEOUT', 'No response from the other laptop'));
        socket.destroy();
      }, ms);
      waiters.push(w);
    });
  };
}

/** Connect to a peer and complete the encrypted handshake. */
function openChannel({ address, port, teamKey, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    socket.setNoDelay(true);
    const reader = new FrameReader();
    let channel = null;
    const timer = setTimeout(() => { socket.destroy(); reject(new TransferError('TIMEOUT', 'Could not reach the other laptop')); }, timeout);
    socket.on('error', (e) => { if (!channel) { clearTimeout(timer); reject(new TransferError('NETWORK', e.message)); } });
    socket.on('data', (d) => reader.push(d));
    reader.on('error', (e) => socket.destroy(e));
    reader.on('frame', (f) => {
      if (channel) return channel.handleFrame(f);
      clearTimeout(timer);
      if (f.length !== 36 || !f.subarray(0, 4).equals(MAGIC)) {
        socket.destroy();
        return reject(new TransferError('PROTOCOL', 'Not an Office Share device'));
      }
      const key = hkdf(teamKey, 'session', f.subarray(4));
      channel = new SecureChannel(socket, new FrameCipher(key, true));
      attachQueue(channel, socket);
      resolve({ channel, socket });
    });
  });
}

/** Start the TCP server. `onSession(channel, socket)` is called for each authenticated-ready connection. */
function startServer({ port, getKey, onSession }) {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const challenge = crypto.randomBytes(32);
    const channel = new SecureChannel(socket, new FrameCipher(hkdf(getKey(), 'session', challenge), false));
    attachQueue(channel, socket);
    const reader = new FrameReader();
    reader.on('frame', (f) => channel.handleFrame(f));
    reader.on('error', () => socket.destroy());
    socket.on('data', (d) => reader.push(d));
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
    socket.write(frame(Buffer.concat([MAGIC, challenge])));
    onSession(channel, socket);
  });
  return new Promise((resolve, reject) => {
    const tryListen = (p, fallback) => {
      server.once('error', (e) => {
        if (fallback && e.code === 'EADDRINUSE') tryListen(0, false);
        else reject(e);
      });
      server.listen(p, '0.0.0.0', () => resolve(server));
    };
    tryListen(port, true);
  });
}

/* ---------- file helpers ---------- */

/** Expand a list of files/folders into transferable items with relative paths. */
async function collectItems(paths) {
  const items = [];
  const walk = async (abs, rel) => {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === '.DS_Store' || e.name === 'Thumbs.db' || e.name === 'desktop.ini') continue;
        await walk(path.join(abs, e.name), rel + '/' + e.name);
        if (items.length > MAX_ITEMS) throw new TransferError('TOO_MANY', 'Too many files in one transfer');
      }
    } else if (st.isFile()) {
      items.push({ abs, relPath: rel, size: st.size });
    }
  };
  for (const p of paths) await walk(p, path.basename(p));
  return items;
}

const BAD = /[<>:"\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Make a remote relative path safe to write on this machine. Returns null if unsafe. */
function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return null;
  const parts = rel.split('/');
  const out = [];
  for (let seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
    seg = seg.replace(BAD, '_').replace(/[. ]+$/, '_');
    if (RESERVED.test(seg)) seg = '_' + seg;
    out.push(seg.slice(0, 200));
  }
  return out;
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const n = `${base} (${i})${ext && ext !== name ? ext : ''}`;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
  return `${base} ${Date.now()}${ext}`;
}

/* ---------- sending ---------- */

/**
 * Send files to a peer.
 * @returns {Promise<void>}
 */
async function sendFiles({ peer, teamKey, from, transferId, items, onAccepted, onProgress, control }) {
  const { channel, socket } = await openChannel({ address: peer.address, port: peer.port, teamKey });
  control.cancel = () => socket.destroy();
  const totalSize = items.reduce((a, i) => a + i.size, 0);
  try {
    channel.sendJson({ type: 'offer', from, transferId, totalSize, items: items.map((i) => ({ relPath: i.relPath, size: i.size })) });
    const resp = await channel.waitJson(130000);
    if (resp.type === 'reject') throw new TransferError('REJECTED', resp.reason || 'Declined');
    if (resp.type !== 'accept') throw new TransferError('PROTOCOL', 'Unexpected reply');
    onAccepted && onAccepted();

    let sent = 0;
    const drain = () => new Promise((r) => socket.once('drain', r));
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      channel.sendJson({ type: 'file', index: idx });
      let left = it.size;
      if (left > 0) {
        const rs = fs.createReadStream(it.abs, { highWaterMark: CHUNK, start: 0, end: it.size - 1 });
        for await (const chunk of rs) {
          if (socket.destroyed) throw new TransferError('CANCELLED', 'Cancelled');
          left -= chunk.length;
          sent += chunk.length;
          if (!channel.sendData(chunk)) await drain();
          onProgress && onProgress(sent, totalSize);
        }
      }
      if (left !== 0) throw new TransferError('CHANGED', `${path.basename(it.abs)} changed while sending`);
    }
    const done = await channel.waitJson(120000);
    if (done.type !== 'done') throw new TransferError('PROTOCOL', done.reason || 'Receiver failed');
    socket.end();
  } catch (e) {
    socket.destroy();
    if (control.cancelled) throw new TransferError('CANCELLED', 'Cancelled');
    throw e;
  }
}

/** Send a one-shot message (text / buzz). */
async function sendSimple({ peer, teamKey, payload }) {
  const { channel, socket } = await openChannel({ address: peer.address, port: peer.port, teamKey });
  try {
    channel.sendJson(payload);
    const r = await channel.waitJson(10000);
    if (r.type !== 'ok') throw new TransferError('REJECTED', r.reason || 'Not delivered');
  } finally {
    socket.end();
  }
}

/* ---------- receiving ---------- */

/**
 * Receive an accepted offer into `dir`. Resolves with saved top-level paths.
 */
function receiveFiles({ channel, socket, offer, dir, onProgress, control }) {
  return new Promise((resolve, reject) => {
    const items = offer.items;
    const tops = new Map(); // remote top-level name -> local unique name
    const saved = [];
    let received = 0;
    let completed = 0;
    let cur = null; // {index, left, ws, tmp, final}
    let finished = false;
    const queue = [];
    let busy = false;

    const cleanup = () => {
      if (cur && cur.ws) { cur.ws.destroy(); fs.rm(cur.tmp, { force: true }, () => {}); }
    };
    const fail = (e) => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.destroy();
      reject(e);
    };
    control.cancel = () => { control.cancelled = true; fail(new TransferError('CANCELLED', 'Cancelled')); };

    const openFile = async (index) => {
      const parts = safeRelPath(items[index].relPath);
      if (!parts) throw new TransferError('PROTOCOL', 'Unsafe file name');
      if (!tops.has(parts[0])) {
        const local = uniqueName(dir, parts[0]);
        tops.set(parts[0], local);
        saved.push(path.join(dir, local));
      }
      parts[0] = tops.get(parts[0]);
      const final = path.join(dir, ...parts);
      if (!final.startsWith(path.resolve(dir) + path.sep)) throw new TransferError('PROTOCOL', 'Unsafe path');
      await fsp.mkdir(path.dirname(final), { recursive: true });
      const tmp = final + '.osdownload';
      const ws = fs.createWriteStream(tmp);
      ws.on('error', (e) => fail(new TransferError('DISK', e.message)));
      cur ={ index, left: items[index].size, ws, tmp, final };
      if (cur.left === 0) await closeFile();
    };
    const closeFile = async () => {
      const c = cur;
      cur = null;
      await new Promise((r, j) => c.ws.end((e) => (e ? j(e) : r())));
      await fsp.rename(c.tmp, c.final);
      if (++completed === items.length) {
        finished = true;
        channel.sendJson({ type: 'done' });
        socket.end();
        resolve(saved);
      }
    };
    const step = async (job) => {
      if (job.kind === 'json') {
        const m = job.msg;
        if (m.type !== 'file' || !Number.isInteger(m.index) || m.index < 0 || m.index >= items.length || cur) {
          throw new TransferError('PROTOCOL', 'Out-of-order file');
        }
        await openFile(m.index);
      } else {
        if (!cur || job.data.length > cur.left) throw new TransferError('PROTOCOL', 'Unexpected data');
        cur.left -= job.data.length;
        received += job.data.length;
        await new Promise((r, j) => cur.ws.write(job.data, (e) => (e ? j(e) : r())));
        onProgress && onProgress(received, offer.totalSize);
        if (cur.left === 0) await closeFile();
      }
    };
    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && !finished) {
          await step(queue.shift());
          if (queue.length < 2 && socket.isPaused()) socket.resume();
        }
      } catch (e) {
        fail(e);
      }
      busy = false;
    };
    const enqueue = (job) => {
      if (finished) return;
      queue.push(job);
      if (queue.length > 8) socket.pause();
      pump();
    };
    channel.removeAllListeners('json');
    channel.on('json', (msg) => enqueue({ kind: 'json', msg }));
    channel.on('data', (data) => enqueue({ kind: 'data', data }));
    socket.on('close', () => { if (!finished) fail(new TransferError(control.cancelled ? 'CANCELLED' : 'CLOSED', control.cancelled ? 'Cancelled' : 'Sender disconnected')); });
    channel.sendJson({ type: 'accept' });
    if (items.length === 0) { finished = true; channel.sendJson({ type: 'done' }); socket.end(); resolve(saved); }
  });
}

/** Validate an incoming offer; returns a clean copy or null. */
function validateOffer(m) {
  if (!m || m.type !== 'offer' || !Array.isArray(m.items) || m.items.length > MAX_ITEMS) return null;
  let total = 0;
  const items = [];
  for (const it of m.items) {
    if (!it || typeof it.relPath !== 'string' || !Number.isSafeInteger(it.size) || it.size < 0) return null;
    if (!safeRelPath(it.relPath)) return null;
    total += it.size;
    items.push({ relPath: it.relPath, size: it.size });
  }
  return {
    transferId: String(m.transferId || crypto.randomUUID()).slice(0, 64),
    from: m.from && typeof m.from === 'object' ? { id: String(m.from.id || ''), name: String(m.from.name || '').slice(0, 64) } : { id: '', name: '' },
    items,
    totalSize: total,
  };
}

module.exports = {
  openChannel, startServer, collectItems, sendFiles, sendSimple, receiveFiles,
  validateOffer, safeRelPath, uniqueName, TransferError,
};
