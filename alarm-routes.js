// alarm-routes.js — add to your Render backend (classx-drive-app).
//
// In your main server file (after `app` is created, express.json() and cors are set up, and web-push
// is configured with your VAPID keys), add:
//
//     require('./alarm-routes')(app, webpush);
//
// What it does:
//   POST /api/alarms/sync   { subscription, items:[{id,at,title,body}], pin, upcoming:[{at,label}] }
//        -> replaces what is stored for that device:
//             items    = alarms to push at their time (rings even when the app is closed)
//             upcoming = the next tasks, used to keep the "Upcoming" notification in the phone's
//                        notification bar fresh after each alarm / when a task time passes
//   GET  /api/alarms/tick   -> sends anything that is due (also runs by itself)
//
// IMPORTANT (Render): a free web service sleeps after ~15 minutes without traffic, and a sleeping
// server cannot send anything. Either use a paid instance, or add a free pinger (e.g. cron-job.org)
// that opens  https://classx-drive-app.onrender.com/api/alarms/tick  every 5 minutes. The list is kept
// in alarms.json; on Render's free plan that file is wiped on every redeploy/restart, so for reliable
// alarms store it in your database instead (see STORE below).

const fs = require('fs');
const path = require('path');
const FILE = path.join(process.env.DATA_DIR || __dirname, 'alarms.json');

module.exports = function mountAlarmRoutes(app, webpush) {
  // ---- STORE: replace these with your database if you have one ----
  let db = {};   // { [endpoint]: { subscription, items:[...], upcoming:[...], pin:boolean } }
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  const persist = () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} };
  // -----------------------------------------------------------------

  app.post('/api/alarms/sync', (req, res) => {
    const { subscription, items, upcoming, pin } = req.body || {};
    if (!subscription || !subscription.endpoint || !Array.isArray(items)) return res.status(400).json({ ok: false });
    const clean = items.slice(0, 200)
      .filter((i) => i && typeof i.id === 'string' && Number.isFinite(i.at))
      .map((i) => ({ id: i.id.slice(0, 60), at: i.at, title: String(i.title || 'Alarm').slice(0, 120), body: String(i.body || '').slice(0, 200) }));
    const up = (Array.isArray(upcoming) ? upcoming : []).slice(0, 5)
      .filter((u) => u && Number.isFinite(u.at))
      .map((u) => ({ at: u.at, label: String(u.label || '').slice(0, 80) }));
    if (clean.length || (pin && up.length)) db[subscription.endpoint] = { subscription, items: clean, upcoming: up, pin: !!pin };
    else delete db[subscription.endpoint];
    persist();
    scheduleNext();
    res.json({ ok: true, count: clean.length });
  });

  const send = (sub, payload, opts) => webpush.sendNotification(sub, JSON.stringify(payload), opts);

  async function tick() {
    const now = Date.now();
    let changed = false;
    for (const endpoint of Object.keys(db)) {
      const rec = db[endpoint];
      rec.upcoming = rec.upcoming || [];
      const dueAlarms = rec.items.filter((i) => i.at <= now);
      const taskPassed = rec.pin && rec.upcoming.some((u) => u.at <= now);
      if (!dueAlarms.length && !taskPassed) continue;

      rec.items = rec.items.filter((i) => i.at > now);
      rec.upcoming = rec.upcoming.filter((u) => u.at > now);
      changed = true;
      let gone = false;

      for (const i of dueAlarms) {
        if (now - i.at > 10 * 60000) continue;                      // too late to be useful — drop it
        try {
          await send(rec.subscription, { type: 'alarm', title: i.title, body: i.body, tag: 'alarm-' + i.id, url: '' }, { TTL: 600, urgency: 'high' });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) { gone = true; break; }   // device unsubscribed
        }
      }
      if (!gone && rec.pin) {                                       // refresh the always-there "Upcoming" notification
        try { await send(rec.subscription, { type: 'status', upcoming: rec.upcoming.slice(0, 3) }, { TTL: 1800, urgency: 'low' }); }
        catch (err) { if (err.statusCode === 404 || err.statusCode === 410) gone = true; }
      }
      if (gone || (!rec.items.length && !(rec.pin && rec.upcoming.length))) delete db[endpoint];
    }
    if (changed) persist();
  }

  // exact-time timer for the next event (alarm or task time), plus a 20 s safety poll
  let nextTimer = null;
  function scheduleNext() {
    clearTimeout(nextTimer);
    let min = Infinity;
    for (const rec of Object.values(db)) {
      for (const i of rec.items) if (i.at < min) min = i.at;
      if (rec.pin) for (const u of rec.upcoming || []) if (u.at < min) min = u.at;
    }
    if (min === Infinity) return;
    const wait = Math.max(0, Math.min(min - Date.now(), 2147000000));
    nextTimer = setTimeout(() => tick().catch(() => {}).then(scheduleNext), wait);
  }
  setInterval(() => tick().catch(() => {}).then(scheduleNext), 20000);
  scheduleNext();

  app.get('/api/alarms/tick', async (req, res) => { await tick().catch(() => {}); scheduleNext(); res.json({ ok: true }); });
};
