import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ============================================================
   Kyzen NextGen — Database layer

   Tables:
     keys
       - long-lived 24h keys

     claim_sessions
       - temporary Link4m verification sessions
       - 10 minute TTL
       - identified by browser identifier
   ============================================================ */

const DB_PATH = resolve(
  process.env.DATABASE_URL ||
  "./data/kyzen.db"
);

mkdirSync(
  dirname(DB_PATH),
  { recursive: true }
);

const db =
  new Database(DB_PATH);

db.pragma(
  "journal_mode = WAL"
);

/* ============================================================
   SCHEMA
   ============================================================ */

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  identifier  TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS
idx_keys_identifier
ON keys(identifier);

CREATE INDEX IF NOT EXISTS
idx_keys_key
ON keys(key);


CREATE TABLE IF NOT EXISTS claim_sessions (
  id          TEXT    PRIMARY KEY,
  identifier  TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS
idx_sessions_identifier
ON claim_sessions(identifier);

CREATE INDEX IF NOT EXISTS
idx_sessions_identifier_verified
ON claim_sessions(identifier, verified);
`);

/* ============================================================
   PREPARED STATEMENTS
   ============================================================ */

const stmts = {

  /* ---------- KEYS ---------- */

  insertKey:
    db.prepare(`
      INSERT INTO keys (
        key,
        identifier,
        createdAt,
        expiresAt,
        status
      )
      VALUES (
        @key,
        @identifier,
        @createdAt,
        @expiresAt,
        @status
      )
    `),

  findActiveKeyByIdentifier:
    db.prepare(`
      SELECT *
      FROM keys
      WHERE identifier = ?
        AND status = 'active'
      ORDER BY expiresAt DESC
      LIMIT 1
    `),

  findKeyByKey:
    db.prepare(`
      SELECT *
      FROM keys
      WHERE key = ?
    `),

  expireOldKeys:
    db.prepare(`
      UPDATE keys
      SET status = 'expired'
      WHERE status = 'active'
        AND expiresAt <= ?
    `),

  /* ---------- SESSIONS ---------- */

  insertSession:
    db.prepare(`
      INSERT INTO claim_sessions (
        id,
        identifier,
        createdAt,
        expiresAt,
        verified
      )
      VALUES (
        @id,
        @identifier,
        @createdAt,
        @expiresAt,
        @verified
      )
    `),

  findSession:
    db.prepare(`
      SELECT *
      FROM claim_sessions
      WHERE id = ?
    `),

  findPendingSessionByIdentifier:
    db.prepare(`
      SELECT *
      FROM claim_sessions
      WHERE identifier = ?
        AND verified = 0
        AND expiresAt > ?
      ORDER BY createdAt DESC
      LIMIT 1
    `),

  findVerifiedSessionByIdentifier:
    db.prepare(`
      SELECT *
      FROM claim_sessions
      WHERE identifier = ?
        AND verified = 1
        AND expiresAt > ?
      ORDER BY createdAt DESC
      LIMIT 1
    `),

  markSessionVerified:
    db.prepare(`
      UPDATE claim_sessions
      SET verified = 1
      WHERE id = ?
    `),

  deleteSession:
    db.prepare(`
      DELETE FROM claim_sessions
      WHERE id = ?
    `),

  purgeSessions:
    db.prepare(`
      DELETE FROM claim_sessions
      WHERE expiresAt <= ?
    `),

  /* ---------- STATS ---------- */

  countKeys:
    db.prepare(`
      SELECT COUNT(*) AS c
      FROM keys
    `),

  countActiveKeys:
    db.prepare(`
      SELECT COUNT(*) AS c
      FROM keys
      WHERE status = 'active'
    `),

  countSessions:
    db.prepare(`
      SELECT COUNT(*) AS c
      FROM claim_sessions
    `),
};

/* ============================================================
   TIME
   ============================================================ */

const now = () =>
  Date.now();

/* ============================================================
   EXPIRED KEYS
   ============================================================ */

export function sweepExpiredKeys() {
  const r =
    stmts.expireOldKeys.run(
      now()
    );

  return r.changes;
}

/* ============================================================
   EXPIRED SESSIONS
   ============================================================ */

export function purgeOldSessions() {
  const r =
    stmts.purgeSessions.run(
      now()
    );

  return r.changes;
}

/* ============================================================
   ACTIVE KEY
   ============================================================ */

export function getActiveKey(
  identifier
) {
  const row =
    stmts
      .findActiveKeyByIdentifier
      .get(identifier);

  if (!row) {
    return null;
  }

  if (
    row.expiresAt <=
    now()
  ) {
    stmts.expireOldKeys.run(
      now()
    );

    return null;
  }

  return row;
}

/* ============================================================
   CREATE KEY
   ============================================================ */

export function createKeyRecord(
  key,
  identifier,
  durationMs =
    24 * 60 * 60 * 1000
) {
  const t =
    now();

  stmts.insertKey.run({
    key,
    identifier,
    createdAt: t,
    expiresAt:
      t + durationMs,
    status:
      "active",
  });

  return stmts
    .findKeyByKey
    .get(key);
}

/* ============================================================
   VERIFY KEY
   ============================================================ */

export function verifyKey(
  key
) {
  if (
    !key ||
    typeof key !==
      "string"
  ) {
    return {
      valid: false,
      status: "invalid",
    };
  }

  const row =
    stmts
      .findKeyByKey
      .get(key);

  if (!row) {
    return {
      valid: false,
      status: "invalid",
    };
  }

  if (
    row.expiresAt <=
    now()
  ) {
    if (
      row.status ===
      "active"
    ) {
      stmts.expireOldKeys.run(
        now()
      );
    }

    return {
      valid: false,
      status: "expired",
    };
  }

  return {
    valid: true,
    status: "active",
    expiresAt:
      row.expiresAt,
  };
}

/* ============================================================
   CREATE SESSION
   ============================================================ */

export function createSession(
  id,
  identifier,
  ttlMs =
    10 * 60 * 1000
) {
  const t =
    now();

  stmts.insertSession.run({
    id,
    identifier,
    createdAt: t,
    expiresAt:
      t + ttlMs,
    verified: 0,
  });

  return stmts
    .findSession
    .get(id);
}

/* ============================================================
   GET SESSION BY ID
   ============================================================ */

export function getSession(
  id
) {
  const row =
    stmts
      .findSession
      .get(id);

  if (!row) {
    return null;
  }

  if (
    row.expiresAt <=
    now()
  ) {
    return null;
  }

  return row;
}

/* ============================================================
   GET PENDING SESSION BY IDENTIFIER
   ============================================================ */

export function getPendingSessionByIdentifier(
  identifier
) {
  return (
    stmts
      .findPendingSessionByIdentifier
      .get(
        identifier,
        now()
      ) ||
    null
  );
}

/* ============================================================
   GET VERIFIED SESSION BY IDENTIFIER
   ============================================================ */

export function getVerifiedSessionByIdentifier(
  identifier
) {
  return (
    stmts
      .findVerifiedSessionByIdentifier
      .get(
        identifier,
        now()
      ) ||
    null
  );
}

/* ============================================================
   MARK VERIFIED
   ============================================================ */

export function markSessionVerified(
  id
) {
  return stmts
    .markSessionVerified
    .run(id);
}

/* ============================================================
   DELETE SESSION
   ============================================================ */

export function deleteSession(
  id
) {
  return stmts
    .deleteSession
    .run(id);
}

/* ============================================================
   STATS
   ============================================================ */

export function stats() {
  sweepExpiredKeys();
  purgeOldSessions();

  return {
    keys_total:
      stmts.countKeys
        .get()
        .c,

    keys_active:
      stmts.countActiveKeys
        .get()
        .c,

    sessions:
      stmts.countSessions
        .get()
        .c,

    time:
      now(),
  };
}

/* ============================================================
   LIST ACTIVE KEYS
   ============================================================ */

export function listActiveKeys(
  limit = 100
) {
  return db
    .prepare(`
      SELECT
        key,
        identifier,
        createdAt,
        expiresAt,
        status
      FROM keys
      WHERE status = 'active'
      ORDER BY expiresAt DESC
      LIMIT ?
    `)
    .all(limit);
}

/* ============================================================
   PERIODIC CLEANUP
   ============================================================ */

setInterval(
  () => {
    try {
      sweepExpiredKeys();
      purgeOldSessions();
    } catch (e) {
      console.error(
        "[db] sweep error:",
        e.message
      );
    }
  },
  60_000
);

/* ============================================================
   EXPORT
   ============================================================ */

export default db;
