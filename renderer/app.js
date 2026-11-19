'use strict';
/* Office Share — renderer */
const $ = (s) => document.querySelector(s);
const EVERYONE = '*';
const TERMINAL = ['done', 'failed', 'rejected', 'cancelled'];

const S = {
  self: null, settings: null, peers: [], foreignCount: 0,
  active: new Map(), history: [], selected: null, view: 'devices',
  pending: [], filter: 'all', search: '', unread: {}, asks: [],
  addresses: [], version: '', platform: '',
};

/* ---------- utils ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? (n / 1024 ** i < 10 ? 1 : 0) : 0)} ${u[i]}`;
}
const fmtSpeed = (b) => (b ? `${fmtBytes(b)}/s` : '');
function eta(t) {
  if (!t.speed || !t.totalSize) return '';
  const s = Math.max(0, (t.totalSize - t.bytes) / t.speed);
  if (s < 60) return `${Math.ceil(s)}s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}
function timeOf(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function dayOf(ts) {
  const d = new Date(ts); const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayOf(ts);
}
function initials(name) {
  const p = String(name || '?').replace(/[-_–.]/g, ' ').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '').slice(1, 2))).toUpperCase();
}
function colorFor(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 48%)`;
}
const osName = (o) => ({ windows: 'Windows', mac: 'Mac', linux: 'Linux' }[o] || o || '');
const ext = (n) => { const m = /\.([a-z0-9]{1,5})$/i.exec(n || ''); return m ? m[1].toUpperCase() : 'FILE'; };
const tsOf = (h) => h.ts || h.startedAt || 0;
const peerById = (id) => S.peers.find((p) => p.id === id);
const targetIds = (id) => (id === EVERYONE ? S.peers.map((p) => p.id) : [id]);

async function call(ch, payload) {
  const r = await window.api.call(ch, payload);
  if (!r.ok) { toast(r.error, 'bad'); throw new Error(r.error); }
  return r.data;
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------- sounds ---------- */
let actx = null;
function tone(freqs, dur = 0.12, type = 'sine', gap = 0.02) {
  if (!S.settings || !S.settings.sounds || S.settings.status === 'busy') return;
  try {
    actx = actx || new AudioContext();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
      t += dur + gap;
    }
  } catch {}
}
const chime = () => tone([880, 1320], 0.14);
const buzzSound = () => tone([220, 180, 220, 180], 0.09, 'square', 0.01);

/* ---------- rendering ---------- */
let raf = 0;
function render() { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderNow); }
function renderNow() {
  if (!S.settings) return;
  renderSide();
  if (S.view === 'devices') renderGrid();
  if (S.view === 'activity') renderActivity();
  renderDrawer();
}

function avatarHtml(id, name, status, cls = '') {
  return `<div class="avatar ${cls}" style="background:${id === EVERYONE ? '' : colorFor(id)}">${id === EVERYONE ? '★' : esc(initials(name))}${status ? `<span class="dot ${status}"></span>` : ''}</div>`;
}

function renderSide() {
  const me = S.self;
  $('#me-avatar').outerHTML = `<div id="me-avatar" class="avatar" style="background:${colorFor(me.id)}">${esc(initials(me.name))}<span class="dot ${S.settings.status}"></span></div>`;
  $('#me-name').textContent = me.name;
  $('#me-status').value = S.settings.status;
  $('#nav-online').textContent = S.peers.length;
  const act = S.active.size;
  $('#nav-active').textContent = act;
  $('#nav-active').classList.toggle('hidden', !act);
  $('#foot-info').innerHTML = `Office key <b>${esc(S.settings.teamFingerprint)}</b> · ${esc(S.addresses[0] || 'offline')}`;
}

function activeForPeer(id) {
  return [...S.active.values()].filter((t) => t.peerId === id);
}

