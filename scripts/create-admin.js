'use strict';
// Creates an admin account. Admins can only be made from the server's terminal, never from the web.
// Usage: npm run create-admin -- you@example.com "a-long-password"
// With TURSO_DATABASE_URL set, the admin is saved to Turso too.
const path = require('node:path');
const { openStore } = require('../server/store');
const { createService } = require('../server/service');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password (12+ characters)>');
    process.exit(1);
  }
  const store = await openStore({
    dbPath: process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'),
    tursoUrl: process.env.TURSO_DATABASE_URL, tursoToken: process.env.TURSO_AUTH_TOKEN, log: { log() {}, error: console.error },
  });
  try {
    createService(store.db).createAdmin({ email, password });
    if (store.replicator && !(await store.replicator.settle(20000))) throw new Error('could not save to Turso');
    console.log(`Admin created: ${email.toLowerCase()}. Log in at /admin/`);
  } catch (e) {
    console.error('Could not create admin:', e.message);
    process.exitCode = 1;
  }
  process.exit();
})().catch((e) => { console.error(e.message); process.exit(1); });
