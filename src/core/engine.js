'use strict';
// Office Share engine: ties discovery, transfers, cloud relay, settings and history together.
// Pure Node (no Electron), so it can be tested headless.
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Discovery } = require('./discovery');
const T = require('./transfer');
const { RelayClient, parseLink, openJson } = require('./relay');
const { deriveTeamKey, teamId, hkdf } = require('./crypto');
const { JsonStore } = require('./store');

const HISTORY_LIMIT = 1000;
const MAX_TEXT = 20000;
const RELAY_TICK_MS = 8000;
const RELAY_HELLO_MS = 60000;

function osLabel(p = process.platform) {
  return p === 'win32' ? 'windows' : p === 'darwin' ? 'mac' : 'linux';
}

class Engine extends EventEmitter {
  constructor({ dataDir, defaultReceiveDir, extraTargets = [], overrides = {}, relayTickMs = RELAY_TICK_MS }) {
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
      relayUrl: '',
      relayPending: [], // outgoing cloud transfers waiting for delivery
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
    // cloud relay
    this.relay = null;
    this.relayTickMs = relayTickMs;
    this.remote = new Map(); // deviceId -> remote peer
    this.relayState = { enabled: false, connected: false, error: '', lastOk: 0 };
    this._relayTimer = null;
    this._lastHello = 0;
    this._inboxBusy = new Set();
    this._failures = new Map();
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
    this.discovery.on('change', () => { clearTimeout(t); t = setTimeout(() => this._emitPeers(), 60); });
    this.discovery.on('found', (p) => this.emit('peer-online', p));
    this.discovery.on('warn', (e) => this.emit('warn', e));
    await this.discovery.start();
    this._startRelay();
    this._emitPeers();
  }

  async stop() {
    this._stopRelay();
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
    const patch = { teamKey: key.toString('hex'), relayPending: [] };
    if (deviceName && deviceName.trim()) patch.deviceName = deviceName.trim().slice(0, 40);
    this.settings.set(patch);
    this.settings.flush();
    await this.restart();
  }