function renderGrid() {
  const q = S.search.toLowerCase();
  const fav = new Set(S.settings.favorites || []);
  const peers = S.peers
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.user.toLowerCase().includes(q))
    .sort((a, b) => (fav.has(b.id) - fav.has(a.id)) || a.name.localeCompare(b.name));

  const cards = [];
  if (S.peers.length >= 2 && !q) {
    cards.push(`<div class="card everyone ${S.selected === EVERYONE ? 'selected' : ''}" data-id="${EVERYONE}">
      ${avatarHtml(EVERYONE, 'Everyone')}
      <div class="name">Everyone</div><div class="sub">All ${S.peers.length} laptops online</div></div>`);
  }
  for (const p of peers) {
    const act = activeForPeer(p.id);
    const total = act.reduce((a, t) => a + t.totalSize, 0);
    const done = act.reduce((a, t) => a + t.bytes, 0);
    const unread = S.unread[p.id] || 0;
    cards.push(`<div class="card ${S.selected === p.id ? 'selected' : ''}" data-id="${esc(p.id)}">
      <button class="star ${fav.has(p.id) ? 'on' : ''}" data-star="${esc(p.id)}" title="Pin to top">★</button>
      ${avatarHtml(p.id, p.name, p.status)}
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${esc(p.user || '')}${p.status !== 'available' ? ` · ${p.status === 'busy' ? 'Busy' : 'Away'}` : ''}</div>
      <span class="os">${esc(osName(p.os))}</span>
      ${unread ? `<span class="pill hot" style="position:absolute;top:10px;left:10px">${unread}</span>` : ''}
      ${act.length ? `<div class="prog"><div class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div><div class="sub" style="margin-top:4px">${act[0].direction === 'in' ? 'Receiving' : 'Sending'} · ${Math.floor(total ? (done / total) * 100 : 0)}%</div></div>` : ''}
    </div>`);
  }
  $('#grid').innerHTML = cards.join('');
  const none = S.peers.length === 0;
  $('#empty').classList.toggle('hidden', !none);
  $('#fp-empty').textContent = S.settings.teamFingerprint;
  const fw = $('#foreign-warn');
  fw.classList.toggle('hidden', !S.foreignCount);
  fw.innerHTML = `⚠ ${S.foreignCount} laptop${S.foreignCount > 1 ? 's are' : ' is'} running Office Share with a <b>different office key</b>. Ask them to use the same key (yours: <b>${esc(S.settings.teamFingerprint)}</b>).`;

  const pb = $('#pending-banner');
  pb.classList.toggle('hidden', !S.pending.length);
  if (S.pending.length) {
    const n = S.pending.map((p) => p.split(/[\\/]/).pop());
    $('#pending-title').textContent = `Send ${n.length === 1 ? n[0] : `${n.length} items`} — choose who gets it`;
  }
}

function fileCard(t) {
  const pct = t.totalSize ? Math.min(100, (t.bytes / t.totalSize) * 100) : (t.status === 'done' ? 100 : 0);
  const live = !TERMINAL.includes(t.status);
  const statusText = {
    waiting: 'Waiting for them to accept…', asking: 'Waiting for your answer…', sending: `Sending · ${fmtSpeed(t.speed)} · ${eta(t)}`,
    receiving: `Receiving · ${fmtSpeed(t.speed)} · ${eta(t)}`, done: t.direction === 'in' ? 'Received' : 'Delivered',
    failed: `Failed — ${t.error || ''}`, rejected: 'Declined', cancelled: 'Cancelled',
  }[t.status] || t.status;
  const p = (t.savedPaths && t.savedPaths[0]) || (t.localPaths && t.localPaths[0]);
  const acts = [];
  if (live) acts.push(`<button class="btn sm danger" data-cancel="${esc(t.id)}">Cancel</button>`);
  if (t.status === 'asking') acts.unshift(`<button class="btn sm" data-accept="${esc(t.id)}">Accept</button><button class="btn sm ghost" data-decline="${esc(t.id)}">Decline</button>`);
  if (t.status === 'done' && p) {
    if (t.direction === 'in' && t.fileCount === 1) acts.push(`<button class="btn sm" data-open="${esc(p)}">Open</button>`);
    acts.push(`<button class="btn sm ghost" data-show="${esc(p)}">Show in folder</button>`);
  }
  if (['failed', 'cancelled', 'rejected'].includes(t.status) && t.direction === 'out' && t.localPaths && peerById(t.peerId)) {
    acts.push(`<button class="btn sm" data-retry="${esc(t.id)}">Try again</button>`);
  }
  return { pct, live, statusText, acts: acts.join('') };
}

