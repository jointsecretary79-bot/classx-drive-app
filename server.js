// Class X Drive — push notification backend
// Endpoints:
//   GET  /api/vapid-public-key   -> gives the frontend the public key it needs to subscribe
//   POST /api/subscribe          -> saves a device's push subscription
//   POST /api/unsubscribe        -> removes a device's push subscription
//   POST /api/notify             -> (admin only) sends a notification to every subscribed device

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-now';
const DB_FILE = path.join(__dirname, 'subscriptions.json');

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

// ---- tiny JSON "database" ----
function loadSubscriptions() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSubscriptions(subs) {
  fs.writeFileSync(DB_FILE, JSON.stringify(subs, null, 2));
}

// ---- routes ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const subs = loadSubscriptions();
  const exists = subs.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push(subscription);
    saveSubscriptions(subs);
  }
  res.status(201).json({ ok: true, total: subs.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  let subs = loadSubscriptions();
  subs = subs.filter(s => s.endpoint !== endpoint);
  saveSubscriptions(subs);
  res.json({ ok: true, total: subs.length });
});

// Admin-only: broadcast a notification to every subscribed device.
app.post('/api/notify', async (req, res) => {
  const { adminKey, title, body, url } = req.body;

  if (adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Bad admin key' });
  }
  if (!title || !body) {
    return res.status(400).json({ error: 'title and body are required' });
  }

  const subs = loadSubscriptions();
  const payload = JSON.stringify({
    title,
    body,
    url: url || '/',
  });

  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(sub, payload))
  );

  // Drop subscriptions that are dead (device unsubscribed / uninstalled).
  const stillValid = subs.filter((sub, i) => {
    const r = results[i];
    if (r.status === 'rejected' && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) {
      return false;
    }
    return true;
  });
  saveSubscriptions(stillValid);

  const sent = results.filter(r => r.status === 'fulfilled').length;
  res.json({ ok: true, sent, total: subs.length });
});

app.listen(PORT, () => {
  console.log(`Class X Drive push backend running on port ${PORT}`);
});
