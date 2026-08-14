import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ============================================================
   Kyzen NextGen — Database layer (SQLite via better-sqlite3)
   Tables:
     keys            — long-lived (until expiry) key records
     claim_sessions  — short-lived (10 min) verification sessions
   ============================================================ */

const DB_PATH = resolve(process.env.DATABASE_URL || "./data/kyzen.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* ---------- Schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  identifier  TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'   -- active | expired
);
CREATE INDEX IF NOT EXISTS idx_keys_identifier ON keys(identifier);
CREATE INDEX IF NOT EXISTS idx_keys_key         ON keys(key);

CREATE TABLE IF NOT EXISTS claim_sessions (
  id          TEXT    PRIMARY KEY,               -- internal session id
  identifier  TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_identifier ON claim_sessions(identifier);
`);

/* ---------- Prepared statements ---------- */
const stmts = {
  insertKey: db.prepare(
    `INSERT INTO keys (key, identifier, createdAt, expiresAt, status)
     VALUES (@key, @identifier, @createdAt, @expiresAt, @status)`
  ),
  findActiveKeyByIdentifier: db.prepare(
    `SELECT * FROM keys WHERE identifier = ? AND status = 'active' ORDER BY expiresAt DESC LIMIT 1`
  ),
  findKeyByKey: db.prepare(`SELECT * FROM keys WHERE key = ?`),

  expireOldKeys: db.prepare(
    `UPDATE keys SET status = 'expired'
     WHERE status = 'active' AND expiresAt <= ?`
  ),

  insertSession: db.prepare(
    `INSERT INTO claim_sessions (id, identifier, createdAt, expiresAt, verified)
     VALUES (@id, @identifier, @createdAt, @expiresAt, @verified)`
  ),
  findSession: db.prepare(`SELECT * FROM claim_sessions WHERE id = ?`),

  findPendingSessionByIdentifier: db.prepare(
    `SELECT * FROM claim_sessions
     WHERE identifier = ?
       AND verified = 0
       AND expiresAt > ?
     ORDER BY createdAt DESC
     LIMIT 1`
  ),

  findVerifiedSessionByIdentifier: db.prepare(
    `SELECT * FROM claim_sessions
     WHERE identifier = ?
       AND verified = 1
       AND expiresAt > ?
     ORDER BY createdAt DESC
     LIMIT 1`
  ),

  markSessionVerified: db.prepare(
    `UPDATE claim_sessions SET verified = 1 WHERE id = ?`
  ),

  deleteSession: db.prepare(
    `DELETE FROM claim_sessions WHERE id = ?`
  ),

  purgeSessions: db.prepare(
    `DELETE FROM claim_sessions WHERE expiresAt <= ?`
  ),

  countKeys: db.prepare(`SELECT COUNT(*) AS c FROM keys`),
  countActiveKeys: db.prepare(`SELECT COUNT(*) AS c FROM keys WHERE status = 'active'`),
  countSessions: db.prepare(`SELECT COUNT(*) AS c FROM claim_sessions`),
};

/* ---------- Helpers ---------- */
const now = () => Date.now();

/** Mark keys past their expiry as expired. */
export function sweepExpiredKeys() {
  const r = stmts.expireOldKeys.run(now());
  return r.changes;
}

/** Delete claim sessions older than their expiry (auto-cleanup ~5 min). */
export function purgeOldSessions() {
  const r = stmts.purgeSessions.run(now());
  return r.changes;
}

/**
 * Return the still-valid key for an identifier, or null.
 * Side effect: if the stored active key is actually past expiry, mark it expired.
 */
export function getActiveKey(identifier) {
  const row = stmts.findActiveKeyByIdentifier.get(identifier);
  if (!row) return null;
  if (row.expiresAt <= now()) {
    stmts.expireOldKeys.run(now());
    return null;
  }
  return row;
}

/** Insert a new key record (24h by default). */
export function createKeyRecord(key, identifier, durationMs = 24 * 60 * 60 * 1000) {
  const t = now();
  stmts.insertKey.run({
    key,
    identifier,
    createdAt: t,
    expiresAt: t + durationMs,
    status: "active",
  });
  return stmts.findKeyByKey.get(key);
}

/** Verify a key string from Roblox. Returns {valid, status, expiresAt?}. */
export function verifyKey(key) {
  if (!key || typeof key !== "string") return { valid: false, status: "invalid" };
  const row = stmts.findKeyByKey.get(key);
  if (!row) return { valid: false, status: "invalid" };
  if (row.expiresAt <= now()) {
    // lazy-expire
    if (row.status === "active") stmts.expireOldKeys.run(now());
    return { valid: false, status: "expired" };
  }
  return { valid: true, status: "active", expiresAt: row.expiresAt };
}

/* ---------- Claim sessions ---------- */
export function createSession(id, identifier, ttlMs = 10 * 60 * 1000) {
  const t = now();
  stmts.insertSession.run({
    id,
    identifier,
    createdAt: t,
    expiresAt: t + ttlMs,
    verified: 0,
  });
  return stmts.findSession.get(id);
}

export function getSession(id) {
  const row = stmts.findSession.get(id);
  if (!row) return null;
  if (row.expiresAt <= now()) return null; // expired session
  return row;
}

export function getPendingSessionByIdentifier(identifier) {
  return stmts.findPendingSessionByIdentifier.get(identifier, now()) || null;
}

export function getVerifiedSessionByIdentifier(identifier) {
  return stmts.findVerifiedSessionByIdentifier.get(identifier, now()) || null;
}

export function markSessionVerified(id) {
  return stmts.markSessionVerified.run(id);
}

export function deleteSession(id) {
  return stmts.deleteSession.run(id);
}

/* ---------- Admin / stats ---------- */
export function stats() {
  sweepExpiredKeys();
  purgeOldSessions();
  return {
    keys_total: stmts.countKeys.get().c,
    keys_active: stmts.countActiveKeys.get().c,
    sessions: stmts.countSessions.get().c,
    time: now(),
  };
}

export function listActiveKeys(limit = 100) {
  return db
    .prepare(`SELECT key, identifier, createdAt, expiresAt, status FROM keys WHERE status='active' ORDER BY expiresAt DESC LIMIT ?`)
    .all(limit);
}

/* Run a periodic sweep every 60s for hygiene */
setInterval(() => {
  try {
    sweepExpiredKeys();
    purgeOldSessions();
  } catch (e) {
    console.error("[db] sweep error:", e.message);
  }
}, 60_000);

export default db;