function renderDrawer() {
  const d = $('#drawer');
  if (!S.selected || S.view !== 'devices') { d.classList.add('hidden'); return; }
  const isAll = S.selected === EVERYONE;
  const p = isAll ? null : peerById(S.selected);
  d.classList.remove('hidden');
  const name = isAll ? 'Everyone' : p ? p.name : (lastKnownName(S.selected) || 'Offline laptop');
  const sub = isAll ? `${S.peers.length} laptops online` : p ? `${p.status === 'available' ? 'Online' : p.status === 'busy' ? 'Busy' : 'Away'} · ${osName(p.os)} · ${p.address}` : 'Offline';
  $('#drawer-head').innerHTML = `${avatarHtml(S.selected, name, p ? p.status : '')}<div class="t"><b>${esc(name)}</b><span class="muted small">${esc(sub)}</span></div><button class="x" id="drawer-close" title="Close">×</button>`;
  const offline = !isAll && !p;
  for (const id of ['#d-files', '#d-folder', '#d-clip', '#composer-send']) $(id).disabled = offline || (isAll && !S.peers.length);
  $('#d-buzz').disabled = offline || isAll;

  let items = isAll
    ? S.history.filter((h) => h.direction === 'out').slice(0, 40)
    : S.history.filter((h) => h.peerId === S.selected);
  const act = isAll ? [...S.active.values()] : activeForPeer(S.selected);
  items = [...act.map((a) => ({ kind: 'transfer', ...a })), ...items.filter((h) => !S.active.has(h.id))].sort((a, b) => tsOf(a) - tsOf(b));

  const tl = $('#timeline');
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 40;
  let lastDay = '';
  const html = [];
  if (!items.length) html.push(`<div class="muted small" style="text-align:center;margin-top:30px">Nothing yet.<br/>Drop files here or send a message.</div>`);
  for (const h of items) {
    const day = dayOf(tsOf(h));
    if (day !== lastDay) { html.push(`<div class="day">${day}</div>`); lastDay = day; }
    const who = isAll ? ` → ${esc(h.peerName)}` : '';
    if (h.kind === 'message') {
      html.push(`<div class="bubble ${h.direction}">${esc(h.text)}<div class="meta">${timeOf(h.ts)}${who}${h.status === 'failed' ? ' · ⚠ not delivered' : ''}<button data-copy="${esc(h.id)}">Copy</button></div></div>`);
    } else {
      const f = fileCard(h);
      html.push(`<div class="tfile ${h.direction}"><div class="top"><div class="fi">${h.fileCount > 1 ? h.fileCount : esc(ext(h.title))}</div>
        <div style="min-width:0"><div class="nm">${esc(h.title)}</div><div class="muted small">${fmtBytes(h.totalSize)}${h.fileCount > 1 ? ` · ${h.fileCount} files` : ''} · ${timeOf(tsOf(h))}${who}</div></div></div>
        ${f.live || h.status === 'done' ? `<div class="bar ${h.status === 'done' ? 'done' : ''}"><i style="width:${f.pct}%"></i></div>` : ''}
        <div class="muted small" style="margin-top:6px">${esc(f.statusText)}</div>
        ${f.acts ? `<div class="acts">${f.acts}</div>` : ''}</div>`);
    }
  }
  tl.innerHTML = html.join('');
  if (atBottom || tl.dataset.peer !== S.selected) tl.scrollTop = tl.scrollHeight;
  tl.dataset.peer = S.selected;
}

function lastKnownName(id) {
  const h = S.history.find((x) => x.peerId === id);
  return h && h.peerName;
}

