// Class X Drive — push notification backend
// Endpoints:
//   GET  /api/vapid-public-key   -> gives the frontend the public key it needs to subscribe
//   POST /api/subscribe          -> saves a device's push subscription
//   POST /api/unsubscribe        -> removes a device's push subscription
//   POST /api/notify             -> (admin only) sends a notification to every subscribed device
//
// CHANGED FROM THE ORIGINAL: subscriptions used to live in a local file
// (subscriptions.json). On Render's free tier that file gets wiped every
// time the service restarts or redeploys, so all subscribers were silently
// lost — that's why "Sent to 0 of 0 devices" kept showing up. Subscriptions
// are now stored in Upstash Redis (a free, always-on key-value store that
// survives restarts) instead.

const express = require('express');
const webpush = require('web-push');
const path = require('path');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
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

// ---- routes ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const subs = await loadSubscriptions();
    const exists = subs.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      subs.push(subscription);
      await saveSubscriptions(subs);
    }
    res.status(201).json({ ok: true, total: subs.length });
  } catch (err) {
    console.error('subscribe error', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    let subs = await loadSubscriptions();
    subs = subs.filter(s => s.endpoint !== endpoint);
    await saveSubscriptions(subs);
    res.json({ ok: true, total: subs.length });
  } catch (err) {
    console.error('unsubscribe error', err);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Admin-only: broadcast a notification to every subscribed device.
app.post('/api/notify', async (req, res) => {
  try {
    const { adminKey, title, body, url } = req.body;
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Bad admin key' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const subs = await loadSubscriptions();
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
    await saveSubscriptions(stillValid);

    const sent = results.filter(r => r.status === 'fulfilled').length;
    res.json({ ok: true, sent, total: subs.length });
  } catch (err) {
    console.error('notify error', err);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

app.listen(PORT, () => {
  console.log(`Class X Drive push backend running on port ${PORT}`);
});
