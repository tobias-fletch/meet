/**
 * meet-api — self-hosted replacement for the old Google-Calendar-backed auth-server.
 *
 * The existing frontend bundle (prebuilt, no source) speaks a fixed protocol:
 *   GET /api/get-auth-url            -> { authUrl }          (browser is redirected there)
 *   GET /api/token/:code            -> { access_token }     (code comes from ?code= in the URL)
 *   GET /api/get-events/:token      -> { events: [...] }    (Google-Calendar-v3-shaped items)
 *   GET /api/tokeninfo?access_token -> {}                   (frontend validates the token on every load;
 *                                                           any `error` field sends it back to login)
 *
 * This server implements that protocol against a self-managed MongoDB event
 * collection — no Google OAuth, no Google Calendar, no API keys from Google.
 *
 * Admin CRUD (x-admin-key header must match ADMIN_KEY):
 *   GET    /api/events
 *   POST   /api/events        { summary, description, location, start: {dateTime}, end: {dateTime} }
 *   DELETE /api/events/:id
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://tobias-fletch.github.io/meet';
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'meet';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const LOCAL_TOKEN = 'meet-local-token';

if (!MONGODB_URI) {
  console.error('Missing required environment variable: MONGODB_URI');
  process.exit(1);
}

// --- Model (shaped like the Google Calendar v3 items the frontend renders) ---
const eventSchema = new mongoose.Schema(
  {
    summary: { type: String, required: true },
    description: String,
    location: String,
    start: { dateTime: String },
    end: { dateTime: String },
    htmlLink: String,
  },
  { timestamps: true }
);
const Event = mongoose.model('Event', eventSchema);

const toPublic = (e) => ({
  id: String(e._id),
  summary: e.summary,
  description: e.description || '',
  location: e.location || '',
  start: { dateTime: (e.start && e.start.dateTime) || '' },
  end: { dateTime: (e.end && e.end.dateTime) || '' },
  htmlLink: e.htmlLink || '',
});

async function ensureSeed() {
  if ((await Event.countDocuments()) > 0) return;
  const day = 864e5;
  const now = Date.now();
  await Event.insertMany([
    {
      summary: 'Sample: Community Hack Night',
      description: 'Sample event — replace me with a real one via the admin API.',
      location: 'Main Hall',
      start: { dateTime: new Date(now + 3 * day).toISOString() },
      end: { dateTime: new Date(now + 3 * day + 2 * 36e5).toISOString() },
    },
    {
      summary: 'Sample: Weekend Build Workshop',
      description: 'Sample event — replace me with a real one via the admin API.',
      location: 'Room 2',
      start: { dateTime: new Date(now + 10 * day).toISOString() },
      end: { dateTime: new Date(now + 10 * day + 3 * 36e5).toISOString() },
    },
  ]);
  console.log('Seeded sample events (delete them via the admin API when ready).');
}

// --- Frontend compatibility layer (no Google) ---
app.get('/api/get-auth-url', (req, res) => {
  // "Log in" just bounces the browser back to the app with a code.
  res.json({ authUrl: `${FRONTEND_URL}/?code=meet-local` });
});

app.get('/api/token/:code', (req, res) => {
  res.json({ access_token: LOCAL_TOKEN });
});

// The bundle validates the token against Google's tokeninfo on every load.
// This endpoint replaces that call (the bundle's URL is patched to point here).
// Absence of an `error` field = valid token.
app.get('/api/tokeninfo', (req, res) => {
  if (req.query.access_token === LOCAL_TOKEN) return res.json({});
  res.json({ error: 'invalid_token' });
});

app.get('/api/get-events/:token', async (req, res) => {
  if (req.params.token !== LOCAL_TOKEN) return res.status(401).json({ error: 'invalid token' });
  const events = await Event.find().sort({ 'start.dateTime': 1 }).lean();
  res.json({ events: events.map(toPublic) });
});

// --- Admin CRUD ---
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized: missing or wrong x-admin-key' });
  }
  next();
}

app.get('/api/events', requireAdmin, async (req, res) => {
  res.json((await Event.find().sort({ 'start.dateTime': 1 }).lean()).map(toPublic));
});

app.post('/api/events', requireAdmin, async (req, res) => {
  const ev = await Event.create(req.body);
  res.status(201).json(toPublic(ev.toObject()));
});

app.delete('/api/events/:id', requireAdmin, async (req, res) => {
  await Event.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('meet-api is running (no Google involved).'));

const PORT = process.env.PORT || 8080;
mongoose
  .connect(MONGODB_URI, { dbName: MONGODB_DB })
  .then(() => ensureSeed())
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`meet-api listening on ${PORT}`)))
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
