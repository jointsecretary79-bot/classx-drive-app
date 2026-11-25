// Class X Drive — push notification backend
// Endpoints:
//   GET  /api/vapid-public-key   -> gives the frontend the public key it needs to subscribe
//   POST /api/subscribe          -> registers a device (stored per device in Redis; safe against overwrites)
//   POST /api/unsubscribe        -> removes a device's push subscription
//   POST /api/notify             -> (admin only) sends a notification to every subscribed device
//   POST /api/alarms/sync        -> NEW: the app sends a device's alarms + upcoming tasks
//   GET  /api/alarms/tick        -> NEW: sends anything that is due (also useful as a keep-awake ping)
//
// CHANGED FROM THE ORIGINAL: subscriptions used to live in a local file
// (subscriptions.json). On Render's free tier that file gets wiped every
// time the service restarts or redeploys, so all subscribers were silently
// lost — that's why "Sent to 0 of 0 devices" kept showing up. Subscriptions
// are now stored in Upstash Redis (a free, always-on key-value store that
// survives restarts) instead.
//
// ALSO NEW: study alarms. They are stored in the same Upstash Redis database, so they survive
// restarts too, and are sent as push notifications at the right time even when the app is closed.

const express = require('express');
const webpush = require('web-push');
const path = require('path');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));      // drafts of long articles are bigger than the 100 kB default
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-now';

// ---- VAPID keys ----
// Generate your own with:  npx web-push generate-vapid-keys
// Then set them as environment variables on your host (never hardcode in real deploys).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables.');
  console.error('Generate a pair with: npx web-push generate-vapid-keys');
  process.exit(1);
}
webpush.setVapidDetails(
  'mailto:jointsecretary79@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ---- Upstash Redis (persistent, free, survives restarts) ----
// Create a free database at https://console.upstash.com, then copy its
// "REST URL" and "REST TOKEN" into these two Render environment variables.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN environment variables.');
  console.error('Create a free database at https://console.upstash.com and copy its REST URL + REST TOKEN.');
  process.exit(1);
}
const SUBS_KEY = 'classx:subscriptions';

