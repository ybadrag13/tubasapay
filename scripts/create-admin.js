'use strict';
// Creates an admin account. Admins can only be made from the server's terminal, never from the web.
// Usage: npm run create-admin -- you@example.com "a-long-password"
const path = require('node:path');
const { open } = require('../server/db');
const { createService } = require('../server/service');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run create-admin -- <email> <password (12+ characters)>');
  process.exit(1);
}
const db = open(process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'));
try {
  createService(db).createAdmin({ email, password });
  console.log(`Admin created: ${email.toLowerCase()}. Log in at /admin/`);
} catch (e) {
  console.error('Could not create admin:', e.message);
  process.exitCode = 1;
}
