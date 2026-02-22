const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const app = express();
const PORT = 3004;

// ── Credentials ───────────────────────────────────────────────────────────────
const AUTH_USER = process.env.HMS_USER || 'highland';
const AUTH_PASS = process.env.HMS_PASS || 'changeme';

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map();
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function isAuthenticated(req) {
  const token = req.cookies?.hms_session;
  return token && sessions.has(token);
}

// ── Cookie parser ─────────────────────────────────────────────────────────────
function parseCookies(req, res, next) {
  const raw = req.headers.cookie || '';
  req.cookies = {};
  raw.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'mileage.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client     TEXT NOT NULL DEFAULT '',
    date       TEXT DEFAULT '',
    dest       TEXT DEFAULT '',
    route      TEXT DEFAULT '',
    miles      REAL NOT NULL DEFAULT 0,
    trip_type  TEXT NOT NULL DEFAULT 'round',
    trips      INTEGER NOT NULL DEFAULT 1,
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS saved_routes (
    key        TEXT PRIMARY KEY,
    client     TEXT NOT NULL DEFAULT '',
    dest       TEXT DEFAULT '',
    route      TEXT DEFAULT '',
    miles      REAL NOT NULL DEFAULT 0,
    trip_type  TEXT NOT NULL DEFAULT 'round',
    trips      INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

app.use(express.json());
app.use(parseCookies);

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = makeToken();
    sessions.set(token, { user: username, created: Date.now() });
    res.setHeader('Set-Cookie', `hms_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.hms_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'hms_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.use(express.static(__dirname));

// ── Jobs API ──────────────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY date DESC, id DESC').all());
});

app.post('/api/jobs', (req, res) => {
  const { client, date, dest, route, miles, trip_type, trips, notes } = req.body;
  if (!miles || miles <= 0) return res.status(400).json({ error: 'miles required' });
  const r = db.prepare(`
    INSERT INTO jobs (client, date, dest, route, miles, trip_type, trips, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(client||'', date||'', dest||'', route||'', parseFloat(miles), trip_type||'round', parseInt(trips)||1, notes||'');
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid));
});

app.patch('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const allowed = ['client','date','dest','route','miles','trip_type','trips','notes'];
  const updates = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=?`); vals.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE jobs SET ${updates.join(',')} WHERE id=?`).run(...vals);
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id));
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Saved routes API ──────────────────────────────────────────────────────────
app.get('/api/saved-routes', (req, res) => {
  const rows = db.prepare('SELECT * FROM saved_routes ORDER BY client, dest').all();
  const obj = {};
  rows.forEach(r => {
    obj[r.key] = { client: r.client, dest: r.dest, route: r.route, miles: r.miles, tripType: r.trip_type, trips: r.trips };
  });
  res.json(obj);
});

app.post('/api/saved-routes', (req, res) => {
  const { key, client, dest, route, miles, tripType, trips } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  db.prepare(`
    INSERT INTO saved_routes (key, client, dest, route, miles, trip_type, trips, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      client=excluded.client, dest=excluded.dest, route=excluded.route,
      miles=excluded.miles, trip_type=excluded.trip_type, trips=excluded.trips,
      updated_at=datetime('now')
  `).run(key, client||'', dest||'', route||'', parseFloat(miles)||0, tripType||'round', parseInt(trips)||1);
  res.json({ ok: true });
});

app.delete('/api/saved-routes/:key', (req, res) => {
  db.prepare('DELETE FROM saved_routes WHERE key=?').run(decodeURIComponent(req.params.key));
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const year = req.query.year; // optional year filter
  
  let whereClause = '';
  let dateWhereClause = '';
  const params = [];
  
  if (year && /^\d{4}$/.test(year)) {
    whereClause = `WHERE strftime('%Y', date) = ?`;
    dateWhereClause = `AND strftime('%Y', date) = ?`;
    params.push(year);
  }
  
  const totalJobs  = db.prepare(`SELECT COUNT(*) c FROM jobs ${whereClause}`).get(...params).c;
  const totalMiles = db.prepare(`SELECT SUM(miles) s FROM jobs ${whereClause}`).get(...params).s || 0;
  const byClient   = db.prepare(`SELECT client, SUM(miles) miles, COUNT(*) jobs FROM jobs ${whereClause} GROUP BY client ORDER BY miles DESC`).all(...params);
  const byMonth    = db.prepare(`SELECT strftime('%Y-%m', date) month, SUM(miles) miles, COUNT(*) jobs FROM jobs WHERE date != '' ${dateWhereClause} GROUP BY month ORDER BY month`).all(...(year ? [year] : []));
  
  // Available years in the database
  const years = db.prepare(`SELECT DISTINCT strftime('%Y', date) y FROM jobs WHERE date != '' ORDER BY y DESC`).all().map(r => r.y).filter(Boolean);
  
  res.json({ totalJobs, totalMiles, byClient, byMonth, years });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`HMS Mileage on port ${PORT}`));
