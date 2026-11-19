'use strict';
// Office key derivation + per-frame AES-256-GCM encryption.
const crypto = require('crypto');

const SALT = Buffer.from('office-share/v1/team-key');

/** Turn the office passphrase into a 32-byte team key (same on every laptop). */
function deriveTeamKey(passphrase) {
  const norm = String(passphrase || '').trim();
  if (norm.length < 4) throw new Error('Office key must be at least 4 characters');
  return crypto.scryptSync(norm, SALT, 32, { N: 16384, r: 8, p: 1 });
}

function hkdf(key, info, salt = Buffer.alloc(0)) {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, Buffer.from(info), 32));
}

/** Public, non-secret team fingerprint so we can tell "same office" from "other office". */
function teamId(teamKey) {
  return hkdf(teamKey, 'team-id').toString('hex').slice(0, 16);
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Seals/opens frames for one TCP session. Each direction has its own sequence
 * counter bound into the AAD, so frames can't be reordered, replayed or reflected.
 */
class FrameCipher {
  constructor(sessionKey, isClient) {
    this.key = sessionKey;
    this.sendDir = isClient ? 0 : 1;
    this.recvDir = isClient ? 1 : 0;
    this.sendSeq = 0n;
    this.recvSeq = 0n;
  }
  _aad(dir, seq) {
    const b = Buffer.alloc(9);
    b.writeUInt8(dir, 0);
    b.writeBigUInt64BE(seq, 1);
    return b;
  }
  seal(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this._aad(this.sendDir, this.sendSeq++));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
  }
  open(buf) {
    if (buf.length < 28) throw new Error('Frame too short');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(this._aad(this.recvDir, this.recvSeq++));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
}

module.exports = { deriveTeamKey, hkdf, teamId, hmac, safeEqual, FrameCipher };
