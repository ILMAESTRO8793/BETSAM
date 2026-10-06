// BETSAM — servidor (Express + Postgres)
// Clientes ven el parlay del día solo con suscripción activa.
// Pagos por Yappy: el cliente paga, envía su número de confirmación + captura,
// y el administrador aprueba desde el panel.

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool, types } = require('pg');
types.setTypeParser(1082, (v) => v); // DATE como texto YYYY-MM-DD (evita desfases de zona horaria)
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'BETSAM';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TZ = 'America/Panama';

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET no está definido: las sesiones se cerrarán en cada reinicio.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (text, params) => pool.query(text, params);

// ---------- utilidades ----------
const todayPanama = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const cleanPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^507/, '');

const refCode = () => 'BS' + crypto.randomBytes(3).toString('hex').toUpperCase();

function publicUser(u) {
  if (!u) return null;
  const active = !!u.sub_until && new Date(u.sub_until) > new Date();
  return { id: u.id, name: u.name, phone: u.phone, is_admin: u.is_admin, sub_until: u.sub_until, active: active || u.is_admin };
}

// ---------- base de datos ----------
async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      sub_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      days INT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INT REFERENCES plans(id) ON DELETE SET NULL,
      plan_name TEXT,
      days INT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      ref_code TEXT NOT NULL,
      yappy_tx TEXT,
      proof TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS parlays (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      title TEXT NOT NULL,
      legs JSONB NOT NULL DEFAULT '[]',
      total_odds TEXT,
      stake TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS parlays_day_idx ON parlays(day);
    CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
  `);

  const { rows } = await q('SELECT COUNT(*)::int AS n FROM plans');
  if (rows[0].n === 0) {
    await q(`INSERT INTO plans (name, days, price, sort) VALUES
      ('Semanal', 7, 10.00, 1), ('Mensual', 30, 30.00, 2)`);
  }
  const defaults = {
    yappy_handle: '',     // ej. @samgers  (Directorio Yappy)
    yappy_phone: '',      // ej. 6000-0000
    yappy_name: '',       // nombre que verá el cliente en Yappy
    whatsapp: '',         // número para avisar del pago
    disclaimer: 'Solo para mayores de 18 años. Los pronósticos no garantizan ganancias. Apuesta con responsabilidad.',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }

  if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
    const phone = cleanPhone(process.env.ADMIN_PHONE);
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await q(
      `INSERT INTO users (name, phone, password_hash, is_admin) VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (phone) DO UPDATE SET is_admin = TRUE, password_hash = EXCLUDED.password_hash`,
      [process.env.ADMIN_NAME || 'Admin', phone, hash]
    );
  }
}

async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '60d' });
  res.cookie('sp_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 24 * 3600 * 1000,
  });
}

async function loadUser(req, _res, next) {
  req.user = null;
  const t = req.cookies.sp_session;
  if (t) {
    try {
      const { uid } = jwt.verify(t, JWT_SECRET);
      const { rows } = await q('SELECT * FROM users WHERE id=$1', [uid]);
      req.user = rows[0] || null;
    } catch (_) { /* sesión inválida */ }
  }
  next();
}
app.use('/api', loadUser);

const needAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Inicia sesión para continuar.' }));
const needAdmin = (req, res, next) => (req.user?.is_admin ? next() : res.status(403).json({ error: 'Solo el administrador puede hacer esto.' }));
const isActive = (u) => !!u && (u.is_admin || (u.sub_until && new Date(u.sub_until) > new Date()));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// límite simple de intentos de inicio de sesión
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  a.push(now);
  attempts.set(key, a);
  return a.length > 10;
}

// ---------- auth ----------
app.post('/api/register', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = cleanPhone(req.body.phone);
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre.' });
  if (phone.length < 7 || phone.length > 12) return res.status(400).json({ error: 'Escribe un número de celular válido.' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const exists = await q('SELECT 1 FROM users WHERE phone=$1', [phone]);
  if (exists.rowCount) return res.status(409).json({ error: 'Ese número ya tiene una cuenta. Inicia sesión.' });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q('INSERT INTO users (name, phone, password_hash) VALUES ($1,$2,$3) RETURNING *', [name, phone, hash]);
  setSession(res, rows[0]);
  res.json({ user: publicUser(rows[0]) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  if (tooMany(req.ip + phone)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const { rows } = await q('SELECT * FROM users WHERE phone=$1', [phone]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    return res.status(401).json({ error: 'Número o contraseña incorrectos.' });
  }
  setSession(res, u);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', (_req, res) => {
  res.clearCookie('sp_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- público ----------
app.get('/api/config', wrap(async (_req, res) => {
  const s = await getSettings();
  const { rows: plans } = await q('SELECT id, name, days, price FROM plans WHERE active ORDER BY sort, id');
  res.json({
    app_name: APP_NAME,
    today: todayPanama(),
    plans,
    yappy: { handle: s.yappy_handle, phone: s.yappy_phone, name: s.yappy_name },
    whatsapp: s.whatsapp,
    disclaimer: s.disclaimer,
  });
}));

app.get('/api/parlays/today', wrap(async (req, res) => {
  const day = todayPanama();
  const { rows } = await q('SELECT * FROM parlays WHERE day=$1 ORDER BY id', [day]);
  if (isActive(req.user)) return res.json({ day, locked: false, parlays: rows });
  // sin suscripción: solo un adelanto sin las selecciones
  res.json({
    day,
    locked: true,
    parlays: rows.map((p) => ({ id: p.id, title: p.title, legs_count: p.legs.length || String(p.notes || '').split('\n').filter((l) => l.trim()).length, status: p.status })),
  });
}));

app.get('/api/parlays/history', wrap(async (_req, res) => {
  const { rows } = await q(
    `SELECT id, day, title, legs, total_odds, status FROM parlays
     WHERE status <> 'pending' AND day >= (NOW() AT TIME ZONE $1)::date - INTERVAL '45 days'
     ORDER BY day DESC, id DESC`, [TZ]);
  const won = rows.filter((r) => r.status === 'won').length;
  const lost = rows.filter((r) => r.status === 'lost').length;
  res.json({ parlays: rows, stats: { won, lost } });
}));

// ---------- pagos del cliente ----------
app.get('/api/payments/mine', needAuth, wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT id, plan_name, days, amount, ref_code, yappy_tx, status, note, created_at FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 20',
    [req.user.id]);
  res.json({ payments: rows });
}));

app.post('/api/payments', needAuth, wrap(async (req, res) => {
  const planId = parseInt(req.body.plan_id, 10);
  const yappyTx = String(req.body.yappy_tx || '').trim().slice(0, 60);
  const proof = typeof req.body.proof === 'string' ? req.body.proof : null;
  const { rows: pr } = await q('SELECT * FROM plans WHERE id=$1 AND active', [planId]);
  const plan = pr[0];
  if (!plan) return res.status(400).json({ error: 'Elige un plan.' });
  if (yappyTx.length < 4) return res.status(400).json({ error: 'Escribe el número de confirmación que te dio Yappy.' });
  if (proof && (!proof.startsWith('data:image/') || proof.length > 3_000_000)) {
    return res.status(400).json({ error: 'La captura debe ser una imagen de menos de 2 MB.' });
  }
  const pending = await q("SELECT 1 FROM payments WHERE user_id=$1 AND status='pending'", [req.user.id]);
  if (pending.rowCount) return res.status(409).json({ error: 'Ya tienes un pago en revisión. Te activamos en cuanto lo confirmemos.' });
  const dup = await q("SELECT 1 FROM payments WHERE yappy_tx=$1 AND status<>'rejected'", [yappyTx]);
  if (dup.rowCount) return res.status(409).json({ error: 'Ese número de confirmación ya fue usado.' });
  const ref = String(req.body.ref_code || refCode()).slice(0, 12);
  const { rows } = await q(
    `INSERT INTO payments (user_id, plan_id, plan_name, days, amount, ref_code, yappy_tx, proof)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, ref_code, status`,
    [req.user.id, plan.id, plan.name, plan.days, plan.price, ref, yappyTx, proof]);
  res.json({ payment: rows[0] });
}));

// ---------- administración ----------
const admin = express.Router();
admin.use(needAuth, needAdmin);

admin.get('/summary', wrap(async (_req, res) => {
  const [p, a, t] = await Promise.all([
    q("SELECT COUNT(*)::int n FROM payments WHERE status='pending'"),
    q('SELECT COUNT(*)::int n FROM users WHERE sub_until > NOW() AND NOT is_admin'),
    q("SELECT COALESCE(SUM(amount),0)::float n FROM payments WHERE status='approved' AND reviewed_at >= date_trunc('month', NOW())"),
  ]);
  res.json({ pending: p.rows[0].n, active: a.rows[0].n, month_income: t.rows[0].n });
}));

admin.get('/payments', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await q(
    `SELECT p.*, u.name AS user_name, u.phone AS user_phone FROM payments p
     JOIN users u ON u.id = p.user_id WHERE p.status=$1 ORDER BY p.id DESC LIMIT 100`, [status]);
  res.json({ payments: rows });
}));

admin.post('/payments/:id/approve', wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT * FROM payments WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]);
    const pay = rows[0];
    if (!pay) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ese pago ya fue revisado.' }); }
    await client.query(
      `UPDATE users SET sub_until = GREATEST(COALESCE(sub_until, NOW()), NOW()) + ($1 || ' days')::interval WHERE id=$2`,
      [String(pay.days), pay.user_id]);
    await client.query("UPDATE payments SET status='approved', reviewed_at=NOW() WHERE id=$1", [pay.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}));

admin.post('/payments/:id/reject', wrap(async (req, res) => {
  const note = String(req.body.note || '').slice(0, 200);
  const r = await q("UPDATE payments SET status='rejected', note=$1, reviewed_at=NOW() WHERE id=$2 AND status='pending'", [note, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Ese pago ya fue revisado.' });
  res.json({ ok: true });
}));

admin.get('/users', wrap(async (_req, res) => {
  const { rows } = await q('SELECT id, name, phone, is_admin, sub_until, created_at FROM users ORDER BY sub_until DESC NULLS LAST, id DESC LIMIT 500');
  res.json({ users: rows });
}));

admin.post('/users/:id/days', wrap(async (req, res) => {
  const days = parseInt(req.body.days, 10);
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 366) return res.status(400).json({ error: 'Días inválidos.' });
  if (days > 0) {
    await q(`UPDATE users SET sub_until = GREATEST(COALESCE(sub_until, NOW()), NOW()) + ($1 || ' days')::interval WHERE id=$2`, [String(days), req.params.id]);
  } else {
    await q(`UPDATE users SET sub_until = sub_until + ($1 || ' days')::interval WHERE id=$2`, [String(days), req.params.id]);
  }
  res.json({ ok: true });
}));

admin.post('/users/:id/revoke', wrap(async (req, res) => {
  await q('UPDATE users SET sub_until = NULL WHERE id=$1 AND NOT is_admin', [req.params.id]);
  res.json({ ok: true });
}));

admin.get('/parlays', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM parlays ORDER BY day DESC, id DESC LIMIT 60');
  res.json({ parlays: rows, today: todayPanama() });
}));

function parseParlay(b) {
  const legs = Array.isArray(b.legs) ? b.legs.slice(0, 20).map((l) => ({
    sport: String(l.sport || '').slice(0, 40),
    match: String(l.match || '').slice(0, 120),
    pick: String(l.pick || '').slice(0, 120),
    odds: String(l.odds || '').slice(0, 12),
    time: String(l.time || '').slice(0, 20),
  })).filter((l) => l.match && l.pick) : [];
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : todayPanama(),
    title: String(b.title || 'Parlay del día').slice(0, 80),
    legs,
    total_odds: String(b.total_odds || '').slice(0, 20),
    stake: String(b.stake || '').slice(0, 60),
    notes: String(b.notes || '').slice(0, 4000),
  };
}

admin.post('/parlays', wrap(async (req, res) => {
  const p = parseParlay(req.body);
  if (!p.legs.length && !p.notes.trim()) return res.status(400).json({ error: 'Escribe el parlay antes de publicar.' });
  const { rows } = await q(
    'INSERT INTO parlays (day, title, legs, total_odds, stake, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [p.day, p.title, JSON.stringify(p.legs), p.total_odds, p.stake, p.notes]);
  res.json({ parlay: rows[0] });
}));

admin.put('/parlays/:id', wrap(async (req, res) => {
  const p = parseParlay(req.body);
  if (!p.legs.length && !p.notes.trim()) return res.status(400).json({ error: 'Escribe el parlay antes de publicar.' });
  const { rows } = await q(
    'UPDATE parlays SET day=$1, title=$2, legs=$3, total_odds=$4, stake=$5, notes=$6 WHERE id=$7 RETURNING *',
    [p.day, p.title, JSON.stringify(p.legs), p.total_odds, p.stake, p.notes, req.params.id]);
  res.json({ parlay: rows[0] });
}));

admin.post('/parlays/:id/result', wrap(async (req, res) => {
  const status = String(req.body.status);
  if (!['pending', 'won', 'lost', 'void'].includes(status)) return res.status(400).json({ error: 'Resultado inválido.' });
  await q('UPDATE parlays SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
}));

admin.delete('/parlays/:id', wrap(async (req, res) => {
  await q('DELETE FROM parlays WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

admin.get('/settings', wrap(async (_req, res) => {
  const s = await getSettings();
  const { rows: plans } = await q('SELECT * FROM plans ORDER BY sort, id');
  res.json({ settings: s, plans });
}));

admin.put('/settings', wrap(async (req, res) => {
  const allowed = ['yappy_handle', 'yappy_phone', 'yappy_name', 'whatsapp', 'disclaimer'];
  for (const k of allowed) {
    if (k in req.body) await q('UPDATE settings SET value=$1 WHERE key=$2', [String(req.body[k]).slice(0, 400), k]);
  }
  if (Array.isArray(req.body.plans)) {
    for (const [i, p] of req.body.plans.entries()) {
      const name = String(p.name || '').trim().slice(0, 40);
      const days = parseInt(p.days, 10);
      const price = parseFloat(p.price);
      if (!name || !(days > 0) || !(price >= 0)) continue;
      if (p.id) {
        await q('UPDATE plans SET name=$1, days=$2, price=$3, active=$4, sort=$5 WHERE id=$6', [name, days, price, p.active !== false, i, p.id]);
      } else {
        await q('INSERT INTO plans (name, days, price, active, sort) VALUES ($1,$2,$3,$4,$5)', [name, days, price, p.active !== false, i]);
      }
    }
  }
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

// ---------- estáticos ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Algo falló en el servidor. Intenta de nuevo.' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`${APP_NAME} escuchando en el puerto ${PORT}`)))
  .catch((e) => { console.error('Error al preparar la base de datos', e); process.exit(1); });