  async updateSettings(patch) {
    const allowed = ['deviceName', 'receiveDir', 'acceptMode', 'folderPerSender', 'status', 'startAtLogin', 'notifications', 'sounds', 'favorites', 'relayUrl'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if (clean.deviceName !== undefined) clean.deviceName = String(clean.deviceName).trim().slice(0, 40) || os.hostname();
    if (clean.status && !['available', 'busy', 'away'].includes(clean.status)) delete clean.status;
    if (clean.relayUrl !== undefined) {
      clean.relayUrl = String(clean.relayUrl || '').trim();
      if (clean.relayUrl) parseLink(clean.relayUrl); // throws on a bad link
    }
    const relayChanged = 'relayUrl' in clean && clean.relayUrl !== this.settings.get('relayUrl');
    this.settings.set(clean);
    // Tell everyone right away about name/status changes.
    if (this.discovery && (clean.deviceName || clean.status)) this.discovery.announce('announce');
    if (relayChanged) { this._stopRelay(); this.remote.clear(); if (this.server) this._startRelay(); this._emitPeers(); }
    else if (this.relay && (clean.deviceName || clean.status)) { this._lastHello = 0; this._relayTick(); }
    return this.publicSettings();
  }

  publicSettings() {
    const { teamKey, relayPending, ...rest } = this.settings.data;
    return { ...rest, configured: !!teamKey, teamFingerprint: teamKey ? teamId(this._key()).slice(0, 6).toUpperCase() : '' };
  }

  /** LAN peers first; laptops only reachable through the cloud are marked remote. */
  peers() {
    const lan = this.discovery ? this.discovery.list().map((p) => ({ ...p, remote: false, online: true })) : [];
    const ids = new Set(lan.map((p) => p.id));
    const remote = [...this.remote.values()].filter((p) => !ids.has(p.id)).map((p) => ({
      id: p.id, name: p.name, user: p.user, os: p.os,
      status: p.online ? p.status : 'offline', remote: true, online: p.online, lastSeen: p.lastSeen,
    }));
    return [...lan, ...remote].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  }

  _emitPeers() { this.emit('peers', this.peers()); }
  foreignCount() { return this.discovery ? this.discovery.foreign.size : 0; }

  state() {
    return {
      self: this.self(),
      settings: this.publicSettings(),
      peers: this.peers(),
      foreignCount: this.foreignCount(),
      relay: this.relayState,
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

  _patchHistory(id, patch) {
    const items = this.history.get('items');
    const e = items.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, patch);
    this.history.save();
    this.emit('transfer', { ...e });
    return e;
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

  /* ---------- routing ---------- */

  /** Decide how to reach a laptop: directly on the LAN, or through the cloud relay. */
  _route(id) {
    const lan = this.discovery && this.discovery.peers.get(id);
    if (lan) return { via: 'lan', peer: lan };
    const r = this.remote.get(id);
    if (r && this.relay) return { via: 'relay', peer: r };
    throw new Error('That laptop is offline');
  }

  _from() { return { id: this.settings.get('deviceId'), name: this.settings.get('deviceName') }; }

  /* ---------- outgoing ---------- */

  async sendPaths(peerIds, paths) {
    const items = await T.collectItems(paths);
    if (!items.length) throw new Error('Nothing to send (empty folder?)');
    const ids = [];
    for (const pid of peerIds) {
      const { via, peer } = this._route(pid);
      const rec = {
        id: crypto.randomUUID(),
        direction: 'out',
        via,
        peerId: peer.id,
        peerName: peer.name,
        title: paths.length === 1 ? path.basename(paths[0]) : `${path.basename(paths[0])} + ${paths.length - 1} more`,
        fileCount: items.length,
        files: items.slice(0, 50).map((i) => i.relPath),
        totalSize: items.reduce((a, i) => a + i.size, 0),
        bytes: 0,
        status: via === 'lan' ? 'waiting' : 'uploading',
        startedAt: Date.now(),
        localPaths: paths,
      };
      const control = { cancelled: false };
      this.active.set(rec.id, rec);
      this.controls.set(rec.id, control);
      this._emitTransfer(rec, true);
      ids.push(rec.id);

      const fail = (e) => this._finish(rec, e.code === 'REJECTED' ? 'rejected' : control.cancelled ? 'cancelled' : 'failed', e.message);
      if (via === 'lan') {
        T.sendFiles({
          peer, teamKey: this._key(), from: this._from(), transferId: rec.id, items, control,
          onAccepted: () => { rec.status = 'sending'; this._emitTransfer(rec, true); },
          onProgress: (b) => { rec.bytes = b; this._emitTransfer(rec); },
        }).then(() => { rec.bytes = rec.totalSize; this._finish(rec, 'done'); }, fail);
      } else {
        const relay = this.relay;
        relay.sendFiles({
          id: rec.id, from: this._from(), to: peer.id, items, control,
          onProgress: (b) => { rec.bytes = b; this._emitTransfer(rec); },
        }).then(() => {
          rec.bytes = rec.totalSize;
          this.settings.set({ relayPending: [...this.settings.get('relayPending'), rec.id].slice(-200) });
          this._finish(rec, 'queued');
          this._lastStatus = 0;
        }, (e) => {
          if (control.cancelled) relay.cancel(rec.id).catch(() => {});
          fail(e);
        });
      }
    }
    return ids;
  }

  async sendText(peerIds, text) {
    text = String(text || '').slice(0, MAX_TEXT);
    if (!text.trim()) throw new Error('Message is empty');
    const results = [];
    for (const pid of peerIds) {
      const { via, peer } = this._route(pid);
      const msg = { kind: 'message', id: crypto.randomUUID(), direction: 'out', via, peerId: peer.id, peerName: peer.name, text, ts: Date.now(), status: 'sending' };
      try {
        if (via === 'lan') {
          await T.sendSimple({ peer, teamKey: this._key(), payload: { type: 'text', id: msg.id, from: this._from(), text } });
        } else {
          await this.relay.sendMessage({ id: msg.id, from: this._from(), to: peer.id, kind: 'text', payload: { text } });
        }
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
    const { via, peer } = this._route(peerId);
    if (via === 'lan') {
      await T.sendSimple({ peer, teamKey: this._key(), payload: { type: 'buzz', from: this._from() } });
    } else {
      if (!peer.online) throw new Error(`${peer.name} is offline`);
      await this.relay.sendMessage({ id: crypto.randomUUID(), from: this._from(), to: peer.id, kind: 'buzz', payload: {} });
    }
    return true;
  }

  cancel(id) {
    const c = this.controls.get(id);
    if (c) { c.cancelled = true; c.cancel && c.cancel(); }
    const ask = this.pendingAsks.get(id);
    if (ask) ask(false);
    const pend = this.settings.get('relayPending');
    if (pend.includes(id)) {
      this.settings.set({ relayPending: pend.filter((x) => x !== id) });
      if (this.relay) this.relay.cancel(id).catch(() => {});
      this._patchHistory(id, { status: 'cancelled', error: 'Cancelled', endedAt: Date.now() });
    }
  }

  respond(id, accept) {
    const r = this.pendingAsks.get(id);
    if (r) r(!!accept);
  }

  /* ---------- incoming (shared) ---------- */

  _peerFor(from, fallback) {
    const id = from && from.id;
    const known = id && ((this.discovery && this.discovery.peers.get(id)) || this.remote.get(id));
    return {
      id: (known && known.id) || id || fallback,
      name: (known && known.name) || (from && from.name) || fallback,
    };
  }

  _receiveDir(who) {
    let dir = this.settings.get('receiveDir');
    if (this.settings.get('folderPerSender')) dir = path.join(dir, T.safeRelPath(who.name.replace(/\//g, '_'))?.[0] || 'Unknown');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _incomingRecord(id, who, items, totalSize, via) {
    const topNames = [...new Set(items.map((i) => i.relPath.split('/')[0]))];
    return {
      id: this.active.has(id) ? crypto.randomUUID() : id,
      direction: 'in',
      via,
      peerId: who.id,
      peerName: who.name,
      title: topNames.length === 1 ? topNames[0] : `${topNames[0]} + ${topNames.length - 1} more`,
      fileCount: items.length,
      files: items.slice(0, 50).map((i) => i.relPath),
      totalSize,
      bytes: 0,
      status: 'asking',
      startedAt: Date.now(),
    };
  }

  /** Ask the user (when "Ask me first" is on). Resolves true/false. */
  _ask(rec, onAbort) {
    if (this.settings.get('acceptMode') !== 'ask') return Promise.resolve(true);
    this._emitTransfer(rec, true);
    this.emit('ask', { ...rec });
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 120000);
      this.pendingAsks.set(rec.id, (v) => { clearTimeout(t); resolve(v); });
      if (onAbort) onAbort(() => resolve(false));
    }).finally(() => this.pendingAsks.delete(rec.id));
  }

  /* ---------- incoming over LAN ---------- */

  async _onSession(channel, socket) {
    const first = await channel.waitJson(15000);
    if (first.type === 'text') {
      const who = this._peerFor(first.from, socket.remoteAddress);
      const msg = { kind: 'message', id: String(first.id || crypto.randomUUID()).slice(0, 64), direction: 'in', via: 'lan', peerId: who.id, peerName: who.name, text: String(first.text || '').slice(0, MAX_TEXT), ts: Date.now(), status: 'received' };
      channel.sendJson({ type: 'ok' });
      socket.end();
      this._record(msg);
      this.emit('message', msg);
      return;
    }
    if (first.type === 'buzz') {
      channel.sendJson({ type: 'ok' });
      socket.end();
      this.emit('buzz', this._peerFor(first.from, socket.remoteAddress));
      return;
    }
    const offer = T.validateOffer(first);
    if (!offer) { socket.destroy(); return; }
    const who = this._peerFor(offer.from, socket.remoteAddress);
    const rec = this._incomingRecord(offer.transferId, who, offer.items, offer.totalSize, 'lan');

    let dir;
    try { dir = this._receiveDir(who); } catch {
      channel.sendJson({ type: 'reject', reason: 'Receiver cannot save files' });
      socket.end();
      return;
    }

    const control = { cancelled: false, cancel: () => socket.destroy() };
    this.active.set(rec.id, rec);
    this.controls.set(rec.id, control);

    const accept = await this._ask(rec, (abort) => socket.once('close', abort));
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

  /* ---------- cloud relay ---------- */

  _startRelay() {
    const link = this.settings.get('relayUrl');
    if (!link || !this.isConfigured()) { this.relayState = { enabled: false, connected: false, error: '', lastOk: 0 }; this.emit('relay', this.relayState); return; }
    try {
      this.relay = new RelayClient({ link, teamKey: this._key() });
    } catch (e) {
      this.relay = null;
      this.relayState = { enabled: true, connected: false, error: e.message, lastOk: 0 };
      this.emit('relay', this.relayState);
      return;
    }
    this.relayState = { enabled: true, connected: false, error: '', lastOk: 0 };
    this._lastHello = 0;
    this._lastStatus = 0;
    const loop = async () => {
      await this._relayTick();
      if (this.relay) this._relayTimer = setTimeout(loop, this.relayTickMs);
    };
    this._relayTimer = setTimeout(loop, 10);
  }

  _stopRelay() {
    clearTimeout(this._relayTimer);
    this._relayTimer = null;
    this.relay = null;
  }

  /** Force an immediate relay check (e.g. after wake-up). */
  pokeRelay() { if (this.relay) { this._lastHello = 0; this._relayTick(); } }

  async _relayTick() {
    const relay = this.relay;
    if (!relay || this._ticking) return;
    this._ticking = true;
    try {
      const now = Date.now();
      {
        let devices;
        if (now - this._lastHello >= RELAY_HELLO_MS) { devices = await relay.hello(this.self()); this._lastHello = now; }
        else devices = await relay.devices(this.settings.get('deviceId'));
        if (relay !== this.relay) return;
        const before = JSON.stringify([...this.remote.values()].map((p) => [p.id, p.name, p.status, p.online]));
        this.remote = new Map(devices.map((d) => [d.id, d]));
        const after = JSON.stringify(devices.map((p) => [p.id, p.name, p.status, p.online]));
        if (before !== after) this._emitPeers();
      }
      const inbox = await relay.inbox(this.settings.get('deviceId'));
      for (const mail of inbox) this._handleMail(relay, mail);
      const pend = this.settings.get('relayPending');
      if (pend.length && now - (this._lastStatus || 0) >= 5000) {
        this._lastStatus = now;
        const st = await relay.status(pend);
        const byId = new Map(st.map((s) => [s.id, s]));
        const keep = [];
        for (const id of pend) {
          const s = byId.get(id);
          if (s && s.delivered) this._patchHistory(id, { status: 'done', endedAt: s.delivered });
          else if (!s) this._patchHistory(id, { status: 'failed', error: 'Declined or expired' });
          else keep.push(id);
        }
        if (keep.length !== pend.length) this.settings.set({ relayPending: keep });
      }
      if (!this.relayState.connected || this.relayState.error) {
        this.relayState = { enabled: true, connected: true, error: '', lastOk: Date.now() };
        this.emit('relay', this.relayState);
      } else this.relayState.lastOk = Date.now();
    } catch (e) {
      if (relay === this.relay && (this.relayState.connected || this.relayState.error !== e.message)) {
        this.relayState = { enabled: true, connected: false, error: e.message, lastOk: this.relayState.lastOk };
        this.emit('relay', this.relayState);
      }
    } finally {
      this._ticking = false;
    }
  }

  async _handleMail(relay, mail) {
    if (this._inboxBusy.has(mail.id)) return;
    this._inboxBusy.add(mail.id);
    try {
      let meta;
      try { meta = openJson(relay.dataKey, `meta:${mail.id}`, mail.meta); } catch {
        await relay.ack(mail.id); // not readable with our key — drop it
        return;
      }
      const who = this._peerFor(meta.from, 'Unknown');
      if (mail.kind === 'text') {
        const msg = { kind: 'message', id: mail.id, direction: 'in', via: 'relay', peerId: who.id, peerName: who.name, text: String(meta.text || '').slice(0, MAX_TEXT), ts: mail.created || Date.now(), status: 'received' };
        await relay.ack(mail.id);
        this._record(msg);
        this.emit('message', msg);
        return;
      }
      if (mail.kind === 'buzz') {
        await relay.ack(mail.id);
        if (Date.now() - (mail.created || 0) < 3 * 60 * 1000) this.emit('buzz', who);
        return;
      }
      // files
      const items = Array.isArray(meta.items) ? meta.items.filter((i) => i && T.safeRelPath(i.relPath) && Number.isSafeInteger(i.size) && i.size >= 0) : [];
      if (!items.length || items.length !== (meta.items || []).length) { await relay.ack(mail.id); return; }
      const total = items.reduce((a, i) => a + i.size, 0);
      const rec = this._incomingRecord(mail.id, who, items, total, 'relay');
      this.active.set(rec.id, rec);
      this.controls.set(rec.id, { cancelled: false });
      const accept = await this._ask(rec);
      if (!accept) {
        await relay.cancel(mail.id).catch(() => {});
        this._finish(rec, 'rejected', 'Declined');
        return;
      }
      rec.status = 'receiving';
      this._emitTransfer(rec, true);
      try {
        const saved = await relay.receiveFiles({
          mail, meta: { items, totalSize: total }, dir: this._receiveDir(who),
          onProgress: (b) => { rec.bytes = b; this._emitTransfer(rec); },
        });
        await relay.ack(mail.id);
        rec.savedPaths = saved;
        rec.bytes = total;
        this._finish(rec, 'done');
        this.emit('received', { ...rec });
        this._failures.delete(mail.id);
      } catch (e) {
        const n = (this._failures.get(mail.id) || 0) + 1;
        this._failures.set(mail.id, n);
        if (n >= 3) { await relay.ack(mail.id).catch(() => {}); this._finish(rec, 'failed', e.message); }
        else { this.active.delete(rec.id); this.controls.delete(rec.id); this.emit('transfer', { ...rec, status: 'failed', error: 'Download interrupted — will retry' }); }
      }
    } catch (e) {
      this.emit('warn', e);
    } finally {
      this._inboxBusy.delete(mail.id);
    }
  }
}

module.exports = { Engine };
