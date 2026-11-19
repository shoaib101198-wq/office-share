'use strict';
// End-to-end cloud relay test. Needs the relay running locally:
//   cd relay && echo RELAY_KEY=testkey123 > .dev.vars && npx wrangler dev --port 8787
// then: RELAY=http://127.0.0.1:8787/?key=testkey123 node test/relay.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { Engine } = require('../src/core/engine');

const LINK = process.env.RELAY || 'http://127.0.0.1:8787/?key=testkey123';
const KEY = 'remote office key ' + Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osr-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); }
  throw new Error('timeout waiting for ' + what);
}
let port = 47300;
function mk(name, extra = {}) {
  port += 2;
  return new Engine({
    dataDir: path.join(tmp, name, 'data'),
    defaultReceiveDir: path.join(tmp, name, 'inbox'),
    relayTickMs: 300,
    overrides: { deviceName: name, discoveryPort: port, tcpPort: port + 1, relayUrl: LINK, ...extra },
  });
}

(async () => {
  // A at the office, B at home — different discovery ports, so no LAN contact.
  let A = mk('Ali-Office');
  let B = mk('Sara-Home');
  const C = mk('Other-Company');
  await A.setup({ passphrase: KEY });
  await B.setup({ passphrase: KEY });
  await C.setup({ passphrase: 'a completely different key' });

  await until(() => A.relayState.connected && B.relayState.connected, 15000, 'relay connect');
  const bId = B.settings.get('deviceId');
  await until(() => A.peers().some((p) => p.id === bId && p.online), 15000, 'remote peer');
  const sara = A.peers().find((p) => p.id === bId);
  assert.ok(sara.remote, 'peer must be marked remote');
  assert.ok(!A.peers().some((p) => p.name === 'Other-Company'), 'other office must be invisible');
  assert.strictEqual(A.discovery.list().length, 0, 'no LAN contact');
  console.log('✓ remote laptop visible through the cloud, other office invisible');

  // Files + folder through the relay (> 8 MB so it spans several chunks)
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'Docs', 'sub'), { recursive: true });
  const big = crypto.randomBytes(19 * 1024 * 1024 + 777);
  fs.writeFileSync(path.join(src, 'scan.pdf'), big);
  fs.writeFileSync(path.join(src, 'Docs', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(src, 'Docs', 'sub', 'empty.txt'), '');

  let got;
  B.once('received', (r) => (got = r));
  const outEvents = [];
  A.on('transfer', (t) => outEvents.push(t.status));
  const t0 = Date.now();
  const [tid] = await A.sendPaths([sara.id], [path.join(src, 'scan.pdf'), path.join(src, 'Docs')]);
  await until(() => got, 60000, 'relay delivery');
  const inbox = path.join(tmp, 'Sara-Home', 'inbox');
  assert.ok(fs.readFileSync(path.join(inbox, 'scan.pdf')).equals(big), 'big file intact');
  assert.strictEqual(fs.readFileSync(path.join(inbox, 'Docs', 'a.txt'), 'utf8'), 'alpha');
  assert.strictEqual(fs.readFileSync(path.join(inbox, 'Docs', 'sub', 'empty.txt'), 'utf8'), '');
  console.log(`✓ 19 MB file + folder delivered via cloud in ${Date.now() - t0} ms, contents match`);
  assert.ok(outEvents.includes('uploading') && outEvents.includes('queued'));
  await until(() => A.history.get('items').find((h) => h.id === tid)?.status === 'done', 30000, 'delivered status');
  console.log('✓ sender sees "Delivered" after recipient downloads');

  // Text + buzz
  let msg, bz;
  B.once('message', (m) => (msg = m));
  B.once('buzz', (p) => (bz = p));
  await A.sendText([sara.id], 'Ghar se file mil gayi?');
  await A.buzz(sara.id);
  await until(() => msg && bz, 15000, 'text+buzz');
  assert.strictEqual(msg.text, 'Ghar se file mil gayi?');
  assert.strictEqual(bz.name, 'Ali-Office');
  console.log('✓ message + buzz via cloud');

  // Offline delivery: Sara shuts laptop, Ali sends, Sara comes back later
  await B.stop();
  fs.writeFileSync(path.join(src, 'later.xlsx'), 'numbers');
  await A.sendPaths([sara.id], [path.join(src, 'later.xlsx')]);
  await A.sendText([sara.id], 'Sent while you were offline');
  await wait(1500);
  got = null; msg = null;
  B = mk('Sara-Home'); // same data dir → same device id + key
  port -= 2;
  B.once('received', (r) => (got = r));
  B.once('message', (m) => (msg = m));
  await B.start();
  await until(() => got && msg, 30000, 'offline delivery');
  assert.strictEqual(fs.readFileSync(path.join(inbox, 'later.xlsx'), 'utf8'), 'numbers');
  console.log('✓ offline delivery: file + message arrive when laptop comes back');

  // Ask mode decline → sender sees failure
  await B.updateSettings({ acceptMode: 'ask' });
  B.once('ask', (r) => setTimeout(() => B.respond(r.id, false), 100));
  const [tid2] = await A.sendPaths([sara.id], [path.join(src, 'Docs', 'a.txt')]);
  await until(() => ['failed', 'rejected'].includes(A.history.get('items').find((h) => h.id === tid2)?.status), 40000, 'decline status');
  console.log('✓ declined cloud transfer reported back to sender');
  await B.updateSettings({ acceptMode: 'auto' });

  // Someone who knows the team id but not the office key is refused
  const res = await fetch('http://127.0.0.1:8787/v1/inbox?device=x', {
    headers: { 'x-relay-key': 'testkey123', 'x-team': A.relay.team, 'x-auth': 'f'.repeat(64) },
  });
  assert.strictEqual(res.status, 403);
  console.log('✓ forged team token refused');

  // Relay never stores plaintext names
  const r2 = await fetch('http://127.0.0.1:8787/v1/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-key': 'testkey123', 'x-team': A.relay.team, 'x-auth': A.relay.token },
    body: JSON.stringify({ device: 'probe', info: 'x', status: 'available' }),
  });
  const raw = JSON.stringify(await r2.json());
  assert.ok(!raw.includes('Sara-Home') && !raw.includes('Ali-Office'), 'names must be encrypted on relay');
  console.log('✓ relay only stores encrypted names');

  // Wrong relay link reports an error
  await C.updateSettings({ relayUrl: 'http://127.0.0.1:8787/?key=wrong' });
  await until(() => C.relayState.error, 10000, 'relay error');
  console.log('✓ wrong relay key shows error:', C.relayState.error);

  await A.stop(); await B.stop(); await C.stop();
  console.log('\nALL RELAY TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
