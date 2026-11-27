'use strict';
// Tests for staff accounts, transfers, admin, receipts and the database migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');
const { open } = require('../server/db');

let app, base;
test.before(async () => {
  app = createApp({ dbPath: ':memory:', service: { requireKyc: false, requirePhoneOtp: false }, limits: { login: 1000, register: 1000, chargeFail: 1000, lookup: 1000, adminLogin: 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.server.close());

class Client {
  constructor() { this.jar = {}; }
  async req(method, p, body, headers = {}) {
    const h = { 'x-tsubu-client': '1', ...headers };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) this.jar[kv.slice(0, i)] = v; else delete this.jar[kv.slice(0, i)];
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
}

let n = 0;
async function newUser(balance = 0) {
  const c = new Client();
  c.phone = '070' + String(10000000 + ++n).slice(-8);
  const r = await c.post('/api/user/register', { phone: c.phone, name: `Friend ${n}`, password: 'password123', pin: '2580' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.id = r.body.id;
  if (balance) assert.equal((await c.post('/api/user/topup', { amount: balance })).status, 200);
  return c;
}
async function newShop() {
  const c = new Client();
  const r = await c.post('/api/shop/register', { email: `owner${++n}@example.com`, shopName: `Cafe ${n}`, password: 'password123' });
  assert.equal(r.status, 200);
  c.storeCode = r.body.storeCode; c.id = r.body.id;
  return c;
}
async function newCashier(owner, username = 'aki' + (++n)) {
  assert.equal((await owner.post('/api/shop/staff', { name: 'Aki', username, password: 'cashier123' })).status, 200);
  const c = new Client();
  const r = await c.post('/api/shop/staff-login', { storeCode: owner.storeCode, username, password: 'cashier123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.username = username;
  return c;
}
const code = async (u) => (await u.post('/api/user/paycode')).body.code;
const bal = async (c, kind) => (await c.get(`/api/${kind}/me`)).body.balance;

// ===================== staff =====================
test('staff: cashier can charge, payment records who served', async () => {
  const owner = await newShop(), cashier = await newCashier(owner), u = await newUser(3000);
  const me = (await cashier.get('/api/shop/me')).body;
  assert.equal(me.role, 'cashier');
  assert.equal(me.balance, undefined); // cashiers never see the shop balance
  const r = await cashier.post('/api/shop/charge', { code: await code(u), amount: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cashier, 'Aki');
  assert.equal(r.body.net, undefined); // cashiers never see the shop's takings
  assert.equal(r.body.fee, undefined);
  const owned = await owner.post('/api/shop/charge', { code: await code(u), amount: 100 });
  assert.equal(owned.body.cashier, 'Owner');
});

test('staff: cashier cannot refund, pay out, or manage staff', async () => {
  const owner = await newShop(), cashier = await newCashier(owner), u = await newUser(3000);
  const p = (await cashier.post('/api/shop/charge', { code: await code(u), amount: 500 })).body;
  for (const [path, body] of [['/api/shop/refund', { txId: p.id }], ['/api/shop/payout', {}],
    ['/api/shop/staff', { name: 'X', username: 'xxx', password: 'password123' }], ['/api/shop/staff/active', { staffId: 1, active: false }]]) {
    const r = await cashier.post(path, body);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error.code, 'OWNER_ONLY');
  }
  assert.equal((await cashier.get('/api/shop/staff')).status, 403);
  // cashier history hides payouts and fees
  const h = (await cashier.get('/api/shop/history')).body.items;
  assert.equal(h[0].fee, undefined);
  assert.equal((await owner.post('/api/shop/refund', { txId: p.id })).status, 200);
});

test('staff: deactivating logs the cashier out at once; wrong shop or password refused', async () => {
  const owner = await newShop(), cashier = await newCashier(owner, 'hana');
  const list = (await owner.get('/api/shop/staff')).body.items;
  const hana = list.find((s) => s.username === 'hana');
  assert.equal((await owner.post('/api/shop/staff/active', { staffId: hana.id, active: false })).status, 200);
  assert.equal((await cashier.get('/api/shop/me')).status, 401);
  const again = new Client();
  assert.equal((await again.post('/api/shop/staff-login', { storeCode: owner.storeCode, username: 'hana', password: 'cashier123' })).status, 401);
  const other = await newShop();
  assert.equal((await again.post('/api/shop/staff-login', { storeCode: other.storeCode, username: 'hana', password: 'cashier123' })).status, 401);
  // an owner cannot touch another shop's staff
  assert.equal((await other.post('/api/shop/staff/active', { staffId: hana.id, active: true })).status, 404);
  // reactivate + reset password
  assert.equal((await owner.post('/api/shop/staff/active', { staffId: hana.id, active: true })).status, 200);
  assert.equal((await owner.post('/api/shop/staff/password', { staffId: hana.id, password: 'newpass999' })).status, 200);
  assert.equal((await again.post('/api/shop/staff-login', { storeCode: owner.storeCode, username: 'hana', password: 'newpass999' })).status, 200);
});

test('staff: duplicate username in the same shop refused', async () => {
  const owner = await newShop();
  await owner.post('/api/shop/staff', { name: 'A', username: 'same', password: 'password123' });
  assert.equal((await owner.post('/api/shop/staff', { name: 'B', username: 'SAME', password: 'password123' })).status, 409);
});

// ===================== transfers =====================
test('transfer: send to a friend, both see it, ledger moves', async () => {
  const a = await newUser(5000), b = await newUser();
  const look = await a.get('/api/user/recipient?phone=' + b.phone);
  assert.equal(look.status, 200);
  assert.match(look.body.phone, /\*\*\*\*/); // number is masked
  const r = await a.post('/api/user/transfer', { toPhone: b.phone, amount: 1500, pin: '2580', message: 'Lunch 🍜' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.direction, 'out');
  assert.equal(await bal(a, 'user'), 3500);
  assert.equal(await bal(b, 'user'), 1500);
  const hb = (await b.get('/api/user/history')).body.items;
  assert.equal(hb[0].type, 'transfer');
  assert.equal(hb[0].direction, 'in');
  assert.equal(hb[0].note, 'Lunch 🍜');
});

test('transfer: wrong PIN, self, unknown, too much, over limit are refused', async () => {
  const a = await newUser(100000), b = await newUser();
  await a.post('/api/user/topup', { amount: 100000 });
  assert.equal((await a.post('/api/user/transfer', { toPhone: b.phone, amount: 100, pin: '0000' })).body.error.code, 'PIN_WRONG');
  assert.equal((await a.post('/api/user/transfer', { toPhone: a.phone, amount: 100, pin: '2580' })).body.error.code, 'SELF_TRANSFER');
  assert.equal((await a.post('/api/user/transfer', { toPhone: '09099999998', amount: 100, pin: '2580' })).body.error.code, 'RECIPIENT_NOT_FOUND');
  assert.equal((await a.post('/api/user/transfer', { toPhone: b.phone, amount: 100001, pin: '2580' })).status, 400);
  const poor = await newUser(50);
  assert.equal((await poor.post('/api/user/transfer', { toPhone: b.phone, amount: 51, pin: '2580' })).body.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(await bal(b, 'user'), 0);
});

test('transfer: recipient wallet limit respected', async () => {
  const rich = await newUser(), full = await newUser();
  for (let i = 0; i < 10; i++) await full.post('/api/user/topup', { amount: 100000 });
  await rich.post('/api/user/topup', { amount: 1000 });
  assert.equal((await rich.post('/api/user/transfer', { toPhone: full.phone, amount: 1, pin: '2580' })).body.error.code, 'RECIPIENT_WALLET_LIMIT');
});

test('transfer: double-tap with same key sends once', async () => {
  const a = await newUser(3000), b = await newUser();
  const h = { 'idempotency-key': 'xfer-key-00001' };
  const body = { toPhone: b.phone, amount: 1000, pin: '2580' };
  const [r1, r2] = await Promise.all([a.post('/api/user/transfer', body, h), a.post('/api/user/transfer', body, h)]);
  assert.equal(r1.body.id, r2.body.id);
  assert.equal(await bal(b, 'user'), 1000);
});

// ===================== admin =====================
async function newAdmin() {
  const email = `admin${++n}@tsubupay.example`;
  app.svc.createAdmin({ email, password: 'admin-password-123' });
  const c = new Client();
  assert.equal((await c.post('/api/admin/login', { email, password: 'admin-password-123' })).status, 200);
  return c;
}

test('admin: only admins can use admin endpoints', async () => {
  const u = await newUser(), s = await newShop(), anon = new Client();
  for (const c of [u, s, anon]) {
    assert.equal((await c.get('/api/admin/overview')).status, 401);
    assert.equal((await c.post('/api/admin/freeze', { kind: 'user', id: 1, frozen: true, reason: 'x' })).status, 401);
  }
  assert.equal((await anon.post('/api/admin/login', { email: 'nobody@x.co', password: 'whatever-long' })).status, 401);
});

test('admin: overview, search users, shops, transactions', async () => {
  const admin = await newAdmin(), u = await newUser(1000), s = await newShop();
  await s.post('/api/shop/charge', { code: await code(u), amount: 300 });
  const o = (await admin.get('/api/admin/overview')).body;
  assert.ok(o.users >= 1 && o.merchants >= 1);
  assert.equal(o.audit.ok, true);
  assert.equal(o.money.heldTotal, o.money.customerWallets + o.money.shopBalances + o.money.platformFees);
  assert.equal((await admin.get('/api/admin/users?q=' + u.phone)).body.items[0].phone, u.phone);
  assert.equal((await admin.get('/api/admin/merchants?q=' + s.storeCode)).body.items[0].storeCode, s.storeCode);
  const txs = (await admin.get('/api/admin/transactions?type=payment')).body.items;
  assert.ok(txs.length >= 1 && txs.every((t) => t.type === 'payment'));
});

test('admin: freezing a customer blocks codes, top-ups, payments and incoming transfers', async () => {
  const admin = await newAdmin(), u = await newUser(2000), s = await newShop(), friend = await newUser(500);
  const c = await code(u); // issued before the freeze
  assert.equal((await admin.post('/api/admin/freeze', { kind: 'user', id: u.id, frozen: true })).status, 400); // reason required
  assert.equal((await admin.post('/api/admin/freeze', { kind: 'user', id: u.id, frozen: true, reason: 'Suspicious activity' })).status, 200);
  assert.equal((await u.get('/api/user/me')).body.frozen, true);
  assert.equal((await u.post('/api/user/paycode')).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await u.post('/api/user/topup', { amount: 100 })).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await s.post('/api/shop/charge', { code: c, amount: 100 })).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await friend.post('/api/user/transfer', { toPhone: u.phone, amount: 100, pin: '2580' })).body.error.code, 'RECIPIENT_UNAVAILABLE');
  assert.equal(await bal(u, 'user'), 2000);
  // unfreeze restores everything
  assert.equal((await admin.post('/api/admin/freeze', { kind: 'user', id: u.id, frozen: false })).status, 200);
  assert.equal((await s.post('/api/shop/charge', { code: await code(u), amount: 100 })).status, 200);
  const log = (await admin.get('/api/admin/log')).body.items;
  assert.deepEqual(log.slice(0, 2).map((l) => l.action), ['unfreeze', 'freeze']);
  assert.equal(log[1].reason, 'Suspicious activity');
});

test('admin: freezing a shop blocks charges, store-QR payments and payouts, but allows refunds', async () => {
  const admin = await newAdmin(), u = await newUser(5000), s = await newShop();
  const p = (await s.post('/api/shop/charge', { code: await code(u), amount: 1000 })).body;
  await admin.post('/api/admin/freeze', { kind: 'merchant', id: s.id, frozen: true, reason: 'Under review' });
  assert.equal((await s.post('/api/shop/charge', { code: await code(u), amount: 100 })).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await u.get('/api/user/store?code=' + s.storeCode)).body.error.code, 'STORE_UNAVAILABLE');
  assert.equal((await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 100, pin: '2580' })).body.error.code, 'STORE_UNAVAILABLE');
  assert.equal((await s.post('/api/shop/payout', {})).body.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await s.post('/api/shop/refund', { txId: p.id })).status, 200);
  assert.equal(await bal(u, 'user'), 5000);
});

test('admin from settings: changing the password and restarting updates the login', async () => {
  const email = 'settings-admin@tsubupay.example';
  assert.equal(app.svc.ensureAdmin({ email, password: 'first-password-1' }), 'created');
  assert.equal(app.svc.ensureAdmin({ email, password: 'first-password-1' }), 'unchanged');
  const c = new Client();
  assert.equal((await c.post('/api/admin/login', { email, password: 'first-password-1' })).status, 200);
  assert.equal(app.svc.ensureAdmin({ email, password: 'second-password-2' }), 'password updated');
  assert.equal((await c.get('/api/admin/me')).status, 401); // old login ended
  const d = new Client();
  assert.equal((await d.post('/api/admin/login', { email, password: 'first-password-1' })).status, 401);
  assert.equal((await d.post('/api/admin/login', { email: ' Settings-Admin@TsubuPay.example ', password: ' second-password-2\n' })).status, 200);
});

test('passwords with stray spaces work the same at sign-up and login', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/user/register', { phone: '07099990000', name: 'Space', password: '  spaced-pass-1 ', pin: '2580' })).status, 200);
  const d = new Client();
  assert.equal((await d.post('/api/user/login', { phone: '07099990000', password: 'spaced-pass-1' })).status, 200);
  assert.equal((await d.post('/api/user/login', { phone: '07099990000', password: ' spaced-pass-1\n' })).status, 200);
});

// ===================== receipts =====================
test('receipts: customer, shop and admin can see it; strangers cannot', async () => {
  const u = await newUser(2000), s = await newShop(), stranger = await newUser(), otherShop = await newShop(), admin = await newAdmin();
  const p = (await s.post('/api/shop/charge', { code: await code(u), amount: 800 })).body;
  await s.post('/api/shop/refund', { txId: p.id, amount: 300 });
  const ru = await u.get('/api/receipt?id=' + p.id);
  assert.equal(ru.status, 200);
  assert.equal(ru.body.amount, 800);
  assert.equal(ru.body.fee, undefined); // customers never see the shop's fee
  assert.equal(ru.body.related[0].type, 'refund');
  const rs = await s.get('/api/receipt?id=' + p.id);
  assert.equal(rs.body.fee, 15);
  assert.equal((await admin.get('/api/receipt?id=' + p.id)).status, 200);
  assert.equal((await stranger.get('/api/receipt?id=' + p.id)).status, 404);
  assert.equal((await otherShop.get('/api/receipt?id=' + p.id)).status, 404);
  assert.equal((await new Client().get('/api/receipt?id=' + p.id)).status, 401);
});

test('receipts: both sides of a transfer can see it', async () => {
  const a = await newUser(1000), b = await newUser(), c = await newUser();
  const t = (await a.post('/api/user/transfer', { toPhone: b.phone, amount: 200, pin: '2580' })).body;
  assert.equal((await a.get('/api/receipt?id=' + t.id)).body.direction, 'out');
  assert.equal((await b.get('/api/receipt?id=' + t.id)).body.direction, 'in');
  assert.equal((await c.get('/api/receipt?id=' + t.id)).status, 404);
});

test('ledger still balances after all feature tests', () => {
  assert.deepEqual(app.svc.auditLedger().problems, []);
});

// ===================== migration =====================
test('migration: an old (v1) database upgrades with all data and balances kept', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsubu-')), 'old.db');
  const old = open(file, { migrate: false }); // creates the original v1 schema only
  const t = Date.now();
  old.exec(`INSERT INTO users (id, phone, name, pass_hash, pin_hash, created_at) VALUES (1, '09000000001', 'Old User', 'x', 'y', ${t});
            INSERT INTO accounts (owner_type, owner_id, balance) VALUES ('user', 1, 701);
            INSERT INTO merchants (id, email, shop_name, pass_hash, store_code, fee_bps, created_at) VALUES (1, 'old@shop.co', 'Old Shop', 'x', 'ABCDEFGH', 198, ${t});
            INSERT INTO accounts (owner_type, owner_id, balance) VALUES ('merchant', 1, 294);
            UPDATE accounts SET balance = 6 WHERE owner_type = 'platform';
            UPDATE accounts SET balance = -1000 WHERE owner_type = 'external';
            INSERT INTO transactions (id, type, amount, user_id, created_at) VALUES ('TXOLDTOPUP', 'topup', 1000, 1, ${t});
            INSERT INTO transactions (id, type, method, amount, fee, user_id, merchant_id, created_at) VALUES ('TXOLDPAY', 'payment', 'cpm', 300, 5, 1, 1, ${t});
            INSERT INTO transactions (id, type, amount, fee, user_id, merchant_id, ref_tx, created_at) VALUES ('TXOLDREF', 'refund', 1, 0, 1, 1, 'TXOLDPAY', ${t});`);
  const ext = old.prepare(`SELECT id FROM accounts WHERE owner_type='external'`).get().id;
  const plat = old.prepare(`SELECT id FROM accounts WHERE owner_type='platform'`).get().id;
  const ua = old.prepare(`SELECT id FROM accounts WHERE owner_type='user'`).get().id;
  const ma = old.prepare(`SELECT id FROM accounts WHERE owner_type='merchant'`).get().id;
  old.exec(`INSERT INTO entries (tx_id, account_id, delta) VALUES ('TXOLDTOPUP', ${ext}, -1000), ('TXOLDTOPUP', ${ua}, 1000),
            ('TXOLDPAY', ${ua}, -300), ('TXOLDPAY', ${ma}, 295), ('TXOLDPAY', ${plat}, 5),
            ('TXOLDREF', ${ua}, 1), ('TXOLDREF', ${ma}, -1);
            UPDATE accounts SET balance = 5 WHERE id = ${plat};`);
  old.close();

  const db = open(file); // runs the migration
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare(`SELECT kyc_status FROM users WHERE id = 1`).get().kyc_status, 'none'); // existing users must verify
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 3);
  assert.equal(db.prepare(`SELECT ref_tx FROM transactions WHERE id = 'TXOLDREF'`).get().ref_tx, 'TXOLDPAY');
  assert.equal(db.prepare(`SELECT frozen FROM users WHERE id = 1`).get().frozen, 0);
  const { createService } = require('../server/service');
  const svc = createService(db);
  assert.deepEqual(svc.auditLedger().problems, []);
  assert.equal(svc.userProfile(1).balance, 701);
  db.close();
  const again = open(file); // opening again is a no-op
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 3);
  again.close();
});

test('backup: admins download a complete, valid database copy; nobody else can', async () => {
  const u = await newUser(1000);
  assert.equal((await u.get('/api/admin/backup')).status, 401);
  const admin = await newAdmin();
  const cookie = Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + '/api/admin/backup', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="tsubupay-backup-.*\.db"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'b.db');
  fs.writeFileSync(file, buf);
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file);
  assert.ok(copy.prepare(`SELECT COUNT(*) n FROM users WHERE phone = ?`).get(u.phone).n === 1);
  const { createService } = require('../server/service');
  assert.deepEqual(createService(copy).auditLedger().problems, []);
  copy.close();
  const log = (await admin.get('/api/admin/log')).body.items;
  assert.equal(log[0].action, 'backup');
});