function renderActivity() {
  const f = S.filter;
  let items = [...[...S.active.values()].map((a) => ({ kind: 'transfer', ...a })), ...S.history.filter((h) => !S.active.has(h.id))];
  items = items.filter((h) => f === 'all' || (f === 'msg' ? h.kind === 'message' : h.kind === 'transfer' && h.direction === f));
  items.sort((a, b) => (TERMINAL.includes(a.status) - TERMINAL.includes(b.status)) || tsOf(b) - tsOf(a));
  if (!items.length) { $('#act-list').innerHTML = `<div class="empty muted">No activity yet.</div>`; return; }
  $('#act-list').innerHTML = items.slice(0, 300).map((h) => {
    const arrow = h.direction === 'in' ? '↓' : '↑';
    const who = h.direction === 'in' ? `from ${esc(h.peerName)}` : `to ${esc(h.peerName)}`;
    if (h.kind === 'message') {
      return `<div class="act"><div class="fi">💬</div><div class="body"><div class="l1">${esc(h.text.split('\n')[0].slice(0, 120))}</div>
        <div class="muted small">${arrow} Message ${who} · ${ago(h.ts)}</div></div><div class="acts"><button class="btn sm ghost" data-copy="${esc(h.id)}">Copy</button><button class="btn sm ghost" data-chat="${esc(h.peerId)}">Chat</button></div></div>`;
    }
    const x = fileCard(h);
    return `<div class="act"><div class="fi">${arrow}</div><div class="body"><div class="l1">${esc(h.title)}</div>
      <div class="muted small">${fmtBytes(h.totalSize)}${h.fileCount > 1 ? ` · ${h.fileCount} files` : ''} ${who} · ${ago(tsOf(h))} · <span class="tag ${h.status}">${esc(x.statusText)}</span></div>
      ${x.live ? `<div class="bar"><i style="width:${x.pct}%"></i></div>` : ''}</div><div class="acts">${x.acts}</div></div>`;
  }).join('');
}

function fillSettings() {
  const s = S.settings;
  $('#set-name').value = s.deviceName;
  $('#set-fp').textContent = s.teamFingerprint;
  $('#set-login').checked = !!s.startAtLogin;
  $('#set-dir').textContent = s.receiveDir;
  $('#set-accept').value = s.acceptMode;
  $('#set-persender').checked = !!s.folderPerSender;
  $('#set-notif').checked = !!s.notifications;
  $('#set-sound').checked = !!s.sounds;
  $('#set-ver').textContent = S.version;
  $('#set-ip').textContent = S.addresses.join(', ') || 'Not connected';
}

