'use strict';
// Headless end-to-end test: two "laptops" on one machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { Engine } = require('../src/core/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); }
  throw new Error('timeout waiting');
}

function mk(name, dport, tport, others, extra = {}) {
  return new Engine({
    dataDir: path.join(tmp, name, 'data'),
    defaultReceiveDir: path.join(tmp, name, 'inbox'),
    extraTargets: others.map((p) => ({ address: '127.0.0.1', port: p })),
    overrides: { deviceName: name, discoveryPort: dport, tcpPort: tport, ...extra },
  });
}

(async () => {
  const A = mk('Ali-PC', 47001, 47101, [47002, 47003]);
  const B = mk('Sara-Laptop', 47002, 47102, [47001, 47003]);
  const C = mk('Outsider', 47003, 47103, [47001, 47002]);
  await A.setup({ passphrase: 'highsky office 2026' });
  await B.setup({ passphrase: 'highsky office 2026' });
  await C.setup({ passphrase: 'some other key' });

  // 1. auto discovery
  await until(() => A.peers().length === 1 && B.peers().length === 1);
  assert.strictEqual(A.peers()[0].name, 'Sara-Laptop');
  await until(() => A.foreignCount() === 1);
  assert.ok(!A.peers().some((p) => p.name === 'Outsider'), 'outsider must be hidden');
  console.log('✓ discovery: A sees', A.peers().map((p) => p.name), '| foreign:', A.foreignCount());

  // 2. status / rename propagates
  await B.updateSettings({ status: 'busy', deviceName: 'Sara-Mac' });
  await until(() => A.peers()[0].status === 'busy' && A.peers()[0].name === 'Sara-Mac');
  console.log('✓ status + rename propagate');

  const bId = A.peers()[0].id;

  // 3. single big file
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'Project', 'sub'), { recursive: true });
  const big = crypto.randomBytes(25 * 1024 * 1024 + 123);
  fs.writeFileSync(path.join(src, 'video.bin'), big);
  fs.writeFileSync(path.join(src, 'Project', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'Project', 'sub', 'b.txt'), 'world');
  fs.writeFileSync(path.join(src, 'Project', 'empty.txt'), '');

  let doneRec;
  B.once('received', (r) => (doneRec = r));
  const t0 = Date.now();
  await A.sendPaths([bId], [path.join(src, 'video.bin')]);
  await until(() => doneRec, 20000);
  const got = fs.readFileSync(path.join(tmp, 'Sara-Laptop', 'inbox', 'video.bin'));
  assert.ok(got.equals(big), 'file content must match');
  console.log(`✓ 25MB file sent in ${Date.now() - t0}ms, hash matches`);

  // 4. same name again -> "video (1).bin"
  doneRec = null;
  B.once('received', (r) => (doneRec = r));
  await A.sendPaths([bId], [path.join(src, 'video.bin')]);
  await until(() => doneRec, 20000);
  assert.ok(fs.existsSync(path.join(tmp, 'Sara-Laptop', 'inbox', 'video (1).bin')));
  console.log('✓ duplicate name kept both files');

  // 5. folder
  doneRec = null;
  B.once('received', (r) => (doneRec = r));
  await A.sendPaths([bId], [path.join(src, 'Project')]);
  await until(() => doneRec, 10000);
  const pdir = path.join(tmp, 'Sara-Laptop', 'inbox', 'Project');
  assert.strictEqual(fs.readFileSync(path.join(pdir, 'sub', 'b.txt'), 'utf8'), 'world');
  assert.strictEqual(fs.readFileSync(path.join(pdir, 'empty.txt'), 'utf8'), '');
  console.log('✓ folder with subfolders + empty file');

  // 6. text message + buzz
  let msg, buzz;
  B.once('message', (m) => (msg = m));
  B.once('buzz', (p) => (buzz = p));
  await A.sendText([bId], 'Salam! file bhej di hai');
  await A.buzz(bId);
  await until(() => msg && buzz);
  assert.strictEqual(msg.text, 'Salam! file bhej di hai');
  assert.strictEqual(buzz.name, 'Ali-PC');
  console.log('✓ message + buzz delivered');

  // 7. ask mode: decline
  await B.updateSettings({ acceptMode: 'ask' });
  B.once('ask', (r) => setTimeout(() => B.respond(r.id, false), 100));
  let outRec;
  const onT = (r) => { if (r.direction === 'out' && ['rejected', 'done', 'failed', 'cancelled'].includes(r.status)) outRec = r; };
  A.on('transfer', onT);
  await A.sendPaths([bId], [path.join(src, 'Project', 'a.txt')]);
  await until(() => outRec);
  assert.strictEqual(outRec.status, 'rejected');
  console.log('✓ ask mode: decline works');

  // 8. ask mode: accept
  outRec = null;
  B.once('ask', (r) => setTimeout(() => B.respond(r.id, true), 100));
  await A.sendPaths([bId], [path.join(src, 'Project', 'a.txt')]);
  await until(() => outRec);
  assert.strictEqual(outRec.status, 'done');
  console.log('✓ ask mode: accept works');
  await B.updateSettings({ acceptMode: 'auto' });

  // 9. cancel mid-transfer
  outRec = null;
  const hugePath = path.join(src, 'huge.bin');
  fs.writeFileSync(hugePath, Buffer.alloc(400 * 1024 * 1024, 7));
  const onFirst = (r) => { if (r.direction === 'out' && r.bytes > 0 && r.status === 'sending') { A.off('transfer', onFirst); A.cancel(r.id); } };
  A.on('transfer', onFirst);
  await A.sendPaths([bId], [hugePath]);
  await until(() => outRec);
  assert.strictEqual(outRec.status, 'cancelled');
  await wait(300);
  const leftovers = fs.readdirSync(path.join(tmp, 'Sara-Laptop', 'inbox')).filter((f) => f.endsWith('.osdownload'));
  assert.strictEqual(leftovers.length, 0, 'partial file removed');
  console.log('✓ cancel cleans up partial file');
  A.off('transfer', onT);

  // 10. outsider with wrong key cannot deliver even if it knows the address
  const T = require('../src/core/transfer');
  let blocked = false;
  try {
    await T.sendSimple({ peer: { address: '127.0.0.1', port: B.port }, teamKey: C._key(), payload: { type: 'text', text: 'hack' } });
  } catch { blocked = true; }
  assert.ok(blocked, 'wrong key must be refused');
  console.log('✓ wrong office key is refused');

  // 11. offline detection
  await B.stop();
  await until(() => A.peers().length === 0, 15000);
  console.log('✓ laptop going offline disappears from list');

  // 12. history persisted
  assert.ok(A.history.get('items').length >= 6);
  console.log('✓ history entries:', A.history.get('items').length);

  await A.stop(); await C.stop();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
