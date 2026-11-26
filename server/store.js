'use strict';
// Permanent storage through Turso (hosted SQLite), with zero dependencies.
//
// How it works:
//   - TsubuPay keeps running on a local SQLite file, so every money rule and
//     race-condition guarantee stays exactly as tested.
//   - Every committed write is copied, in order and inside one remote
//     transaction, to Turso over its HTTP API ("Hrana over HTTP", /v2/pipeline).
//   - On start, the local database is rebuilt from Turso before any request is served.
//   - Write requests wait until Turso has confirmed, so a restart or sleep loses nothing.
// Without TURSO_DATABASE_URL the app runs purely locally, as before.

const { open } = require('./db');

// ---------------- Turso HTTP client ----------------
function encode(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}

function decode(v) {
  switch (v.type) {
    case 'null': return null;
    case 'integer': return Number(v.value);
    case 'float': return Number(v.value);
    case 'text': return v.value;
    case 'blob': return Buffer.from(v.base64, 'base64');
    default: throw new Error(`Unknown value type from Turso: ${v.type}`);
  }
}

class Turso {
  constructor(url, token, { timeoutMs = 15000 } = {}) {
    if (!url) throw new Error('TURSO_DATABASE_URL is empty');
    this.base = String(url).trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async pipeline(requests) {
    const res = await fetch(this.base + '/v2/pipeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check TURSO_AUTH_TOKEN)' : res.status === 404 ? ' (check TURSO_DATABASE_URL)' : '';
      throw new Error(`Turso HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
    }
    const body = JSON.parse(text);
    for (const r of body.results) if (r.type === 'error') throw new Error(`Turso: ${r.error?.message || 'request failed'}`);
    return body.results.map((r) => r.response);
  }

  static rows(result) {
    const names = result.cols.map((c) => c.name);
    return result.rows.map((row) => Object.fromEntries(row.map((v, i) => [names[i], decode(v)])));
  }

  async query(sql, args = []) {
    const [resp] = await this.pipeline([{ type: 'execute', stmt: { sql, args: args.map(encode) } }]);
    return Turso.rows(resp.result);
  }

  // All statements succeed together or none do.
  async transaction(stmts) {
    const steps = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }];
    for (const s of stmts) steps.push({ stmt: { sql: s.sql, args: (s.args || []).map(encode) }, condition: { type: 'ok', step: steps.length - 1 } });
    const commit = steps.length;
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: commit - 1 } });
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: commit } } });
    const [resp] = await this.pipeline([{ type: 'batch', batch: { steps } }]);
    const { step_results: results, step_errors: errors } = resp.result;
    const firstErr = errors.findIndex((e) => e);
    if (firstErr !== -1) {
      const what = firstErr === 0 ? 'BEGIN' : firstErr === commit ? 'COMMIT' : stmts[firstErr - 1]?.sql;
      throw new Error(`Turso rejected ${what}: ${errors[firstErr].message}`);
    }
    if (!results[commit]) throw new Error('Turso did not commit the transaction');
  }
}

// ---------------- replication queue ----------------
class Replicator {
  constructor(turso, { maxBatch = 100, log = console } = {}) {
    this.turso = turso; this.maxBatch = maxBatch; this.log = log;
    this.queue = []; this.enqueued = 0; this.committed = 0;
    this.waiters = []; this.running = false; this.lastError = null; this.lastOkAt = null;
  }

  enqueue(stmts) {
    this.queue.push(stmts);
    this.enqueued++;
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    let delay = 500;
    while (this.queue.length) {
      // Several local transactions are sent as one remote transaction, in order.
      const take = this.queue.slice(0, this.maxBatch);
      try {
        await this.turso.transaction(take.flat());
        this.queue.splice(0, take.length);
        this.committed += take.length;
        this.lastOkAt = Date.now(); this.lastError = null; delay = 500;
        this.wake();
      } catch (e) {
        this.lastError = e.message;
        this.log.error(`[tsubupay] Turso sync failed, retrying in ${delay} ms: ${e.message}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
    this.running = false;
  }

  wake() {
    this.waiters = this.waiters.filter((w) => { if (this.committed >= w.target) { w.resolve(true); return false; } return true; });
  }

  // Resolves true once everything written so far is safely in Turso (false on timeout).
  settle(timeoutMs = 10000) {
    const target = this.enqueued;
    if (this.committed >= target) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { target, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); }, timeoutMs).unref();
    });
  }

  status() {
    return { mode: 'turso', pending: this.queue.length, synced: this.queue.length === 0, lastError: this.lastError, lastOkAt: this.lastOkAt };
  }
}