/* ---------- state ---------- */
function applyState(st) {
  S.self = st.self; S.settings = st.settings; S.peers = st.peers; S.foreignCount = st.foreignCount;
  S.history = st.history || []; S.active = new Map((st.active || []).map((t) => [t.id, t]));
  S.pending = st.pending || []; S.addresses = st.addresses || []; S.version = st.version; S.platform = st.platform;
  if (!S.settings.configured) { $('#setup').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#setup-name').value = S.self.name; return; }
  $('#setup').classList.add('hidden'); $('#app').classList.remove('hidden');
  if (S.view === 'settings') fillSettings();
  render();
}

function upsertHistory(entry) {
  const i = S.history.findIndex((h) => h.id === entry.id);
  if (i >= 0) S.history[i] = entry; else S.history.unshift(entry);
}

function setView(v) {
  S.view = v;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  for (const n of ['devices', 'activity', 'settings']) $(`#view-${n}`).classList.toggle('hidden', n !== v);
  if (v === 'settings') fillSettings();
  render();
}

function select(id) {
  S.selected = id;
  delete S.unread[id];
  if (S.view !== 'devices') setView('devices'); else render();
  setTimeout(() => $('#composer').focus(), 50);
}

/* ---------- actions ---------- */
async function sendPaths(id, paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return toast('Could not read those files', 'bad');
  const ids = targetIds(id);
  if (!ids.length) return toast('No one is online', 'bad');
  await call('send:paths', { peerIds: ids, paths });
  toast(`Sending to ${ids.length === 1 ? (peerById(ids[0]) || {}).name : `${ids.length} laptops`}…`);
}

async function sendMessage() {
  const ta = $('#composer');
  const text = ta.value;
  if (!text.trim() || !S.selected) return;
  ta.value = '';
  try {
    const res = await call('send:text', { peerIds: targetIds(S.selected), text });
    const failed = res.filter((m) => m.status === 'failed');
    if (failed.length) toast(`Not delivered to ${failed.map((m) => m.peerName).join(', ')}`, 'bad');
  } catch { ta.value = text; }
}

function showAsk() {
  const t = S.asks[0];
  if (!t) { $('#modal').classList.add('hidden'); return; }
  $('#modal-body').innerHTML = `<div style="display:flex;gap:12px;align-items:center">${avatarHtml(t.peerId, t.peerName)}<div><b>${esc(t.peerName)}</b> wants to send you<div class="muted">${esc(t.title)} · ${fmtBytes(t.totalSize)}${t.fileCount > 1 ? ` · ${t.fileCount} files` : ''}</div></div></div>
    <ul>${t.files.slice(0, 20).map((f) => `<li>${esc(f)}</li>`).join('')}${t.fileCount > 20 ? `<li>…and ${t.fileCount - 20} more</li>` : ''}</ul>`;
  $('#modal').classList.remove('hidden');
}
async function answerAsk(accept) {
  const t = S.asks.shift();
  showAsk();
  if (t) await call('respond', { id: t.id, accept });
}

/* ---------- events from main ---------- */
window.api.on(({ type, data }) => {
  switch (type) {
    case 'peers': S.peers = data.peers; S.foreignCount = data.foreignCount; break;
    case 'transfer':
      if (TERMINAL.includes(data.status)) {
        S.active.delete(data.id);
        upsertHistory({ kind: 'transfer', ...data });
        S.asks = S.asks.filter((a) => a.id !== data.id); showAsk();
        if (data.direction === 'out') {
          if (data.status === 'done') toast(`✓ ${data.title} delivered to ${data.peerName}`, 'ok');
          else if (data.status === 'rejected') toast(`${data.peerName} declined ${data.title}`, 'bad');
          else if (data.status === 'failed') toast(`Could not send ${data.title}: ${data.error}`, 'bad');
        }
      } else S.active.set(data.id, data);
      break;
    case 'message':
      upsertHistory(data);
      if (data.direction === 'in') {
        chime();
        if (S.selected !== data.peerId || document.hidden) S.unread[data.peerId] = (S.unread[data.peerId] || 0) + 1;
      }
      break;
    case 'received': chime(); toast(`↓ ${data.title} from ${data.peerName}`, 'ok'); break;
    case 'ask': if (!S.asks.some((a) => a.id === data.id)) S.asks.push(data); showAsk(); chime(); break;
    case 'buzz':
      buzzSound();
      document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake');
      toast(`🔔 ${data.name} buzzed you`);
      break;
    case 'pending': S.pending = data; setView('devices'); break;
    case 'select': select(data); break;
    case 'state': applyState(data); return;
  }
  render();
});

/* ---------- DOM wiring ---------- */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
const filesOf = (e) => [...(e.dataTransfer.files || [])].map((f) => window.api.pathForFile(f));

const grid = $('#grid');
grid.addEventListener('click', async (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    const id = star.dataset.star;
    const fav = new Set(S.settings.favorites || []);
    fav.has(id) ? fav.delete(id) : fav.add(id);
    S.settings = await call('settings:update', { favorites: [...fav] });
    return render();
  }
  const card = e.target.closest('.card');
  if (!card) return;
  if (S.pending.length) {
    const paths = S.pending; S.pending = [];
    await call('pending:clear');
    await sendPaths(card.dataset.id, paths);
    select(card.dataset.id);
    return;
  }
  select(S.selected === card.dataset.id ? null : card.dataset.id);
});
grid.addEventListener('dragover', (e) => {
  const card = e.target.closest('.card');
  grid.querySelectorAll('.card.drop').forEach((c) => c !== card && c.classList.remove('drop'));
  if (card) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; card.classList.add('drop'); }
});
grid.addEventListener('dragleave', (e) => {
  const card = e.target.closest('.card');
  if (card && !card.contains(e.relatedTarget)) card.classList.remove('drop');
});
grid.addEventListener('drop', async (e) => {
  const card = e.target.closest('.card');
  grid.querySelectorAll('.card.drop').forEach((c) => c.classList.remove('drop'));
  if (!card) return;
  e.preventDefault();
  await sendPaths(card.dataset.id, filesOf(e));
});

const drawer = $('#drawer');
let dragDepth = 0;
drawer.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-hint').classList.remove('hidden'); });
drawer.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').classList.add('hidden'); } });
drawer.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop-hint').classList.add('hidden');
  if (S.selected) await sendPaths(S.selected, filesOf(e));
});

