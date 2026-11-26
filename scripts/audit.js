'use strict';
// Checks that the ledger is perfectly balanced. Run: npm run audit-ledger
const path = require('node:path');
const { open } = require('../server/db');
const { createService } = require('../server/service');

const db = open(process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'));
const result = createService(db).auditLedger();
if (result.ok) console.log('Ledger OK: every transaction balances and all money is accounted for.');
else { console.error('LEDGER PROBLEMS:\n' + result.problems.join('\n')); process.exitCode = 1; }
