// Class X Drive — registration registry (replaces the Google Apps Script web app).
//
// Mount from server.js with:   require('./registry')(app, upstash);
// Endpoint:  POST /api/registry   (JSON sent as text/plain, same as before)
//
// Actions (unchanged from the Apps Script version):
//   lookup, register, visit, signout, status      -> used by index.html
//   admin_list, admin_block, admin_unblock        -> used by admin.html
//
// WHERE DATA LIVES
//   Upstash Redis = the live source of truth (fast, no per-minute limits). Lookups, blocks and the
//                   once-a-minute "am I blocked?" checks never touch Zoho.
//   Zoho Sheet    = the readable copy. New registrations, blocks and login events are written there in
//                   small batches (one API call per tab every ~20 s), so Zoho's per-minute limit is safe
//                   and a Zoho outage can never stop anyone signing in.
//
// ENVIRONMENT VARIABLES (set on Render)
//   GOOGLE_CLIENT_ID     optional, defaults to the one already in index.html
//   ADMIN_EMAILS         comma list of Gmail addresses allowed to use the admin panel
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_WORKBOOK_ID
//   ZOHO_DC              "com" (default) or "in", "eu", "com.au"... — must match where your Zoho account lives
//   REGISTRY_SEED        optional one-time JSON list of existing students (see below)
//   (If the ZOHO_* variables are missing, everything still works; events are kept in Redis only.)

const fs = require('fs');
const path = require('path');
const express = require('express');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '67192974879-m1ff3lvj5jmql8ljg345uhbroghs0v29.apps.googleusercontent.com';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'jointsecretary79@gmail.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const DC = process.env.ZOHO_DC || 'com';
const Z = {
  id: process.env.ZOHO_CLIENT_ID, secret: process.env.ZOHO_CLIENT_SECRET,
  refresh: process.env.ZOHO_REFRESH_TOKEN, book: process.env.ZOHO_WORKBOOK_ID,
};
const zohoOn = !!(Z.id && Z.secret && Z.refresh && Z.book);

const USERS = 'classx:reg:users';       // field = email, value = profile JSON
const BLOCKED = 'classx:reg:blocked';   // field = email, value = {email,reason,by,at}
const LOGQ = 'classx:reg:eventlog';     // fallback / safety copy of events (capped)

const TABS = { users: 'Sheet1', blocked: 'Blocked', log: 'Login log' };
const HEAD = {
  users: ['Email', 'Name', 'Role', 'School', 'State', 'District', 'Mobile', 'Registered at'],
  blocked: ['Email', 'Reason', 'Blocked by', 'Blocked at (IST)'],
  log: ['Date & time (IST)', 'Name', 'Email', 'Action'],
};

// ---- time helpers (IST, same formats as the old sheet) ----
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const p2 = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = ist(); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const stampDMY = () => { const d = ist(); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };

