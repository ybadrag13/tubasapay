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
  const app = createApp({ db: store.db, replicator: store.replicator, limits: LIMITS });
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