async function upstash(command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error(`Upstash error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function loadSubscriptions() {
  const { result } = await upstash(['GET', SUBS_KEY]);
  if (!result) return [];
  try {
    return JSON.parse(result);
  } catch {
    return [];
  }
}

async function saveSubscriptions(subs) {
  await upstash(['SET', SUBS_KEY, JSON.stringify(subs)]);
}

// ---- devices (everyone who can receive admin updates) ----
// Stored the same way as the study alarms: one Redis hash, one row per device (field = push endpoint).
// Rows are written one at a time, so two devices registering at once can never overwrite each other
// (the old single-list approach could lose subscribers). A device is re-registered every time the app
// opens or syncs, so nobody has to press the notification button again and again.
const DEVICES_KEY = 'classx:devices';

async function loadDevices() {
  const { result } = await upstash(['HGETALL', DEVICES_KEY]);
  const out = {};
  if (Array.isArray(result)) {
    for (let i = 0; i + 1 < result.length; i += 2) {
      try { out[result[i]] = JSON.parse(result[i + 1]); } catch { /* skip bad row */ }
    }
  } else if (result && typeof result === 'object') {
    for (const [k, v] of Object.entries(result)) { try { out[k] = JSON.parse(v); } catch { /* skip */ } }
  }
  return out;
}
const saveDevice = (sub) => upstash(['HSET', DEVICES_KEY, sub.endpoint, JSON.stringify({ subscription: sub, seen: Date.now() })]);
const deleteDevice = (endpoint) => upstash(['HDEL', DEVICES_KEY, endpoint]).catch((e) => console.error('device delete error', e.message));
const validSub = (sub) => sub && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://');

// one-time copy of the old subscriber list (classx:subscriptions) into the new device hash
async function migrateLegacyDevices() {
  try {
    const done = await upstash(['GET', 'classx:devices-migrated']);
    if (done.result) return;
    const legacy = await loadSubscriptions();
    for (const sub of legacy) {
      if (validSub(sub)) await upstash(['HSETNX', DEVICES_KEY, sub.endpoint, JSON.stringify({ subscription: sub, seen: Date.now() })]);
    }
    await upstash(['SET', 'classx:devices-migrated', '1']);
    console.log('Migrated', legacy.length, 'old subscribers');
  } catch (err) {
    console.error('migrate error', err.message);
  }
}

// ---- routes ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    if (!validSub(subscription)) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await saveDevice(subscription);
    const { result: total } = await upstash(['HLEN', DEVICES_KEY]);
    res.status(201).json({ ok: true, total });
  } catch (err) {
    console.error('subscribe error', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) {
      await deleteDevice(endpoint);
      if (alarmDb[endpoint]) { delete alarmDb[endpoint]; await deleteAlarmRow(endpoint); }
    }
    const { result: total } = await upstash(['HLEN', DEVICES_KEY]);
    res.json({ ok: true, total });
  } catch (err) {
    console.error('unsubscribe error', err);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Admin-only: broadcast a notification to every registered device.
app.post('/api/notify', async (req, res) => {
  try {
    const { adminKey, title, body, url } = req.body;
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Bad admin key' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const devices = Object.entries(await loadDevices());
    const payload = JSON.stringify({ title, body, url: url || '/' });

    const results = await Promise.allSettled(
      devices.map(([, d]) => webpush.sendNotification(d.subscription, payload))
    );

    // Drop devices that are dead (unsubscribed / uninstalled) — one row at a time, nothing else is touched.
    let removed = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected' && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) {
        await deleteDevice(devices[i][0]);
        removed++;
      }
    }

    const sent = results.filter(r => r.status === 'fulfilled').length;
    res.json({ ok: true, sent, total: devices.length, removed });
  } catch (err) {
    console.error('notify error', err);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// =====================================================================================
// ADMIN DRAFTS — unfinished articles and posts, kept privately until they are published.
// Stored in Upstash Redis (not in the public GitHub repo), and only reachable with the admin key.
//   POST /api/drafts/list    { adminKey }          -> { drafts: [...] }
//   POST /api/drafts/save    { adminKey, draft }   -> { ok, id }
//   POST /api/drafts/delete  { adminKey, id }      -> { ok }
// =====================================================================================
const DRAFTS_KEY = 'classx:drafts';
const adminOk = (k) => typeof k === 'string' && k.length > 0 && k === ADMIN_KEY;

app.post('/api/drafts/list', async (req, res) => {
  try {
    if (!adminOk((req.body || {}).adminKey)) return res.status(401).json({ error: 'Bad admin key' });
    const { result } = await upstash(['HGETALL', DRAFTS_KEY]);
    const drafts = [];
    if (Array.isArray(result)) {
      for (let i = 0; i + 1 < result.length; i += 2) { try { drafts.push(JSON.parse(result[i + 1])); } catch { /* skip bad row */ } }
    } else if (result && typeof result === 'object') {
      for (const v of Object.values(result)) { try { drafts.push(JSON.parse(v)); } catch { /* skip */ } }
    }
    drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ ok: true, drafts });
  } catch (err) {
    console.error('drafts list error', err);
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

app.post('/api/drafts/save', async (req, res) => {
  try {
    const { adminKey, draft } = req.body || {};
    if (!adminOk(adminKey)) return res.status(401).json({ error: 'Bad admin key' });
    if (!draft || typeof draft.id !== 'string' || !/^[\w-]{4,60}$/.test(draft.id) || (draft.type !== 'article' && draft.type !== 'post')) {
      return res.status(400).json({ error: 'Invalid draft' });
    }
    const json = JSON.stringify(Object.assign({}, draft, { updatedAt: Date.now() }));
    if (json.length > 450000) return res.status(413).json({ error: 'This draft is too large. Remove some text or pictures.' });
    await upstash(['HSET', DRAFTS_KEY, draft.id, json]);
    res.json({ ok: true, id: draft.id });
  } catch (err) {
    console.error('draft save error', err);
    res.status(500).json({ error: 'Failed to save the draft' });
  }
});

app.post('/api/drafts/delete', async (req, res) => {
  try {
    const { adminKey, id } = req.body || {};
    if (!adminOk(adminKey)) return res.status(401).json({ error: 'Bad admin key' });
    if (typeof id !== 'string' || !/^[\w-]{4,60}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    await upstash(['HDEL', DRAFTS_KEY, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('draft delete error', err);
    res.status(500).json({ error: 'Failed to delete the draft' });
  }
});

// =====================================================================================
// STUDY ALARMS — sent as push notifications at the alarm time (works with the app closed)
// and a silent "Upcoming" status notification that the phone keeps in its notification bar.
// Stored in Upstash Redis as a hash: field = device push endpoint, value = JSON of
//   { subscription, items:[{id,at,title,body}], upcoming:[{at,label}], pin:boolean }
// The list is also kept in memory so the timer never has to ask Redis; Redis is only
// written when something changes and read once when the server wakes up.
// =====================================================================================
const ALARMS_KEY = 'classx:alarms';
let alarmDb = {};
let alarmDbReady = false;
let alarmLoading = null;
let ticking = false;

async function loadAlarms() {
  if (alarmLoading) return alarmLoading;
  alarmLoading = (async () => {
    try {
      const { result } = await upstash(['HGETALL', ALARMS_KEY]);
      const db = {};
      if (Array.isArray(result)) {
        for (let i = 0; i + 1 < result.length; i += 2) {
          try { db[result[i]] = JSON.parse(result[i + 1]); } catch { /* skip bad row */ }
        }
      } else if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
          try { db[k] = JSON.parse(v); } catch { /* skip bad row */ }
        }
      }
      alarmDb = db;
    } catch (err) {
      console.error('alarm load error', err.message);
    }
    alarmDbReady = true;
    alarmLoading = null;
  })();
  return alarmLoading;
}

const saveAlarmRow = (endpoint) =>
  upstash(['HSET', ALARMS_KEY, endpoint, JSON.stringify(alarmDb[endpoint])]).catch((e) => console.error('alarm save error', e.message));
const deleteAlarmRow = (endpoint) =>
  upstash(['HDEL', ALARMS_KEY, endpoint]).catch((e) => console.error('alarm delete error', e.message));

app.post('/api/alarms/sync', async (req, res) => {
  try {
    if (!alarmDbReady) await loadAlarms();
    const { subscription, items, upcoming, pin } = req.body || {};
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || !Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'Invalid request' });
    }
    const clean = items.slice(0, 200)
      .filter((i) => i && typeof i.id === 'string' && Number.isFinite(i.at))
      .map((i) => ({ id: i.id.slice(0, 60), at: i.at, title: String(i.title || 'Alarm').slice(0, 120), body: String(i.body || '').slice(0, 200) }));
    const up = (Array.isArray(upcoming) ? upcoming : []).slice(0, 5)
      .filter((u) => u && Number.isFinite(u.at))
      .map((u) => ({ at: u.at, label: String(u.label || '').slice(0, 80) }));

    const ep = subscription.endpoint;
    await saveDevice(subscription).catch((e) => console.error('device refresh error', e.message));   // every sync also re-registers the device for admin updates
    if (clean.length || (pin && up.length)) {
      alarmDb[ep] = { subscription, items: clean, upcoming: up, pin: !!pin };
      await saveAlarmRow(ep);
    } else if (alarmDb[ep]) {
      delete alarmDb[ep];
      await deleteAlarmRow(ep);
    }
    scheduleNextAlarm();
    res.json({ ok: true, count: clean.length });
  } catch (err) {
    console.error('alarm sync error', err);
    res.status(500).json({ ok: false, error: 'Failed to save alarms' });
  }
});

const sendPush = (sub, payload, opts) => webpush.sendNotification(sub, JSON.stringify(payload), opts);
const isGone = (err) => err && (err.statusCode === 404 || err.statusCode === 410);

async function alarmTick() {
  if (ticking) return;                       // never run two ticks at once (would double-send)
  ticking = true;
  try {
    if (!alarmDbReady) await loadAlarms();
    const now = Date.now();
    for (const endpoint of Object.keys(alarmDb)) {
      const rec = alarmDb[endpoint];
      rec.upcoming = rec.upcoming || [];
      const dueAlarms = rec.items.filter((i) => i.at <= now);
      const taskPassed = rec.pin && rec.upcoming.some((u) => u.at <= now);
      if (!dueAlarms.length && !taskPassed) continue;

      rec.items = rec.items.filter((i) => i.at > now);
      rec.upcoming = rec.upcoming.filter((u) => u.at > now);
      let gone = false;

      for (const i of dueAlarms) {
        if (now - i.at > 10 * 60000) continue;                      // too late to be useful — drop it
        try {
          await sendPush(rec.subscription, { type: 'alarm', title: i.title, body: i.body, tag: 'alarm-' + i.id, url: '' }, { TTL: 600, urgency: 'high' });
        } catch (err) {
          if (isGone(err)) { gone = true; break; }                   // device unsubscribed
          console.error('alarm push error', err.statusCode || err.message);
        }
      }
      if (!gone && rec.pin) {                                       // refresh the always-there "Upcoming" notification
        try { await sendPush(rec.subscription, { type: 'status', upcoming: rec.upcoming.slice(0, 3) }, { TTL: 1800, urgency: 'low' }); }
        catch (err) { if (isGone(err)) gone = true; }
      }

      if (gone || (!rec.items.length && !(rec.pin && rec.upcoming.length))) {
        if (gone) await deleteDevice(endpoint);
        delete alarmDb[endpoint];
        await deleteAlarmRow(endpoint);
      } else {
        await saveAlarmRow(endpoint);
      }
    }
  } catch (err) {
    console.error('alarm tick error', err);
  } finally {
    ticking = false;
  }
}

// exact-time timer for the next event (alarm or task time), plus a 20 s safety poll
let nextAlarmTimer = null;
function scheduleNextAlarm() {
  clearTimeout(nextAlarmTimer);
  let min = Infinity;
  for (const rec of Object.values(alarmDb)) {
    for (const i of rec.items) if (i.at < min) min = i.at;
    if (rec.pin) for (const u of rec.upcoming || []) if (u.at < min) min = u.at;
  }
  if (min === Infinity) return;
  const wait = Math.max(0, Math.min(min - Date.now(), 2147000000));
  nextAlarmTimer = setTimeout(() => alarmTick().then(scheduleNextAlarm), wait);
}
setInterval(() => alarmTick().then(scheduleNextAlarm), 20000);

// Opening this address wakes a sleeping Render server and sends anything that is due.
// Point a free pinger (cron-job.org) at it every 5 minutes so the server stays awake.
app.get('/api/alarms/tick', async (req, res) => {
  await alarmTick();
  scheduleNextAlarm();
  res.json({ ok: true, devices: Object.keys(alarmDb).length });
});

// Registration registry (replaces the Google Apps Script web app) — see registry.js
require('./registry')(app, upstash);

app.listen(PORT, () => {
  console.log(`Class X Drive push backend running on port ${PORT}`);
  migrateLegacyDevices().then(() => loadAlarms()).then(() => alarmTick()).then(scheduleNextAlarm);   // on start / wake-up: load saved alarms and send any that are due
});
