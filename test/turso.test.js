'use strict';
// Permanent storage: data written through one server must survive a full restart
// onto an empty disk (exactly what happens when Render's free server sleeps).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server');
const { openStore, Turso } = require('../server/store');
const { createService } = require('../server/service');
const { startFakeTurso } = require('./fake-turso');

const quiet = { log() {}, error() {} };
const LIMITS = { login: 1000, register: 1000, chargeFail: 1000, lookup: 1000, adminLogin: 1000 };

async function boot(fake, token = fake.token) {
  const store = await openStore({ dbPath: ':memory:', tursoUrl: fake.url, tursoToken: token, log: quiet });
  const app = createApp({ db: store.db, replicator: store.replicator, turso: store.turso, limits: LIMITS, service: { requireKyc: false, requirePhoneOtp: false } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  app.store = store;
  return app;
}

function client(app) {
  const jar = {};
  const req = async (method, p, body) => {
    const h = { 'x-tsubu-client': '1' };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(app.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), jar, useApp(a) { app = a; } };
}

const remoteAudit = (fake) => createService(fake.db).auditLedger();

test('data survives a full restart onto an empty disk', async () => {
  const fake = await startFakeTurso();
  let app = await boot(fake);
  const alice = client(app), bob = client(app), shop = client(app);

  await alice.post('/api/user/register', { phone: '09011112222', name: 'Alice', password: 'password123', pin: '2580' });
  await bob.post('/api/user/register', { phone: '08033334444', name: 'Bob', password: 'password123', pin: '2580' });
  const s = (await shop.post('/api/shop/register', { email: 'cafe@example.com', shopName: 'Cafe', password: 'password123' })).body;
  await shop.post('/api/shop/staff', { name: 'Aki', username: 'aki', password: 'cashier123' });
  await alice.post('/api/user/topup', { amount: 10000 });
  const code = (await alice.post('/api/user/paycode')).body.code;
  const pay = (await shop.post('/api/shop/charge', { code, amount: 1500 })).body;
  await shop.post('/api/shop/refund', { txId: pay.id, amount: 500 });
  await alice.post('/api/user/transfer', { toPhone: '08033334444', amount: 2000, pin: '2580', message: 'Lunch' });
  app.svc.createAdmin({ email: 'boss@tsubupay.example', password: 'admin-password-1' });
  assert.ok(await app.replicator.settle(5000), 'everything reached Turso');
  assert.deepEqual(remoteAudit(fake).problems, []);
  await new Promise((r) => app.server.close(r));

  // A completely new server with an empty local database.
  app = await boot(fake);
  for (const c of [alice, bob, shop]) c.useApp(app);
  // Sessions survive too: no need to log in again.
  assert.equal((await alice.get('/api/user/me')).body.balance, 10000 - 1500 + 500 - 2000);
  assert.equal((await bob.get('/api/user/me')).body.balance, 2000);
  const me = (await shop.get('/api/shop/me')).body;
  assert.equal(me.storeCode, s.storeCode);
  assert.equal(me.balance, (1500 - 29) - (500 - 9)); // fee 29, 9 returned with the refund
  assert.equal((await shop.get('/api/shop/staff')).body.items[0].username, 'aki');
  const hist = (await alice.get('/api/user/history')).body.items.map((t) => t.type);
  assert.deepEqual(hist, ['transfer', 'refund', 'payment', 'topup']);
  const admin = client(app);
  assert.equal((await admin.post('/api/admin/login', { email: 'boss@tsubupay.example', password: 'admin-password-1' })).status, 200);
  assert.equal((await admin.get('/api/admin/overview')).body.storage.mode, 'turso');
  assert.deepEqual(app.svc.auditLedger().problems, []);

  // New activity after the restart keeps working and is saved too.
  const code2 = (await alice.post('/api/user/paycode')).body.code;
  assert.equal((await shop.post('/api/shop/charge', { code: code2, amount: 100 })).status, 200);
  assert.deepEqual(remoteAudit(fake).problems, []);
  await new Promise((r) => app.server.close(r));
  await fake.close();
});

test('failed writes are not copied; Turso stays identical to the app', async () => {
  const fake = await startFakeTurso();
  const app = await boot(fake);
  const u = client(app), s = client(app);
  await u.post('/api/user/register', { phone: '09055556666', name: 'Ken', password: 'password123', pin: '2580' });
  await s.post('/api/shop/register', { email: 'k@shop.co', shopName: 'K', password: 'password123' });
  await u.post('/api/user/topup', { amount: 300 });
  const code = (await u.post('/api/user/paycode')).body.code;
  assert.equal((await s.post('/api/shop/charge', { code, amount: 999 })).status, 402); // rolled back locally
  assert.equal((await u.post('/api/user/pay', { storeCode: 'ZZZZZZZZ', amount: 1, pin: '0000' })).status, 401); // wrong PIN is saved
  await app.replicator.settle(5000);
  const remote = createService(fake.db);
  assert.equal(fake.db.prepare(`SELECT COUNT(*) n FROM transactions`).get().n, 1); // only the top-up
  assert.equal(fake.db.prepare(`SELECT pin_fails FROM users WHERE phone = '09055556666'`).get().pin_fails, 1);
  assert.deepEqual(remote.auditLedger().problems, []);
  await new Promise((r) => app.server.close(r));
  await fake.close();
});

test('Turso outage: the app keeps retrying and catches up in order', async () => {
  const fake = await startFakeTurso();
  const app = await boot(fake);
  const u = client(app);
  await u.post('/api/user/register', { phone: '09077778888', name: 'Mei', password: 'password123', pin: '2580' });
  fake.failNext = 3; // Turso is down for the next 3 requests
  const t0 = Date.now();
  const r = await u.post('/api/user/topup', { amount: 1234 });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 >= 1000, 'the reply waited until Turso confirmed');
  assert.equal(app.replicator.status().pending, 0);
  assert.equal(fake.db.prepare(`SELECT balance FROM accounts WHERE owner_type = 'user'`).get().balance, 1234);
  await new Promise((r) => app.server.close(r));
  await fake.close();
});

test('a wrong token or URL stops the server from starting, with a clear message', async () => {
  const fake = await startFakeTurso();
  await assert.rejects(openStore({ dbPath: ':memory:', tursoUrl: fake.url, tursoToken: 'wrong', log: quiet }), /401.*TURSO_AUTH_TOKEN/);
  await assert.rejects(openStore({ dbPath: ':memory:', tursoUrl: fake.url + '/nope', tursoToken: fake.token, log: quiet }), /404.*TURSO_DATABASE_URL/);
  await fake.close();
});

test('libsql:// URLs are converted to https://', () => {
  assert.equal(new Turso('libsql://tsubupay-ybadrag13.aws-ap-northeast-1.turso.io', 't').base, 'https://tsubupay-ybadrag13.aws-ap-northeast-1.turso.io');
});

test('KYC photos survive a restart through Turso (binary data)', async () => {
  const fake = await startFakeTurso();
  const boot2 = async () => {
    const store = await openStore({ dbPath: ':memory:', tursoUrl: fake.url, tursoToken: fake.token, log: quiet });
    const a = createApp({ db: store.db, replicator: store.replicator, limits: { ...LIMITS, otp: 1000 } });
    await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
    a.base = `http://127.0.0.1:${a.server.address().port}`;
    return a;
  };
  let app = await boot2();
  const u = client(app);
  const o = (await u.post('/api/user/otp', { phone: '09012121212' })).body;
  await u.post('/api/user/register', { phone: '09012121212', otp: o.demoCode, name: 'Hana', password: 'password123', pin: '2580' });
  await u.post('/api/user/kyc/challenge');
  const selfie = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))]);
  const front = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 7)]);
  const sub = await u.post('/api/user/kyc', { docType: 'passport', legalName: 'Sato Hana', birthDate: '1999-09-09', address: 'Osaka 1-1',
    docNumber: 'TZ1234567', docFront: 'data:image/png;base64,' + front.toString('base64'), selfie: selfie.toString('base64') });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  await app.replicator.settle(5000);
  await new Promise((r) => app.server.close(r));

  app = await boot2(); // empty disk again
  const img = app.svc.adminKycImage(sub.body.id, 'selfie');
  assert.ok(img.buf.equals(selfie), 'selfie bytes identical after restore');
  assert.ok(app.svc.adminKycImage(sub.body.id, 'front').buf.equals(front));
  assert.equal(app.svc.kycInfo('user', 1).status, 'pending');
  await new Promise((r) => app.server.close(r));
  await fake.close();
});