module.exports = function mountRegistry(app, upstash) {
  // ---------- Redis helpers ----------
  const hget = async (key, f) => { const { result } = await upstash(['HGET', key, f]); try { return result ? JSON.parse(result) : null; } catch { return null; } };
  const hall = async (key) => {
    const { result } = await upstash(['HGETALL', key]);
    const out = [];
    if (Array.isArray(result)) for (let i = 0; i + 1 < result.length; i += 2) { try { out.push(JSON.parse(result[i + 1])); } catch { /* skip */ } }
    else if (result && typeof result === 'object') for (const v of Object.values(result)) { try { out.push(JSON.parse(v)); } catch { /* skip */ } }
    return out;
  };

  // ---------- Zoho Sheet (batched mirror) ----------
  let zToken = null, zTokenAt = 0;
  async function zohoAccessToken() {
    if (zToken && Date.now() - zTokenAt < 50 * 60000) return zToken;
    const u = `https://accounts.zoho.${DC}/oauth/v2/token?` + new URLSearchParams({
      refresh_token: Z.refresh, client_id: Z.id, client_secret: Z.secret, grant_type: 'refresh_token',
    });
    const r = await fetch(u, { method: 'POST' });
    const j = await r.json();
    if (!j.access_token) throw new Error('Zoho token error: ' + JSON.stringify(j));
    zToken = j.access_token; zTokenAt = Date.now();
    return zToken;
  }
  async function zohoCall(params) {
    const token = await zohoAccessToken();
    const r = await fetch(`https://sheet.zoho.${DC}/api/v2/${Z.book}`, {
      method: 'POST',
      headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === 'failure') { if (r.status === 401) zToken = null; throw new Error('Zoho ' + r.status + ' ' + JSON.stringify(j).slice(0, 300)); }
    return j;
  }

  const queue = { users: [], blocked: [], log: [] };
  function enqueue(tab, rowArr) {
    const obj = {}; HEAD[tab].forEach((h, i) => { obj[h] = rowArr[i] == null ? '' : String(rowArr[i]); });
    queue[tab].push(obj);
  }
  let flushing = false;
  async function flush() {
    if (!zohoOn || flushing) return;
    flushing = true;
    try {
      for (const tab of Object.keys(queue)) {
        if (!queue[tab].length) continue;
        const batch = queue[tab].splice(0, 100);
        try {
          await zohoCall({ method: 'worksheet.records.add', worksheet_name: TABS[tab], json_data: JSON.stringify(batch) });
        } catch (e) {
          console.error('zoho mirror failed (will retry):', tab, e.message);
          queue[tab].unshift(...batch);          // put them back, try again next round
          break;
        }
      }
    } finally { flushing = false; }
  }
  setInterval(flush, 20000);

  // remove a row from the "Blocked" tab when someone is restored (best effort)
  async function zohoRemoveBlocked(email) {
    if (!zohoOn) return;
    try {
      await zohoCall({ method: 'worksheet.records.delete', worksheet_name: TABS.blocked, criteria: `"Email"="${email}"`, delete_rows: 'true' });
    } catch (e) { console.error('zoho unblock mirror failed:', e.message); }
  }

  function logEvent(name, email, action) {
    const row = [stamp(), name || '', email, action];
    enqueue('log', row);
    upstash(['LPUSH', LOGQ, JSON.stringify(row)]).then(() => upstash(['LTRIM', LOGQ, 0, 4999])).catch(() => {});
  }

  // ---------- Google token check ----------
  const tokenCache = new Map();   // credential -> { email, name, exp }
  async function verify(credential) {
    if (!credential || typeof credential !== 'string') return null;
    const hit = tokenCache.get(credential);
    if (hit && hit.until > Date.now()) return hit;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      if (!r.ok) return null;
      const t = await r.json();
      if (t.aud !== GOOGLE_CLIENT_ID) return null;
      if (String(t.email_verified) !== 'true' || !t.email) return null;
      if (Number(t.exp) * 1000 < Date.now()) return null;
      const v = { email: String(t.email).toLowerCase(), name: t.name || '', until: Math.min(Date.now() + 10 * 60000, Number(t.exp) * 1000) };
      tokenCache.set(credential, v);
      if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value);
      return v;
    } catch { return null; }
  }

  // light spam guard for the unauthenticated actions (visit / signout / status)
  const hits = new Map();
  function allow(email, limit) {
    const k = email, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < 3600000);
    if (arr.length >= limit) { hits.set(k, arr); return false; }
    arr.push(now); hits.set(k, arr); return true;
  }

  const cleanProfile = (p) => {
    p = p || {};
    const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    return { name: s(p.name, 80), role: s(p.role, 20), school: s(p.school, 120), state: s(p.state, 60), district: s(p.district, 60), mobile: s(p.mobile, 10) };
  };
  const profileOut = (u) => ({ name: u.name, role: u.role, school: u.school, state: u.state, district: u.district, mobile: u.mobile });
  const blockedOut = (b) => ({ email: b.email, reason: b.reason, by: b.by, at: b.at });

  // ---------- seed existing students once (never overwrites) ----------
  // The student list is personal data, so it is NOT stored in the (public) GitHub repo.
  // Put it in the Render environment variable REGISTRY_SEED (a JSON list). It is only used while the
  // registry is empty, so after the first start you can delete that variable.
  (async () => {
    try {
      const raw = process.env.REGISTRY_SEED;
      if (!raw) return;
      if ((await upstash(['HLEN', USERS])).result > 0) return;
      for (const u of JSON.parse(raw)) {
        if (u && u.email) await upstash(['HSETNX', USERS, String(u.email).toLowerCase(), JSON.stringify(u)]);
      }
      console.log('Registry: seeded existing students');
    } catch (e) { console.error('registry seed error', e.message); }
  })();

  // ---------- the endpoint ----------
  app.post('/api/registry', express.text({ type: '*/*', limit: '100kb' }), async (req, res) => {
    let b = {};
    try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return res.json({ ok: false, error: 'Bad request' }); }
    const action = String(b.action || '');
    try {
      // ----- public read: is this Gmail blocked? (no token needed, returns nothing else) -----
      if (action === 'status') {
        const email = String(b.email || '').toLowerCase();
        if (!email) return res.json({ ok: true, blocked: false });
        return res.json({ ok: true, blocked: !!(await hget(BLOCKED, email)) });
      }

      // ----- visit / signout: log only for registered people -----
      if (action === 'visit' || action === 'signout') {
        const v = await verify(b.credential);
        const email = (v && v.email) || String(b.email || '').toLowerCase();
        if (!email) return res.json({ ok: true });
        const blocked = !!(await hget(BLOCKED, email));
        const user = await hget(USERS, email);
        if (user && allow(email, 60)) logEvent(user.name, email, action === 'visit' ? 'Visit again (clicked OK)' : 'Sign out');
        return res.json({ ok: true, blocked });
      }

      // ----- admin actions -----
      if (action.startsWith('admin_')) {
        const v = await verify(b.credential);
        if (!v) return res.json({ ok: false, error: 'Your Google sign-in could not be verified.' });
        if (!ADMIN_EMAILS.includes(v.email)) return res.json({ ok: false, error: 'This Gmail is not an admin.' });
        const target = String(b.email || '').trim().toLowerCase();
        if (action === 'admin_block') {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return res.json({ ok: false, error: 'Enter a valid email address.' });
          if (ADMIN_EMAILS.includes(target)) return res.json({ ok: false, error: 'You cannot block an admin.' });
          const rec = { email: target, reason: String(b.reason || '').slice(0, 200), by: v.email, at: stamp() };
          await upstash(['HSET', BLOCKED, target, JSON.stringify(rec)]);
          enqueue('blocked', [rec.email, rec.reason, rec.by, rec.at]);
        } else if (action === 'admin_unblock') {
          await upstash(['HDEL', BLOCKED, target]);
          zohoRemoveBlocked(target);
        } else if (action !== 'admin_list') {
          return res.json({ ok: false, error: 'Unknown action.' });
        }
        const list = (await hall(BLOCKED)).map(blockedOut).sort((a, c) => String(c.at).localeCompare(String(a.at)));
        return res.json({ ok: true, admin: v.email, blocked: list });
      }

      // ----- lookup / register need a verified Google token -----
      const v = await verify(b.credential);
      if (!v) return res.json({ ok: false, error: 'Your Google sign-in could not be verified. Please sign in again.' });
      const email = v.email;

      if (await hget(BLOCKED, email)) return res.json({ ok: true, blocked: true, registered: false });

      if (action === 'lookup') {
        const user = await hget(USERS, email);
        logEvent(user ? user.name : v.name, email, 'Sign in');
        return res.json(user ? { ok: true, registered: true, profile: profileOut(user) } : { ok: true, registered: false });
      }

      if (action === 'register') {
        const p = cleanProfile(b.profile);
        if (p.name.length < 2 || !['Student', 'Teacher', 'Parent'].includes(p.role) || p.school.length < 2 || !p.state || p.district.length < 2 || !/^[6-9]\d{9}$/.test(p.mobile)) {
          return res.json({ ok: false, error: 'Some details are missing or invalid.' });
        }
        const existing = await hget(USERS, email);
        const rec = existing ? Object.assign({}, existing, p) : Object.assign({ email, registeredAt: stampDMY() }, p);
        await upstash(['HSET', USERS, email, JSON.stringify(rec)]);
        if (!existing) enqueue('users', [email, rec.name, rec.role, rec.school, rec.state, rec.district, rec.mobile, rec.registeredAt]);
        return res.json({ ok: true, registered: true });
      }

      return res.json({ ok: false, error: 'Unknown action.' });
    } catch (err) {
      console.error('registry error', action, err.message);
      return res.json({ ok: false, error: 'Server error. Please try again.' });
    }
  });

  // Admin-only health check: shows whether the Zoho link is configured and how many rows are waiting.
  app.get('/api/registry/health', (req, res) => {
    res.json({ ok: true, zohoConfigured: zohoOn, dc: DC, admins: ADMIN_EMAILS.length, waiting: { users: queue.users.length, blocked: queue.blocked.length, log: queue.log.length } });
  });
};
