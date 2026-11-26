'use strict';
// Database layer: SQLite (built into Node 22, no dependencies).
// Money is always stored as whole yen in INTEGER columns. Never floats.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  phone         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  pass_hash     TEXT    NOT NULL,
  pin_hash      TEXT    NOT NULL,
  pin_fails     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS merchants (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  shop_name     TEXT    NOT NULL,
  pass_hash     TEXT    NOT NULL,
  store_code    TEXT    NOT NULL UNIQUE,
  fee_bps       INTEGER NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  created_at    INTEGER NOT NULL
);

-- Every holder of money has exactly one account.
-- 'external' represents the outside banking world (top-ups come from it,
-- payouts go to it), so it is the only account allowed to go negative.
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY,
  owner_type  TEXT    NOT NULL CHECK (owner_type IN ('user','merchant','platform','external')),
  owner_id    INTEGER NOT NULL,
  balance     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_type, owner_id),
  CHECK (owner_type = 'external' OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('user','merchant')),
  subject_id  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- One-time payment codes shown as barcode/QR. Only the SHA-256 hash is
-- stored, so a database leak does not reveal usable codes.
CREATE TABLE IF NOT EXISTS pay_codes (
  code_hash   TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_codes_user ON pay_codes(user_id, created_at);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT    PRIMARY KEY,
  type            TEXT    NOT NULL CHECK (type IN ('topup','payment','refund','payout')),
  method          TEXT    CHECK (method IN ('cpm','mpm')),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  fee             INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  user_id         INTEGER REFERENCES users(id),
  merchant_id     INTEGER REFERENCES merchants(id),
  ref_tx          TEXT    REFERENCES transactions(id),
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  refunded_fee    INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
  CHECK (refunded_fee >= 0 AND refunded_fee <= fee)
);
CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS tx_merchant ON transactions(merchant_id, created_at);

-- Double-entry ledger: the deltas of every transaction sum to zero.
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY,
  tx_id       TEXT    NOT NULL REFERENCES transactions(id),
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  delta       INTEGER NOT NULL CHECK (delta <> 0)
);
CREATE INDEX IF NOT EXISTS entries_tx ON entries(tx_id);

-- Stores the first response for a client-supplied Idempotency-Key so a
-- retried request (bad network, double tap) never charges twice.
CREATE TABLE IF NOT EXISTS idempotency (
  scope       TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  fp          TEXT    NOT NULL,
  status      INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

// ---------- migrations ----------
// Each step upgrades the database by one version, inside a transaction.
// Existing data is always kept. PRAGMA user_version records the version.
const MIGRATIONS = {
  // v2: staff accounts, admins, transfers, account freezing, receipts.
  2: `
    ALTER TABLE users ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN frozen_reason TEXT;
    ALTER TABLE merchants ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE merchants ADD COLUMN frozen_reason TEXT;

    CREATE TABLE staff (
      id            INTEGER PRIMARY KEY,
      merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
      name          TEXT    NOT NULL,
      username      TEXT    NOT NULL,
      pass_hash     TEXT    NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      UNIQUE (merchant_id, username)
    );

    CREATE TABLE admins (
      id          INTEGER PRIMARY KEY,
      email       TEXT    NOT NULL UNIQUE,
      pass_hash   TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE admin_log (
      id          INTEGER PRIMARY KEY,
      admin_id    INTEGER NOT NULL REFERENCES admins(id),
      action      TEXT    NOT NULL,
      target_type TEXT    NOT NULL,
      target_id   INTEGER NOT NULL,
      reason      TEXT,
      created_at  INTEGER NOT NULL
    );

    -- Sessions gain admins and staff. Old sessions are dropped (everyone logs in again once).
    DROP TABLE sessions;
    CREATE TABLE sessions (
      token_hash  TEXT    PRIMARY KEY,
      kind        TEXT    NOT NULL CHECK (kind IN ('user','merchant','admin')),
      subject_id  INTEGER NOT NULL,
      staff_id    INTEGER REFERENCES staff(id),
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX sessions_staff ON sessions(staff_id);

    -- Rebuild transactions to allow the new 'transfer' type, the receiver, and the cashier.
    CREATE TABLE transactions_v2 (
      id              TEXT    PRIMARY KEY,
      type            TEXT    NOT NULL CHECK (type IN ('topup','payment','refund','payout','transfer')),
      method          TEXT    CHECK (method IN ('cpm','mpm')),
      amount          INTEGER NOT NULL CHECK (amount > 0),
      fee             INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
      user_id         INTEGER REFERENCES users(id),
      to_user_id      INTEGER REFERENCES users(id),
      merchant_id     INTEGER REFERENCES merchants(id),
      staff_id        INTEGER REFERENCES staff(id),
      ref_tx          TEXT    REFERENCES transactions_v2(id),
      refunded_amount INTEGER NOT NULL DEFAULT 0,
      refunded_fee    INTEGER NOT NULL DEFAULT 0,
      note            TEXT,
      created_at      INTEGER NOT NULL,
      CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
      CHECK (refunded_fee >= 0 AND refunded_fee <= fee)
    );
    INSERT INTO transactions_v2 (id, type, method, amount, fee, user_id, merchant_id, ref_tx,
                                 refunded_amount, refunded_fee, note, created_at)
      SELECT id, type, method, amount, fee, user_id, merchant_id, ref_tx,
             refunded_amount, refunded_fee, note, created_at FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_v2 RENAME TO transactions;
    CREATE INDEX tx_user ON transactions(user_id, created_at);
    CREATE INDEX tx_to_user ON transactions(to_user_id, created_at);
    CREATE INDEX tx_merchant ON transactions(merchant_id, created_at);
    CREATE INDEX tx_created ON transactions(created_at);
  `,
};
const LATEST = Math.max(...Object.keys(MIGRATIONS).map(Number));

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version || 1;
  if (version >= LATEST) return;
  // Table rebuilds need foreign-key checks off; they are verified again afterwards.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    while (version < LATEST) {
      const next = version + 1;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[next]);
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) throw new Error(`Migration to v${next} broke ${bad.length} references`);
        db.exec(`PRAGMA user_version = ${next}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`Database migration to v${next} failed, nothing was changed: ${e.message}`);
      }
      version = next;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function open(dbPath, { migrate: doMigrate = true } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('platform', 0)`).run();
  db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('external', 0)`).run();
  if (doMigrate) migrate(db);
  return db;
}

// Runs fn inside one write transaction. Any throw rolls everything back,
// so money can never be half-moved.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, tx, LATEST };
