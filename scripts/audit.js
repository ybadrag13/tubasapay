'use strict';
// Checks that the ledger is perfectly balanced. Run: npm run audit-ledger
// With TURSO_DATABASE_URL set, it audits the permanent copy in Turso.
const path = require('node:path');
const { openStore } = require('../server/store');
const { createService } = require('../server/service');

(async () => {
  const store = await openStore({
    dbPath: process.env.TURSO_DATABASE_URL ? ':memory:' : (process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db')),
    tursoUrl: process.env.TURSO_DATABASE_URL, tursoToken: process.env.TURSO_AUTH_TOKEN, log: { log() {}, error: console.error },
  });
  const result = createService(store.db).auditLedger();
  if (result.ok) console.log('Ledger OK: every transaction balances and all money is accounted for.');
  else { console.error('LEDGER PROBLEMS:\n' + result.problems.join('\n')); process.exitCode = 1; }
  process.exit();
})().catch((e) => { console.error('Audit failed:', e.message); process.exit(1); });