// Wraps the local database so committed writes are queued for Turso.
// Statements that changed nothing (e.g. INSERT OR IGNORE that ignored) are skipped.
function replicating(db, rep) {
  let buffer = null;
  const record = (sql, args) => { if (buffer) buffer.push({ sql, args }); else rep.enqueue([{ sql, args }]); };
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        run: (...args) => { const r = st.run(...args); if (Number(r.changes) > 0) record(sql, args); return r; },
        get: (...args) => st.get(...args),
        all: (...args) => st.all(...args),
      };
    },
    exec(sql) {
      const head = sql.trim().toUpperCase();
      db.exec(sql);
      if (head.startsWith('BEGIN')) buffer = [];
      else if (head === 'COMMIT') { const b = buffer; buffer = null; if (b && b.length) rep.enqueue(b); }
      else if (head === 'ROLLBACK') buffer = null;
    },
    close: () => db.close(),
    raw: db,
  };
}

// ---------------- start-up: schema + restore ----------------
const qid = (name) => '"' + String(name).replace(/"/g, '""') + '"';

async function restoreFromTurso(db, turso, log = console) {
  await turso.pipeline([{ type: 'execute', stmt: { sql: 'CREATE TABLE IF NOT EXISTS tsubu_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)' } }]);
  const meta = await turso.query(`SELECT value FROM tsubu_meta WHERE key = 'schema_version'`);
  const localVersion = db.prepare('PRAGMA user_version').get().user_version;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all().map((r) => r.name);

  if (!meta.length) {
    // Brand-new Turso database: copy the exact local schema and the starting rows.
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
                            ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid`).all();
    const stmts = ddl.map((r) => ({ sql: r.sql }));
    for (const t of tables) {
      for (const row of db.prepare(`SELECT * FROM ${qid(t)}`).all()) {
        const cols = Object.keys(row);
        stmts.push({ sql: `INSERT INTO ${qid(t)} (${cols.map(qid).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, args: cols.map((c) => row[c]) });
      }
    }
    stmts.push({ sql: `INSERT INTO tsubu_meta (key, value) VALUES ('schema_version', ?)`, args: [String(localVersion)] });
    await turso.transaction(stmts);
    log.log(`[tsubupay] Turso database initialised (schema v${localVersion}).`);
    return { restoredRows: 0, fresh: true };
  }

  const remoteVersion = Number(meta[0].value);
  if (remoteVersion !== localVersion)
    throw new Error(`Turso database is at schema v${remoteVersion} but this code expects v${localVersion}. Upgrade both together.`);

  // Rebuild the local database from Turso, table by table, in pages.
  let total = 0;
  const copied = [];
  for (const t of tables) {
    const rows = [];
    for (let offset = 0; ; offset += 2000) {
      const page = await turso.query(`SELECT * FROM ${qid(t)} ORDER BY rowid LIMIT 2000 OFFSET ${offset}`);
      rows.push(...page);
      if (page.length < 2000) break;
    }
    copied.push([t, rows]);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [t, rows] of copied) {
      db.prepare(`DELETE FROM ${qid(t)}`).run();
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${qid(t)} (${cols.map(qid).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      }
      total += rows.length;
    }
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`restored data has ${bad.length} broken references`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  log.log(`[tsubupay] Restored ${total} rows from Turso.`);
  return { restoredRows: total, fresh: false };
}

// Opens the database the app should use: plain local SQLite, or local + Turso.
async function openStore({ dbPath, tursoUrl, tursoToken, log = console } = {}) {
  const raw = open(dbPath);
  if (!tursoUrl) return { db: raw, replicator: null, status: () => ({ mode: 'local', synced: true }) };
  const turso = new Turso(tursoUrl, tursoToken);
  await restoreFromTurso(raw, turso, log);
  const replicator = new Replicator(turso, { log });
  return { db: replicating(raw, replicator), replicator, turso, status: () => replicator.status() };
}

module.exports = { Turso, Replicator, replicating, restoreFromTurso, openStore, encode, decode };