test('an older Turso database (v2) is upgraded to the new version on start, keeping data', async () => {
  const { open, MIGRATIONS } = require('../server/db');
  const { restoreFromTurso } = require('../server/store');
  const fake = await startFakeTurso();
  // Build a v2 database and push it to the fake Turso, like the live site today.
  const v2 = open(':memory:', { migrate: false });
  v2.exec('PRAGMA foreign_keys = OFF'); v2.exec(MIGRATIONS[2]); v2.exec('PRAGMA user_version = 2'); v2.exec('PRAGMA foreign_keys = ON');
  v2.prepare(`INSERT INTO users (phone, name, pass_hash, pin_hash, created_at) VALUES ('09000000009', 'Old', 'x', 'y', 1)`).run();
  v2.prepare(`INSERT INTO accounts (owner_type, owner_id, balance) VALUES ('user', 1, 0)`).run();
  await restoreFromTurso(v2, new Turso(fake.url, fake.token), quiet);
  assert.equal(fake.db.prepare(`SELECT value FROM tsubu_meta`).get().value, '2');

  const store = await openStore({ dbPath: ':memory:', tursoUrl: fake.url, tursoToken: fake.token, log: quiet });
  assert.equal(fake.db.prepare(`SELECT value FROM tsubu_meta`).get().value, '3');
  assert.ok(fake.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'kyc_submissions'`).get());
  assert.equal(store.db.prepare(`SELECT kyc_status FROM users WHERE phone = '09000000009'`).get().kyc_status, 'none');
  await fake.close();
});

test('deep health check touches Turso (keeps a free database active) and reports outages', async () => {
  const fake = await startFakeTurso();
  const app = await boot(fake);
  const before = fake.requests;
  const r = await (await fetch(app.base + '/api/health?deep=1')).json();
  assert.equal(r.turso.ok, true);
  assert.ok(fake.requests > before, 'Turso was contacted');
  const again = fake.requests;
  await fetch(app.base + '/api/health?deep=1'); // cached for 5 minutes: no extra Turso call
  assert.equal(fake.requests, again);
  assert.equal((await (await fetch(app.base + '/api/health')).json()).turso, undefined); // plain health stays local
  await new Promise((r2) => app.server.close(r2));
  await fake.close();
});
