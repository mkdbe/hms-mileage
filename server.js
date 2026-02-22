const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const app = express();
const PORT = 3004;

// ── Credentials ───────────────────────────────────────────────────────────────
const AUTH_USER = process.env.HMS_USER || 'mdbe';
const AUTH_PASS = process.env.HMS_PASS || 'picture';

// ── Calendar ICS URL ──────────────────────────────────────────────────────────
const ICS_URL = process.env.HMS_ICS_URL || 'https://calendar.proton.me/api/calendar/v1/url/2mAFhzOO2ORXp6rl5NppYCF9ND3ya90aZ3-G28Uh31IC3njVmM794GD0MGy1qHhlYmDen7EYopDReAL9iiIyaQ==/calendar.ics?CacheKey=AWcT-m9oDsb7I4bS4EKMYQ%3D%3D&PassphraseKey=QCkPPSLa262wz8ce0Im3NC2vavd_K-J4OsCvWVUMrcw%3D';

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

// Pending jobs table — drop and recreate if schema is wrong
try {
  db.prepare('SELECT uid, cal_summary, match_source, status FROM pending_jobs LIMIT 0').run();
} catch (e) {
  console.log('[db] Recreating pending_jobs table...');
  db.exec('DROP TABLE IF EXISTS pending_jobs');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uid           TEXT DEFAULT '',
    cal_summary   TEXT DEFAULT '',
    client        TEXT NOT NULL DEFAULT '',
    date          TEXT DEFAULT '',
    dest          TEXT DEFAULT '',
    route         TEXT DEFAULT '',
    miles         REAL NOT NULL DEFAULT 0,
    trip_type     TEXT NOT NULL DEFAULT 'round',
    trips         INTEGER NOT NULL DEFAULT 1,
    notes         TEXT DEFAULT '',
    match_source  TEXT DEFAULT '',
    status        TEXT DEFAULT 'pending',
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pending_uid ON pending_jobs(uid);
  CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_jobs(status);
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

app.get('/api/clients', (req, res) => {
  const clients = getKnownClients();
  res.json(clients.sort());
});

app.get('/api/stats', (req, res) => {
  const year = req.query.year;
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
  const years = db.prepare(`SELECT DISTINCT strftime('%Y', date) y FROM jobs WHERE date != '' ORDER BY y DESC`).all().map(r => r.y).filter(Boolean);
  res.json({ totalJobs, totalMiles, byClient, byMonth, years });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ICS Calendar Sync & Pending Jobs ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function parseICS(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const ev = {};
    const unfolded = block.replace(/\r?\n[ \t]/g, '');
    for (const line of unfolded.split(/\r?\n/)) {
      const m = line.match(/^([A-Z\-;=]+?):(.*)$/);
      if (!m) continue;
      const key = m[1].split(';')[0];
      const val = m[2];
      if (key === 'SUMMARY') ev.summary = val.trim();
      if (key === 'UID') ev.uid = val.trim();
      if (key === 'DESCRIPTION') ev.description = val.replace(/\\n/g, '\n').replace(/\\,/g, ',').trim();
      if (key === 'LOCATION') ev.location = val.replace(/\\,/g, ',').trim();
      if (key === 'STATUS') ev.status = val.trim();
      if (key === 'DTSTART' || m[1].startsWith('DTSTART')) {
        const dval = val.replace('Z', '');
        if (dval.length >= 8) {
          ev.date = `${dval.slice(0,4)}-${dval.slice(4,6)}-${dval.slice(6,8)}`;
        }
      }
    }
    if (ev.summary && ev.date) events.push(ev);
  }
  return events;
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function getKnownClients() {
  const fromJobs = db.prepare(`SELECT DISTINCT client FROM jobs WHERE client != ''`).all().map(r => r.client);
  const fromRoutes = db.prepare(`SELECT DISTINCT client FROM saved_routes WHERE client != ''`).all().map(r => r.client);
  return [...new Set([...fromJobs, ...fromRoutes])];
}

function getClientMileage() {
  const rows = db.prepare(`
    SELECT client, ROUND(AVG(miles), 1) avg_miles, dest, route, trip_type
    FROM jobs WHERE client != '' AND miles > 0
    GROUP BY client ORDER BY COUNT(*) DESC
  `).all();
  const map = {};
  rows.forEach(r => { map[r.client] = { miles: r.avg_miles, dest: r.dest, route: r.route, tripType: r.trip_type }; });
  return map;
}

function extractClientFromSummary(summary) {
  if (summary.includes(' - ')) return summary.split(' - ')[0].trim();
  if (summary.includes(' – ')) return summary.split(' – ')[0].trim();
  return summary.trim();
}

function matchClient(rawName, knownClients) {
  const raw = normalize(rawName);
  if (!raw) return null;
  for (const kc of knownClients) {
    if (normalize(kc) === raw) return kc;
  }
  const sorted = [...knownClients].sort((a, b) => b.length - a.length);
  for (const kc of sorted) {
    const nkc = normalize(kc);
    if (nkc.length >= 3 && raw.includes(nkc)) return kc;
  }
  for (const kc of sorted) {
    const nkc = normalize(kc);
    if (nkc.length >= 3 && raw.startsWith(nkc)) return kc;
  }
  return null;
}

async function syncCalendar() {
  try {
    console.log('[sync] Fetching calendar...');
    const resp = await fetch(ICS_URL);
    if (!resp.ok) { console.error(`[sync] HTTP ${resp.status}`); return { added: 0, skipped: 0, error: `HTTP ${resp.status}` }; }
    const text = await resp.text();
    const events = parseICS(text);
    console.log(`[sync] Parsed ${events.length} events`);

    const knownClients = getKnownClients();
    const clientMileage = getClientMileage();
    const pendingUids = new Set(db.prepare(`SELECT uid FROM pending_jobs WHERE uid != ''`).all().map(r => r.uid));
    const approvedKeys = new Set(db.prepare(`SELECT date || '|' || client AS k FROM jobs`).all().map(r => r.k));

    const validEvents = events.filter(ev => {
      if (ev.status === 'CANCELLED') return false;
      if (ev.summary && /cancel/i.test(ev.summary)) return false;
      return true;
    });

    let added = 0, skipped = 0;
    const insert = db.prepare(`
      INSERT INTO pending_jobs (uid, cal_summary, client, date, dest, route, miles, trip_type, trips, notes, match_source, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    const insertMany = db.transaction((evts) => {
      for (const ev of evts) {
        if (ev.uid && pendingUids.has(ev.uid)) { skipped++; continue; }
        const rawClient = extractClientFromSummary(ev.summary);
        const matched = matchClient(rawClient, knownClients);
        const clientName = matched || rawClient;
        const jobKey = `${ev.date}|${clientName}`;
        if (approvedKeys.has(jobKey)) { skipped++; continue; }

        let miles = 0, dest = '', route = '', tripType = 'round', matchSource = '';
        if (matched && clientMileage[matched]) {
          const cm = clientMileage[matched];
          miles = cm.miles; dest = cm.dest || ''; route = cm.route || `Office → ${matched}`; tripType = cm.tripType || 'round';
          matchSource = `matched → "${matched}" (avg ${miles} mi)`;
        } else {
          matchSource = matched ? `matched → "${matched}" (no mileage)` : `unmatched: "${rawClient}"`;
          route = `Office → ${rawClient}`;
        }

        let notes = '';
        if (ev.summary.includes(' - ')) notes = ev.summary.split(' - ').slice(1).join(' - ').trim();

        insert.run(ev.uid || '', ev.summary, clientName, ev.date, dest, route, miles, tripType, 1, notes, matchSource);
        added++;
      }
    });

    insertMany(validEvents);
    console.log(`[sync] Added ${added} pending, skipped ${skipped}`);
    return { added, skipped, total: validEvents.length };
  } catch (e) {
    console.error('[sync] Error:', e.message);
    return { added: 0, skipped: 0, error: e.message };
  }
}

// ── Pending Jobs API ──────────────────────────────────────────────────────────
app.get('/api/pending', (req, res) => {
  res.json(db.prepare(`SELECT * FROM pending_jobs WHERE status = 'pending' AND date <= date('now') ORDER BY date DESC, id DESC`).all());
});

app.get('/api/pending/count', (req, res) => {
  res.json({ count: db.prepare(`SELECT COUNT(*) c FROM pending_jobs WHERE status = 'pending' AND date <= date('now')`).get().c });
});

app.patch('/api/pending/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM pending_jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const allowed = ['client','date','dest','route','miles','trip_type','trips','notes'];
  const updates = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=?`); vals.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE pending_jobs SET ${updates.join(',')} WHERE id=?`).run(...vals);
  res.json(db.prepare('SELECT * FROM pending_jobs WHERE id=?').get(req.params.id));
});

app.post('/api/pending/:id/approve', (req, res) => {
  const p = db.prepare(`SELECT * FROM pending_jobs WHERE id=? AND status='pending'`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found or already processed' });
  if (!p.miles || p.miles <= 0) return res.status(400).json({ error: 'Set miles before approving' });
  const r = db.prepare(`INSERT INTO jobs (client, date, dest, route, miles, trip_type, trips, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.client, p.date, p.dest, p.route, p.miles, p.trip_type, p.trips, p.notes);
  db.prepare(`UPDATE pending_jobs SET status='approved' WHERE id=?`).run(p.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid));
});

app.post('/api/pending/approve-all', (req, res) => {
  const pending = db.prepare(`SELECT * FROM pending_jobs WHERE status='pending' AND miles > 0 AND date <= date('now')`).all();
  const insertJob = db.prepare(`INSERT INTO jobs (client, date, dest, route, miles, trip_type, trips, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const markApproved = db.prepare(`UPDATE pending_jobs SET status='approved' WHERE id=?`);
  db.transaction(() => {
    for (const p of pending) {
      insertJob.run(p.client, p.date, p.dest, p.route, p.miles, p.trip_type, p.trips, p.notes);
      markApproved.run(p.id);
    }
  })();
  res.json({ approved: pending.length });
});

app.post('/api/pending/:id/dismiss', (req, res) => {
  const p = db.prepare(`SELECT * FROM pending_jobs WHERE id=? AND status='pending'`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found or already processed' });
  db.prepare(`UPDATE pending_jobs SET status='dismissed' WHERE id=?`).run(p.id);
  res.json({ ok: true });
});

app.post('/api/pending/dismiss-all', (req, res) => {
  const r = db.prepare(`UPDATE pending_jobs SET status='dismissed' WHERE status='pending'`).run();
  res.json({ dismissed: r.changes });
});

app.post('/api/sync', async (req, res) => {
  const result = await syncCalendar();
  res.json(result);
});

// Auto-sync every 4 hours, first sync 30s after start
setInterval(() => { syncCalendar(); }, 4 * 60 * 60 * 1000);
setTimeout(() => { syncCalendar(); }, 30 * 1000);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`HMS Mileage on port ${PORT}`));
