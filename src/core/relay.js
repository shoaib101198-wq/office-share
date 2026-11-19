'use strict';
// Cloud relay client: lets laptops on different networks reach each other
// through the office's own Cloudflare Worker. Everything is sealed with a key
// derived from the office key before it leaves the laptop.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { hkdf, teamId } = require('./crypto');
const { safeRelPath, uniqueName, TransferError } = require('./transfer');

const PART = 8 * 1024 * 1024;

function seal(key, aad, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function open(key, aad, buf) {
  if (buf.length < 28) throw new Error('Sealed data too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}

const sealJson = (key, aad, obj) => seal(key, aad, Buffer.from(JSON.stringify(obj))).toString('base64');
const openJson = (key, aad, b64) => JSON.parse(open(key, aad, Buffer.from(b64, 'base64')).toString('utf8'));

/** Parse "https://relay.example.workers.dev/?key=secret" into {base, key}. */
function parseLink(link) {
  const u = new URL(String(link || '').trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Relay link must start with https://');
  const key = u.searchParams.get('key') || '';
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, key };
}

class RelayClient {
  constructor({ link, teamKey }) {
    const { base, key } = parseLink(link);
    this.base = base;
    this.relayKey = key;
    this.team = teamId(teamKey);
    this.token = hkdf(teamKey, 'relay-auth').toString('hex');
    this.dataKey = hkdf(teamKey, 'relay-data');
  }

  async _req(method, p, { json, body, timeout = 30000 } = {}) {
    const headers = { 'x-team': this.team, 'x-auth': this.token };
    if (this.relayKey) headers['x-relay-key'] = this.relayKey;
    let payload;
    if (json !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(json); }
    if (body !== undefined) { headers['content-type'] = 'application/octet-stream'; payload = body; }
    let res;
    try {
      res = await fetch(`${this.base}${p}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new TransferError('NETWORK', `Can't reach the cloud relay (${e.cause?.code || e.name || e.message})`);
    }
    if (!res.ok) {
      let msg = `Relay error ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
      throw new TransferError(res.status === 404 ? 'NOT_FOUND' : 'RELAY', msg);
    }
    return res;
  }

  async hello(self) {
    const info = sealJson(this.dataKey, `info:${self.id}`, { name: self.name, user: self.user, os: self.os });
    const r = await this._req('POST', '/v1/hello', { json: { device: self.id, info, status: self.status } });
    return this._parseDevices(await r.json(), self.id);
  }

  async devices(selfId) {
    const r = await this._req('GET', '/v1/devices');
    return this._parseDevices(await r.json(), selfId);
  }

  _parseDevices(data, selfId) {
    const devices = [];
    for (const d of data.devices || []) {
      if (d.device === selfId) continue;
      try {
        const i = openJson(this.dataKey, `info:${d.device}`, d.info);
        devices.push({
          id: d.device,
          name: String(i.name || 'Unknown').slice(0, 64),
          user: String(i.user || '').slice(0, 64),
          os: String(i.os || ''),
          status: d.status,
          online: data.now - d.last_seen < data.onlineMs,
          lastSeen: Date.now() - (data.now - d.last_seen),
        });
      } catch { /* other office or corrupted — ignore */ }
    }
    return devices;
  }

  putPart(id, n, buf) { return this._req('PUT', `/v1/blob/${id}/${n}`, { body: buf, timeout: 180000 }); }
  async getPart(id, n) {
    const r = await this._req('GET', `/v1/blob/${id}/${n}`, { timeout: 180000 });
    return Buffer.from(await r.arrayBuffer());
  }
  send(item) { return this._req('POST', '/v1/send', { json: item }); }
  async inbox(device) {
    const r = await this._req('GET', `/v1/inbox?device=${encodeURIComponent(device)}`);
    return (await r.json()).items || [];
  }
  ack(id) { return this._req('POST', `/v1/ack/${id}`); }
  cancel(id) { return this._req('DELETE', `/v1/mail/${id}`); }
  async status(ids) {
    const r = await this._req('POST', '/v1/status', { json: { ids } });
    return (await r.json()).items || [];
  }

  /* ---------- high level ---------- */

  async sendMessage({ id, from, to, kind, payload }) {
    const meta = sealJson(this.dataKey, `meta:${id}`, { from, ...payload });
    await this.send({ id, to, from: from.id, kind, meta, parts: 0, size: 0 });
  }

  /** Upload files as sealed 8 MB chunks, then post the delivery note. */
  async sendFiles({ id, from, to, items, onProgress, control }) {
    const total = items.reduce((a, i) => a + i.size, 0);
    const buf = Buffer.alloc(Math.min(PART, Math.max(1, total)));
    let n = 0;
    let fill = 0;
    let sent = 0;
    const flush = async () => {
      if (control.cancelled) throw new TransferError('CANCELLED', 'Cancelled');
      await this.putPart(id, n, seal(this.dataKey, `${id}:${n}`, buf.subarray(0, fill)));
      n++;
      sent += fill;
      fill = 0;
      onProgress && onProgress(sent, total);
    };
    for (const it of items) {
      if (!it.size) continue;
      const fh = await fsp.open(it.abs, 'r');
      try {
        let left = it.size;
        while (left > 0) {
          const want = Math.min(buf.length - fill, left);
          const { bytesRead } = await fh.read(buf, fill, want, null);
          if (!bytesRead) throw new TransferError('CHANGED', `${path.basename(it.abs)} changed while sending`);
          fill += bytesRead;
          left -= bytesRead;
          if (fill === buf.length) await flush();
        }
      } finally {
        await fh.close();
      }
    }
    if (fill > 0) await flush();
    if (control.cancelled) throw new TransferError('CANCELLED', 'Cancelled');
    const meta = sealJson(this.dataKey, `meta:${id}`, { from, items: items.map((i) => ({ relPath: i.relPath, size: i.size })), totalSize: total });
    await this.send({ id, to, from: from.id, kind: 'files', meta, parts: n, size: total });
  }

  /** Download + decrypt a files mail into dir. Returns saved top-level paths. */
  async receiveFiles({ mail, meta, dir, onProgress }) {
    const items = meta.items;
    const tops = new Map();
    const saved = [];
    const written = [];
    let idx = 0;
    let cur = null;
    let received = 0;

    const openNext = async () => {
      while (!cur && idx < items.length) {
        const parts = safeRelPath(items[idx].relPath);
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
        const fh = await fsp.open(tmp, 'w');
        written.push(tmp);
        cur = { fh, tmp, final, left: items[idx].size };
        idx++;
        if (cur.left === 0) await closeCur();
      }
    };
    const closeCur = async () => {
      const c = cur;
      cur = null;
      await c.fh.close();
      await fsp.rename(c.tmp, c.final);
      written.splice(written.indexOf(c.tmp), 1);
    };

    try {
      await openNext();
      for (let n = 0; n < mail.parts; n++) {
        let data = open(this.dataKey, `${mail.id}:${n}`, await this.getPart(mail.id, n));
        while (data.length) {
          if (!cur) await openNext();
          if (!cur) throw new TransferError('PROTOCOL', 'More data than expected');
          const take = Math.min(cur.left, data.length);
          await cur.fh.write(data.subarray(0, take));
          cur.left -= take;
          received += take;
          data = data.subarray(take);
          if (cur.left === 0) { await closeCur(); await openNext(); }
        }
        onProgress && onProgress(received, meta.totalSize);
      }
      await openNext();
      if (cur || idx < items.length) throw new TransferError('PROTOCOL', 'Missing data');
      return saved;
    } catch (e) {
      if (cur) { try { await cur.fh.close(); } catch {} }
      for (const t of written) fs.rm(t, { force: true }, () => {});
      throw e;
    }
  }
}

module.exports = { RelayClient, parseLink, seal, open, sealJson, openJson };
