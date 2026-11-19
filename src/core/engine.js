'use strict';
// Office Share engine: ties discovery, transfers, settings and history together.
// Pure Node (no Electron), so it can be tested headless.
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Discovery } = require('./discovery');
const T = require('./transfer');
const { deriveTeamKey, teamId, hkdf } = require('./crypto');
const { JsonStore } = require('./store');

const HISTORY_LIMIT = 1000;
const MAX_TEXT = 20000;

function osLabel(p = process.platform) {
  return p === 'win32' ? 'windows' : p === 'darwin' ? 'mac' : 'linux';
}

class Engine extends EventEmitter {
  constructor({ dataDir, defaultReceiveDir, extraTargets = [], overrides = {} }) {
    super();
    this.dataDir = dataDir;
    this.settings = new JsonStore(path.join(dataDir, 'settings.json'), {
      deviceId: crypto.randomUUID(),
      deviceName: os.hostname().replace(/\.local$/, ''),
      userName: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
      teamKey: null,
      receiveDir: defaultReceiveDir,
      acceptMode: 'auto', // 'auto' | 'ask'
      folderPerSender: false,
      status: 'available',
      startAtLogin: true,
      notifications: true,
      sounds: true,
      tcpPort: 48556,
      discoveryPort: 48555,
      favorites: [],
      ...overrides,
    });
    // Make sure the generated id is persisted on first run.
    this.settings.save();
    this.history = new JsonStore(path.join(dataDir, 'history.json'), { items: [] });
    this.extraTargets = extraTargets;
    this.active = new Map(); // transferId -> record
    this.controls = new Map(); // transferId -> {cancel, cancelled}
    this.pendingAsks = new Map(); // transferId -> resolve(bool)
    this.discovery = null;
    this.server = null;
    this.port = 0;
  }

  /* ---------- lifecycle ---------- */

  isConfigured() { return !!this.settings.get('teamKey'); }

  _key() { return Buffer.from(this.settings.get('teamKey'), 'hex'); }
  _discKey() { return hkdf(this._key(), 'discovery'); }

  self() {
    const s = this.settings.data;
    return {
      id: s.deviceId,
      name: s.deviceName,
      user: s.userName,
      os: osLabel(),
      port: this.port,
      status: s.status,
      tid: this.isConfigured() ? teamId(this._key()) : '',
    };
  }

  async start() {
    if (!this.isConfigured() || this.server) return;
    this.server = await T.startServer({
      port: this.settings.get('tcpPort'),
      getKey: () => this._key(),
      onSession: (ch, sock) => this._onSession(ch, sock).catch(() => sock.destroy()),
    });
    this.port = this.server.address().port;
    this.discovery = new Discovery({
      port: this.settings.get('discoveryPort'),
      getSelf: () => this.self(),
      getKey: () => this._discKey(),
      extraTargets: this.extraTargets,
    });
    let t = null;
    this.discovery.on('change', () => { clearTimeout(t); t = setTimeout(() => this.emit('peers', this.peers()), 60); });
    this.discovery.on('found', (p) => this.emit('peer-online', p));
    this.discovery.on('warn', (e) => this.emit('warn', e));
    await this.discovery.start();
    this.emit('peers', this.peers());
  }

  async stop() {
    for (const c of this.controls.values()) { c.cancelled = true; c.cancel && c.cancel(); }
    if (this.discovery) await this.discovery.stop();
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    this.discovery = null;
    this.server = null;
    this.settings.flush();
    this.history.flush();
  }

  async restart() { await this.stop(); await this.start(); }

  async setup({ passphrase, deviceName }) {
    const key = deriveTeamKey(passphrase);
    const patch = { teamKey: key.toString('hex') };
    if (deviceName && deviceName.trim()) patch.deviceName = deviceName.trim().slice(0, 40);
    this.settings.set(patch);
    this.settings.flush();
    await this.restart();
  }

