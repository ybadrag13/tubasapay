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

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('platform', 0)`).run();
  db.prepare(`INSERT OR IGNORE INTO accounts (owner_type, owner_id) VALUES ('external', 0)`).run();
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

module.exports = { open, tx };
