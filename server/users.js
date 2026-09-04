/**
 * User management for Beck Auto-Post.
 * A tiny access-code registry backed by Postgres (Railway DATABASE_URL).
 * Each user is { code, name, store, active }. The proxy serves only the
 * store that a user's code maps to. If DATABASE_URL is absent the module
 * stays disabled and the legacy apiKey path keeps working.
 */

const crypto = require('crypto');

let Pool = null;
try { ({ Pool } = require('pg')); } catch (e) { /* pg not installed yet */ }

let pool = null;
let ready = false;
const cache = new Map();          // code -> { user|null, exp }
const CACHE_MS = 60 * 1000;

function hasDb() { return !!process.env.DATABASE_URL && !!Pool; }

function sslFor(cs) {
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(cs || '')) return false;
  return { rejectUnauthorized: false };
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL not set — user management OFF (legacy apiKey access still works).');
    return false;
  }
  if (!Pool) {
    console.warn('⚠️  "pg" module not installed — user management OFF. Run `npm install` on the server.');
    return false;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL, ssl: sslFor(process.env.DATABASE_URL),
    max: 6, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000
  });
  // Managed Postgres drops idle connections; without this listener that surfaces as
  // an unhandled 'error' event and crashes the process (and Railway caps restarts).
  pool.on('error', e => console.error('[pg] idle client error (recovered):', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      store TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER,
      store TEXT,
      event TEXT NOT NULL,
      vin TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events (user_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usage_event_time ON usage_events (event, created_at)');
  ready = true;
  // Keep usage_events bounded: prune old rows daily (USAGE_RETENTION_DAYS, default 180).
  pruneEvents().catch(() => {});
  setInterval(() => pruneEvents().catch(() => {}), 24 * 60 * 60 * 1000).unref();
  console.log('✅ User management ready (Postgres)');
  return true;
}

function isReady() { return ready; }

function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

// Forgiving: ignore case, spaces, dashes — "mvm6 wy5x" == "MVM6-WY5X".
function normalize(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Resolve a code to an active user, or null. Cached briefly. */
async function lookupCode(code) {
  if (!ready) return null;
  const key = normalize(code);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.user;
  const { rows } = await pool.query(
    "SELECT id, name, store, active FROM app_users WHERE upper(replace(code, '-', '')) = $1", [key]
  );
  const row = rows[0];
  const user = (row && row.active) ? { id: row.id, name: row.name, store: row.store } : null;
  // Only cache successful lookups — caching every bogus code would let unlimited
  // guesses grow this Map without bound.
  if (user) cache.set(key, { user, exp: Date.now() + CACHE_MS });
  return user;
}

const RETENTION_DAYS = parseInt(process.env.USAGE_RETENTION_DAYS || '180', 10) || 180;
async function pruneEvents() {
  if (!ready) return;
  const { rowCount } = await pool.query(
    "DELETE FROM usage_events WHERE created_at < now() - ($1 || ' days')::interval", [String(RETENTION_DAYS)]
  );
  if (rowCount) console.log(`[usage] pruned ${rowCount} events older than ${RETENTION_DAYS}d`);
}

function invalidate() { cache.clear(); }

async function listUsers() {
  const { rows } = await pool.query(
    'SELECT id, code, name, store, active, created_at FROM app_users ORDER BY store, name'
  );
  return rows;
}

async function addUser(name, store) {
  name = String(name || '').trim();
  store = String(store || '').trim();
  if (!name || !store) throw new Error('Name and store are required');
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    try {
      const { rows } = await pool.query(
        'INSERT INTO app_users (code, name, store) VALUES ($1, $2, $3) RETURNING id, code, name, store, active, created_at',
        [code, name, store]
      );
      invalidate();
      return rows[0];
    } catch (e) {
      if (!/duplicate key/i.test(e.message)) throw e; // retry only on code collision
    }
  }
  throw new Error('Could not generate a unique code, try again');
}

async function updateUser(id, fields) {
  const sets = [], vals = [];
  if (typeof fields.active === 'boolean') { vals.push(fields.active); sets.push(`active = $${vals.length}`); }
  if (fields.store) { vals.push(String(fields.store).trim()); sets.push(`store = $${vals.length}`); }
  if (fields.name) { vals.push(String(fields.name).trim()); sets.push(`name = $${vals.length}`); }
  if (!sets.length) throw new Error('Nothing to update');
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE app_users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, code, name, store, active, created_at`,
    vals
  );
  invalidate();
  return rows[0];
}

async function removeUser(id) {
  await pool.query('DELETE FROM app_users WHERE id = $1', [id]);
  invalidate();
}

// Record a usage event for a rep. Fire-and-forget — telemetry must never break or
// slow a real request, so this swallows its own errors.
async function logEvent(user, event, vin) {
  if (!ready || !user) return;
  try {
    await pool.query(
      'INSERT INTO usage_events (user_id, store, event, vin) VALUES ($1, $2, $3, $4)',
      [user.id || null, user.store || null, String(event), vin ? String(vin).slice(0, 32) : null]
    );
  } catch (e) { /* never surface telemetry errors */ }
}

// Per-rep usage aggregates for the admin dashboard.
async function usageStats() {
  if (!ready) return [];
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.store, u.active,
      COUNT(*) FILTER (WHERE e.event = 'fill')                                               AS posts,
      COUNT(*) FILTER (WHERE e.event = 'fill' AND e.created_at > now() - interval '7 days')  AS posts_7d,
      COUNT(*) FILTER (WHERE e.event = 'fill' AND e.created_at > now() - interval '30 days') AS posts_30d,
      COUNT(*) FILTER (WHERE e.event = 'description')                                        AS descriptions,
      COUNT(*) FILTER (WHERE e.event = 'view')                                               AS views,
      COUNT(*) FILTER (WHERE e.event = 'login')                                              AS logins,
      MAX(e.created_at)                                                                      AS last_active
    FROM app_users u
    LEFT JOIN usage_events e ON e.user_id = u.id
    GROUP BY u.id, u.name, u.store, u.active
    ORDER BY posts DESC, u.store, u.name
  `);
  return rows;
}

module.exports = { initDb, isReady, hasDb, lookupCode, listUsers, addUser, updateUser, removeUser, logEvent, usageStats };
