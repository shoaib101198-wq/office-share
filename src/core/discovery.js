'use strict';
// Zero-config LAN discovery: every laptop broadcasts a signed "I'm here" packet
// every few seconds. Only laptops with the same office key can verify it.
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { hmac, safeEqual } = require('./crypto');

const APP = 'office-share';
const ANNOUNCE_MS = 3000;
const EXPIRE_MS = 11000;
const MAX_SKEW_MS = 5 * 60 * 1000;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

class Discovery extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.port UDP port shared by all laptops
   * @param {() => object} o.getSelf returns {id,name,user,os,port,status,tid}
   * @param {() => Buffer} o.getKey returns the team HMAC key
   * @param {Array<{address:string,port:number}>} [o.extraTargets] extra unicast targets (tests / VPN)
   */
  constructor({ port, getSelf, getKey, extraTargets = [] }) {
    super();
    this.port = port;
    this.getSelf = getSelf;
    this.getKey = getKey;
    this.extraTargets = extraTargets;
    this.peers = new Map();
    this.foreign = new Map(); // devices running Office Share with a different office key
    this.sock = null;
    this.timers = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = s;
      s.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
      s.on('error', (err) => {
        if (!this._bound) reject(err); else this.emit('warn', err);
      });
      s.bind(this.port, () => {
        this._bound = true;
        try { s.setBroadcast(true); } catch {}
        this.announce('hello');
        this.timers.push(setInterval(() => this.announce('announce'), ANNOUNCE_MS));
        this.timers.push(setInterval(() => this._prune(), 2000));
        resolve();
      });
    });
  }

  stop() {
    try { this.announce('bye'); } catch {}
    this.timers.forEach(clearInterval);
    this.timers = [];
    return new Promise((r) => setTimeout(() => { try { this.sock && this.sock.close(); } catch {} r(); }, 50));
  }

  _packet(kind) {
    const self = this.getSelf();
    const body = JSON.stringify({ app: APP, v: 1, kind, ts: Date.now(), ...self });
    return Buffer.from(JSON.stringify({ p: body, s: hmac(this.getKey(), body), t: self.tid }));
  }

  announce(kind = 'announce', target) {
    if (!this.sock || !this._bound) return;
    const pkt = this._packet(kind);
    const send = (addr, port) => this.sock.send(pkt, port, addr, () => {});
    if (target) return send(target.address, target.port || this.port);
    for (const a of broadcastAddresses()) send(a, this.port);
    for (const t of this.extraTargets) send(t.address, t.port);
  }

  _onMessage(buf, rinfo) {
    let outer;
    try { outer = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!outer || typeof outer.p !== 'string' || typeof outer.s !== 'string') return;
    let body;
    try { body = JSON.parse(outer.p); } catch { return; }
    if (body.app !== APP || !body.id) return;
    const self = this.getSelf();
    if (body.id === self.id) return;

    if (!safeEqual(outer.s, hmac(this.getKey(), outer.p))) {
      // Running Office Share but with another office key — count it for troubleshooting.
      if (outer.t !== self.tid) {
        this.foreign.set(body.id, { name: String(body.name || '').slice(0, 64), address: rinfo.address, lastSeen: Date.now() });
      }
      return;
    }
    if (Math.abs(Date.now() - Number(body.ts)) > MAX_SKEW_MS) return;

    if (body.kind === 'bye') {
      if (this.peers.delete(body.id)) this.emit('change');
      return;
    }

    const prev = this.peers.get(body.id);
    const peer = {
      id: String(body.id),
      name: String(body.name || 'Unknown').slice(0, 64),
      user: String(body.user || '').slice(0, 64),
      os: String(body.os || ''),
      status: ['available', 'busy', 'away'].includes(body.status) ? body.status : 'available',
      address: rinfo.address,
      port: Number(body.port) || 0,
      lastSeen: Date.now(),
      since: prev ? prev.since : Date.now(),
    };
    const changed = !prev || ['name', 'status', 'address', 'port', 'user'].some((k) => prev[k] !== peer[k]);
    this.peers.set(peer.id, peer);
    if (!prev) this.emit('found', peer);
    if (changed) this.emit('change');
    // A laptop just came online: answer straight away so it sees us instantly.
    if (body.kind === 'hello') this.announce('announce', { address: rinfo.address, port: rinfo.port });
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > EXPIRE_MS) { this.peers.delete(id); this.emit('lost', p); changed = true; }
    }
    for (const [id, p] of this.foreign) if (now - p.lastSeen > EXPIRE_MS) { this.foreign.delete(id); changed = true; }
    if (changed) this.emit('change');
  }

  list() {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = { Discovery, localAddresses, broadcastAddresses };