  async updateSettings(patch) {
    const allowed = ['deviceName', 'receiveDir', 'acceptMode', 'folderPerSender', 'status', 'startAtLogin', 'notifications', 'sounds', 'favorites'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if (clean.deviceName !== undefined) clean.deviceName = String(clean.deviceName).trim().slice(0, 40) || os.hostname();
    if (clean.status && !['available', 'busy', 'away'].includes(clean.status)) delete clean.status;
    this.settings.set(clean);
    // Tell everyone right away about name/status changes.
    if (this.discovery && (clean.deviceName || clean.status)) this.discovery.announce('announce');
    return this.publicSettings();
  }

  publicSettings() {
    const { teamKey, ...rest } = this.settings.data;
    return { ...rest, configured: !!teamKey, teamFingerprint: teamKey ? teamId(this._key()).slice(0, 6).toUpperCase() : '' };
  }

  peers() { return this.discovery ? this.discovery.list() : []; }
  foreignCount() { return this.discovery ? this.discovery.foreign.size : 0; }

  state() {
    return {
      self: this.self(),
      settings: this.publicSettings(),
      peers: this.peers(),
      foreignCount: this.foreignCount(),
      active: [...this.active.values()],
      history: this.history.get('items').slice(0, 300),
    };
  }

  /* ---------- history ---------- */

  _record(entry) {
    const items = this.history.get('items');
    const i = items.findIndex((x) => x.id === entry.id);
    if (i >= 0) items[i] = entry; else items.unshift(entry);
    if (items.length > HISTORY_LIMIT) items.length = HISTORY_LIMIT;
    this.history.save();
  }

  clearHistory() { this.history.set({ items: [] }); }

  _emitTransfer(rec, force = false) {
    const now = Date.now();
    if (!force && rec._lastEmit && now - rec._lastEmit < 200) return;
    if (rec._lastBytes !== undefined) {
      const dt = (now - rec._lastAt) / 1000;
      if (dt > 0.15) {
        const inst = (rec.bytes - rec._lastBytes) / dt;
        rec.speed = rec.speed ? rec.speed * 0.6 + inst * 0.4 : inst;
        rec._lastBytes = rec.bytes;
        rec._lastAt = now;
      }
    } else { rec._lastBytes = rec.bytes; rec._lastAt = now; }
    rec._lastEmit = now;
    const { _lastEmit, _lastBytes, _lastAt, ...pub } = rec;
    this.emit('transfer', pub);
  }

  _finish(rec, status, error) {
    rec.status = status;
    rec.error = error || null;
    rec.endedAt = Date.now();
    rec.speed = 0;
    this.active.delete(rec.id);
    this.controls.delete(rec.id);
    const { _lastEmit, _lastBytes, _lastAt, ...pub } = rec;
    this._record({ kind: 'transfer', ...pub });
    this._emitTransfer(rec, true);
  }

  /* ---------- outgoing ---------- */

  _peer(id) {
    const p = this.discovery && this.discovery.peers.get(id);
    if (!p) throw new Error('That laptop is offline');
    return p;
  }

  async sendPaths(peerIds, paths) {
    const items = await T.collectItems(paths);
    if (!items.length) throw new Error('Nothing to send (empty folder?)');
    const ids = [];
    for (const pid of peerIds) {
      const peer = this._peer(pid);
      const rec = {
        id: crypto.randomUUID(),
        direction: 'out',
        peerId: peer.id,
        peerName: peer.name,
        title: paths.length === 1 ? path.basename(paths[0]) : `${path.basename(paths[0])} + ${paths.length - 1} more`,
        fileCount: items.length,
        files: items.slice(0, 50).map((i) => i.relPath),
        totalSize: items.reduce((a, i) => a + i.size, 0),
        bytes: 0,
        status: 'waiting',
        startedAt: Date.now(),
        localPaths: paths,
      };
      const control = { cancelled: false };
      this.active.set(rec.id, rec);
      this.controls.set(rec.id, control);
      this._emitTransfer(rec, true);
      ids.push(rec.id);
      T.sendFiles({
        peer,
        teamKey: this._key(),
        from: { id: this.settings.get('deviceId'), name: this.settings.get('deviceName') },
        transferId: rec.id,
        items,
        control,
        onAccepted: () => { rec.status = 'sending'; this._emitTransfer(rec, true); },
        onProgress: (b) => { rec.bytes = b; this._emitTransfer(rec); },
      }).then(
        () => { rec.bytes = rec.totalSize; this._finish(rec, 'done'); },
        (e) => this._finish(rec, e.code === 'REJECTED' ? 'rejected' : control.cancelled ? 'cancelled' : 'failed', e.message),
      );
    }
    return ids;
  }

  async sendText(peerIds, text) {
    text = String(text || '').slice(0, MAX_TEXT);
    if (!text.trim()) throw new Error('Message is empty');
    const results = [];
    for (const pid of peerIds) {
      const peer = this._peer(pid);
      const msg = { kind: 'message', id: crypto.randomUUID(), direction: 'out', peerId: peer.id, peerName: peer.name, text, ts: Date.now(), status: 'sending' };
      try {
        await T.sendSimple({ peer, teamKey: this._key(), payload: { type: 'text', id: msg.id, from: this._from(), text } });
        msg.status = 'sent';
      } catch (e) {
        msg.status = 'failed';
        msg.error = e.message;
      }
      this._record(msg);
      this.emit('message', msg);
      results.push(msg);
    }
    return results;
  }

  async buzz(peerId) {
    const peer = this._peer(peerId);
    await T.sendSimple({ peer, teamKey: this._key(), payload: { type: 'buzz', from: this._from() } });
    return true;
  }

  _from() { return { id: this.settings.get('deviceId'), name: this.settings.get('deviceName') }; }

  cancel(id) {
    const c = this.controls.get(id);
    if (c) { c.cancelled = true; c.cancel && c.cancel(); }
    const ask = this.pendingAsks.get(id);
    if (ask) ask(false);
  }

  respond(id, accept) {
    const r = this.pendingAsks.get(id);
    if (r) r(!!accept);
  }

  /* ---------- incoming ---------- */

  _peerFor(from, socket) {
    const known = from && from.id && this.discovery && this.discovery.peers.get(from.id);
    return {
      id: (known && known.id) || (from && from.id) || socket.remoteAddress,
      name: (known && known.name) || (from && from.name) || socket.remoteAddress,
    };
  }

  async _onSession(channel, socket) {
    const first = await channel.waitJson(15000);
    if (first.type === 'text') {
      const who = this._peerFor(first.from, socket);
      const msg = { kind: 'message', id: String(first.id || crypto.randomUUID()).slice(0, 64), direction: 'in', peerId: who.id, peerName: who.name, text: String(first.text || '').slice(0, MAX_TEXT), ts: Date.now(), status: 'received' };
      channel.sendJson({ type: 'ok' });
      socket.end();
      this._record(msg);
      this.emit('message', msg);
      return;
    }
    if (first.type === 'buzz') {
      channel.sendJson({ type: 'ok' });
      socket.end();
      this.emit('buzz', this._peerFor(first.from, socket));
      return;
    }
    const offer = T.validateOffer(first);
    if (!offer) { socket.destroy(); return; }
    const who = this._peerFor(offer.from, socket);
    const topNames = [...new Set(offer.items.map((i) => i.relPath.split('/')[0]))];
    const rec = {
      id: offer.transferId,
      direction: 'in',
      peerId: who.id,
      peerName: who.name,
      title: topNames.length === 1 ? topNames[0] : `${topNames[0]} + ${topNames.length - 1} more`,
      fileCount: offer.items.length,
      files: offer.items.slice(0, 50).map((i) => i.relPath),
      totalSize: offer.totalSize,
      bytes: 0,
      status: 'asking',
      startedAt: Date.now(),
    };
    if (this.active.has(rec.id)) rec.id = crypto.randomUUID();

    let dir = this.settings.get('receiveDir');
    if (this.settings.get('folderPerSender')) dir = path.join(dir, T.safeRelPath(who.name.replace(/\//g, '_'))?.[0] || 'Unknown');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      channel.sendJson({ type: 'reject', reason: 'Receiver cannot save files' });
      socket.end();
      return;
    }

    const control = { cancelled: false, cancel: () => socket.destroy() };
    this.active.set(rec.id, rec);
    this.controls.set(rec.id, control);

    let accept = true;
    if (this.settings.get('acceptMode') === 'ask') {
      this._emitTransfer(rec, true);
      this.emit('ask', { ...rec });
      accept = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 120000);
        this.pendingAsks.set(rec.id, (v) => { clearTimeout(t); resolve(v); });
        socket.once('close', () => resolve(false));
      });
      this.pendingAsks.delete(rec.id);
    }
    if (!accept) {
      try { channel.sendJson({ type: 'reject', reason: 'Declined' }); socket.end(); } catch {}
      this._finish(rec, 'rejected', 'Declined');
      return;
    }

    rec.status = 'receiving';
    this._emitTransfer(rec, true);
    try {
      const saved = await T.receiveFiles({
        channel, socket, offer, dir, control,
        onProgress: (b) => { rec.bytes = b; this._emitTransfer(rec); },
      });
      rec.savedPaths = saved;
      rec.bytes = rec.totalSize;
      this._finish(rec, 'done');
      this.emit('received', { ...rec });
    } catch (e) {
      this._finish(rec, control.cancelled ? 'cancelled' : 'failed', e.message);
    }
  }
}

module.exports = { Engine };
