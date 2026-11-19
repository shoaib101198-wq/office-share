// Office Share cloud relay — Cloudflare Worker (D1 + R2).
// The relay never sees file contents, names or messages: laptops encrypt
// everything with the office key before uploading. It only stores sealed
// chunks and routes them to the right laptop.

const ONLINE_MS = 150 * 1000;
const KEEP_DEVICES_MS = 30 * 24 * 3600 * 1000;
const KEEP_MAIL_MS = 7 * 24 * 3600 * 1000;
const MAX_PART = 16 * 1024 * 1024;
const MAX_META = 256 * 1024;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS teams (team TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS devices (team TEXT NOT NULL, device TEXT NOT NULL, info TEXT, status TEXT, last_seen INTEGER NOT NULL, PRIMARY KEY (team, device))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS mail (id TEXT PRIMARY KEY, team TEXT NOT NULL, to_device TEXT NOT NULL, from_device TEXT NOT NULL, kind TEXT NOT NULL, meta TEXT NOT NULL, parts INTEGER NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, delivered INTEGER)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS mail_to ON mail (team, to_device, delivered)`),
  ]);
  schemaReady = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const err = (status, message) => json({ error: message }, status);
const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Team = public office-key fingerprint. First laptop to use it registers its token hash. */
async function authTeam(req, env) {
  if (env.RELAY_KEY) {
    const k = req.headers.get('x-relay-key') || '';
    if (!safeEqual(k, env.RELAY_KEY)) return { error: err(401, 'Wrong relay key') };
  }
  const team = req.headers.get('x-team') || '';
  const token = req.headers.get('x-auth') || '';
  if (!/^[a-f0-9]{16}$/.test(team) || !/^[a-f0-9]{64}$/.test(token)) return { error: err(401, 'Missing team credentials') };
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT token_hash FROM teams WHERE team = ?').bind(team).first();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO teams (team, token_hash, created) VALUES (?, ?, ?)').bind(team, hash, Date.now()).run();
    const again = await env.DB.prepare('SELECT token_hash FROM teams WHERE team = ?').bind(team).first();
    if (!again || !safeEqual(again.token_hash, hash)) return { error: err(403, 'Team token mismatch') };
  } else if (!safeEqual(row.token_hash, hash)) {
    return { error: err(403, 'Team token mismatch') };
  }
  return { team };
}

async function deleteParts(env, team, id) {
  let cursor;
  do {
    const list = await env.BUCKET.list({ prefix: `${team}/${id}/`, cursor });
    if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function listDevices(env, team, now) {
  const { results } = await env.DB.prepare('SELECT device, info, status, last_seen FROM devices WHERE team = ? AND last_seen > ?')
    .bind(team, now - KEEP_DEVICES_MS).all();
  return { now, onlineMs: ONLINE_MS, devices: results };
}

async function handle(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/') return new Response('Office Share relay is running.', { headers: { 'content-type': 'text/plain' } });
  if (!p.startsWith('/v1/')) return err(404, 'Not found');

  await ensureSchema(env.DB);
  const auth = await authTeam(req, env);
  if (auth.error) return auth.error;
  const team = auth.team;
  const now = Date.now();
  const parts = p.split('/').slice(2); // after /v1/

  // POST /v1/hello  {device, info, status}
  if (parts[0] === 'hello' && req.method === 'POST') {
    const b = await req.json();
    if (!okId(b.device) || typeof b.info !== 'string' || b.info.length > 8192) return err(400, 'Bad hello');
    const status = ['available', 'busy', 'away'].includes(b.status) ? b.status : 'available';
    await env.DB.prepare(
      `INSERT INTO devices (team, device, info, status, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(team, device) DO UPDATE SET info = excluded.info, status = excluded.status, last_seen = excluded.last_seen`,
    ).bind(team, b.device, b.info, status, now).run();
    return json(await listDevices(env, team, now));
  }

  // GET /v1/devices — read-only, cheap; laptops poll this often
  if (parts[0] === 'devices' && req.method === 'GET') {
    return json(await listDevices(env, team, now));
  }

  // PUT /v1/blob/:id/:n  (sealed chunk)
  if (parts[0] === 'blob' && okId(parts[1]) && /^\d{1,6}$/.test(parts[2] || '')) {
    const key = `${team}/${parts[1]}/${parts[2]}`;
    if (req.method === 'PUT') {
      const len = Number(req.headers.get('content-length') || 0);
      if (!len || len > MAX_PART) return err(413, 'Chunk too large');
      await env.BUCKET.put(key, req.body);
      return json({ ok: true });
    }
    if (req.method === 'GET') {
      const obj = await env.BUCKET.get(key);
      if (!obj) return err(404, 'Chunk not found');
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } });
    }
  }

  // POST /v1/send  {id, to, from, kind, meta, parts, size}
  if (parts[0] === 'send' && req.method === 'POST') {
    const b = await req.json();
    if (!okId(b.id) || !okId(b.to) || !okId(b.from) || !['files', 'text', 'buzz'].includes(b.kind)) return err(400, 'Bad send');
    if (typeof b.meta !== 'string' || b.meta.length > MAX_META) return err(400, 'Bad meta');
    const n = Number(b.parts) | 0;
    await env.DB.prepare('INSERT OR REPLACE INTO mail (id, team, to_device, from_device, kind, meta, parts, size, created, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .bind(b.id, team, b.to, b.from, b.kind, b.meta, n, Number(b.size) || 0, now).run();
    return json({ ok: true });
  }

  // GET /v1/inbox?device=X
  if (parts[0] === 'inbox' && req.method === 'GET') {
    const device = url.searchParams.get('device');
    if (!okId(device)) return err(400, 'Bad device');
    const { results } = await env.DB.prepare(
      'SELECT id, from_device, kind, meta, parts, size, created FROM mail WHERE team = ? AND to_device = ? AND delivered IS NULL ORDER BY created LIMIT 50',
    ).bind(team, device).all();
    return json({ now, items: results });
  }

  // POST /v1/ack/:id  — recipient got it: free the storage, keep a delivered marker for the sender
  if (parts[0] === 'ack' && okId(parts[1]) && req.method === 'POST') {
    await env.DB.prepare("UPDATE mail SET delivered = ?, meta = '' WHERE id = ? AND team = ?").bind(now, parts[1], team).run();
    await deleteParts(env, team, parts[1]);
    return json({ ok: true });
  }

  // POST /v1/status {ids:[...]} — sender checks which items were delivered
  if (parts[0] === 'status' && req.method === 'POST') {
    const b = await req.json();
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(okId).slice(0, 100);
    if (!ids.length) return json({ items: [] });
    const { results } = await env.DB.prepare(`SELECT id, delivered FROM mail WHERE team = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(team, ...ids).all();
    return json({ items: results });
  }

  // DELETE /v1/mail/:id — sender cancels before delivery
  if (parts[0] === 'mail' && okId(parts[1]) && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM mail WHERE id = ? AND team = ? AND delivered IS NULL').bind(parts[1], team).run();
    await deleteParts(env, team, parts[1]);
    return json({ ok: true });
  }

  return err(404, 'Not found');
}

async function cleanup(env) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const { results } = await env.DB.prepare('SELECT id, team FROM mail WHERE created < ? LIMIT 500').bind(now - KEEP_MAIL_MS).all();
  for (const r of results) {
    await deleteParts(env, r.team, r.id);
    await env.DB.prepare('DELETE FROM mail WHERE id = ?').bind(r.id).run();
  }
  await env.DB.prepare('DELETE FROM devices WHERE last_seen < ?').bind(now - KEEP_DEVICES_MS).run();
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      return err(500, e && e.message ? e.message : 'Relay error');
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