// Delegated buttons (timeline + activity)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (b.id === 'drawer-close') { S.selected = null; return render(); }
  if (d.cancel) return call('cancel', { id: d.cancel });
  if (d.accept) { S.asks = S.asks.filter((a) => a.id !== d.accept); showAsk(); return call('respond', { id: d.accept, accept: true }); }
  if (d.decline) { S.asks = S.asks.filter((a) => a.id !== d.decline); showAsk(); return call('respond', { id: d.decline, accept: false }); }
  if (d.open) return call('open:path', { p: d.open });
  if (d.show) return call('show:path', { p: d.show });
  if (d.chat) return select(d.chat);
  if (d.copy) {
    const m = S.history.find((h) => h.id === d.copy);
    if (m) { await call('clipboard:write', { text: m.text }); toast('Copied'); }
    return;
  }
  if (d.retry) {
    const t = S.history.find((h) => h.id === d.retry);
    if (t) await sendPaths(t.peerId, t.localPaths);
  }
});

$('#d-files').onclick = () => call('send:pick', { peerIds: targetIds(S.selected), folder: false });
$('#d-folder').onclick = () => call('send:pick', { peerIds: targetIds(S.selected), folder: true });
$('#d-clip').onclick = async () => { await call('send:clipboard', { peerIds: targetIds(S.selected) }); toast('Clipboard sent'); };
$('#d-buzz').onclick = async () => { await call('buzz', { peerId: S.selected }); toast('Buzz sent'); };
$('#composer-send').onclick = sendMessage;
$('#composer').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('#search').addEventListener('input', (e) => { S.search = e.target.value; render(); });
$('#act-filter').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  S.filter = c.dataset.f;
  document.querySelectorAll('#act-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
  render();
});
$('#clear-history').onclick = async () => { await call('history:clear'); S.history = []; render(); };
$('#open-inbox').onclick = () => call('open:receiveDir');
$('#pending-cancel').onclick = async () => { S.pending = []; await call('pending:clear'); render(); };
$('#me-status').onchange = async (e) => { S.settings = await call('settings:update', { status: e.target.value }); S.self.status = S.settings.status; render(); };
$('#modal-yes').onclick = () => answerAsk(true);
$('#modal-no').onclick = () => answerAsk(false);

// settings
const upd = async (patch) => { S.settings = await call('settings:update', patch); fillSettings(); render(); };
$('#set-name-save').onclick = async () => { await upd({ deviceName: $('#set-name').value }); S.self.name = S.settings.deviceName; toast('Name updated — everyone sees it now', 'ok'); render(); };
$('#set-key-save').onclick = async () => {
  const k = $('#set-key').value;
  if (k.trim().length < 4) return toast('Office key must be at least 4 characters', 'bad');
  applyState(await call('setup', { passphrase: k }));
  $('#set-key').value = '';
  fillSettings();
  toast('Office key changed. Use the same key on the other laptops.', 'ok');
};
$('#set-login').onchange = (e) => upd({ startAtLogin: e.target.checked });
$('#set-accept').onchange = (e) => upd({ acceptMode: e.target.value });
$('#set-persender').onchange = (e) => upd({ folderPerSender: e.target.checked });
$('#set-notif').onchange = (e) => upd({ notifications: e.target.checked });
$('#set-sound').onchange = (e) => upd({ sounds: e.target.checked });
$('#set-dir-open').onclick = () => call('open:receiveDir');
$('#set-dir-pick').onclick = async () => { S.settings = await call('pick:receiveDir'); fillSettings(); };

// setup screen
$('#setup-show').onchange = (e) => ($('#setup-key').type = e.target.checked ? 'text' : 'password');
async function doSetup() {
  $('#setup-err').textContent = '';
  const key = $('#setup-key').value;
  if (key.trim().length < 4) { $('#setup-err').textContent = 'Office key must be at least 4 characters.'; return; }
  $('#setup-go').disabled = true; $('#setup-go').textContent = 'Starting…';
  try { applyState(await call('setup', { passphrase: key, deviceName: $('#setup-name').value })); }
  catch (e) { $('#setup-err').textContent = e.message; }
  $('#setup-go').disabled = false; $('#setup-go').textContent = 'Start sharing';
}
$('#setup-go').onclick = doSetup;
$('#setup-key').addEventListener('keydown', (e) => e.key === 'Enter' && doSetup());

// refresh relative times
setInterval(() => { if (S.view === 'activity') render(); }, 30000);

(async () => { applyState(await call('state')); })();
