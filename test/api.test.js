'use strict';
// End-to-end API tests. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/server');
const { luhnDigit } = require('../server/util');

let clockOffset = 0;
const clock = () => Date.now() + clockOffset;

let app, base;
test.before(async () => {
  app = createApp({ dbPath: ':memory:', service: { clock, requireKyc: false, requirePhoneOtp: false }, limits: { login: 1000, register: 1000, chargeFail: 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.server.close());

// Minimal client that remembers its cookies, like a browser.
class Client {
  constructor() { this.jar = {}; }
  async req(method, path, body, headers = {}) {
    const h = { 'x-tsubu-client': '1', ...headers };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) this.jar[kv.slice(0, i)] = v; else delete this.jar[kv.slice(0, i)];
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
}

let n = 0;
async function newUser(balance = 0) {
  const c = new Client();
  const phone = '090' + String(10000000 + ++n).slice(-8);
  const r = await c.post('/api/user/register', { phone, name: `User ${n}`, password: 'password123', pin: '2580' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (balance) assert.equal((await c.post('/api/user/topup', { amount: balance })).status, 200);
  return c;
}
async function newShop() {
  const c = new Client();
  const r = await c.post('/api/shop/register', { email: `shop${++n}@example.com`, shopName: `Shop ${n}`, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.storeCode = r.body.storeCode;
  return c;
}
const code = async (u) => (await u.post('/api/user/paycode')).body.code;
const balance = async (c, kind) => (await c.get(`/api/${kind}/me`)).body.balance;

test('pay code format: 18 digits, 88 prefix, valid check digit', async () => {
  const u = await newUser();
  const c = await code(u);
  assert.match(c, /^88\d{16}$/);
  assert.equal(luhnDigit(c.slice(0, -1)), c.slice(-1));
});

test('CPM: shop scans customer code, money and fee move correctly', async () => {
  const u = await newUser(5000), s = await newShop();
  const r = await s.post('/api/shop/charge', { code: await code(u), amount: 1000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, 1000);
  assert.equal(r.body.fee, 19); // floor(1000 * 1.98%)
  assert.equal(r.body.net, 981);
  assert.equal(await balance(u, 'user'), 4000);
  assert.equal(await balance(s, 'shop'), 981);
});

test('a code can only be used once', async () => {
  const u = await newUser(5000), s = await newShop();
  const c = await code(u);
  assert.equal((await s.post('/api/shop/charge', { code: c, amount: 100 })).status, 200);
  const again = await s.post('/api/shop/charge', { code: c, amount: 100 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'CODE_USED');
  assert.equal(await balance(u, 'user'), 4900);
});

test('race: 10 simultaneous charges on one code, exactly one succeeds', async () => {
  const u = await newUser(10000), s = await newShop(), s2 = await newShop();
  const c = await code(u);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? s : s2).post('/api/shop/charge', { code: c, amount: 1000 })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(await balance(u, 'user'), 9000);
});

test('codes expire', async () => {
  const u = await newUser(1000), s = await newShop();
  const c = await code(u);
  clockOffset += 3 * 60 * 1000 + 1;
  try {
    const r = await s.post('/api/shop/charge', { code: c, amount: 100 });
    assert.equal(r.status, 410);
    assert.equal(r.body.error.code, 'CODE_EXPIRED');
  } finally { clockOffset = 0; }
});

test('refreshing keeps only the newest two codes alive', async () => {
  const u = await newUser(1000), s = await newShop();
  const c1 = await code(u), c2 = await code(u), c3 = await code(u);
  assert.equal((await s.post('/api/shop/charge', { code: c1, amount: 10 })).body.error.code, 'CODE_NOT_FOUND');
  assert.equal((await s.post('/api/shop/charge', { code: c2, amount: 10 })).status, 200);
  assert.equal((await s.post('/api/shop/charge', { code: c3, amount: 10 })).status, 200);
});

test('insufficient balance is refused and the code stays usable', async () => {
  const u = await newUser(500), s = await newShop();
  const c = await code(u);
  const r = await s.post('/api/shop/charge', { code: c, amount: 501 });
  assert.equal(r.status, 402);
  assert.equal(await balance(u, 'user'), 500);
  assert.equal((await s.post('/api/shop/charge', { code: c, amount: 500 })).status, 200);
  assert.equal(await balance(u, 'user'), 0);
});

test('mistyped or fake codes are rejected before lookup', async () => {
  const s = await newShop();
  for (const bad of ['123', '880000000000000000', 'abc', '', null, '88' + '1'.repeat(17)]) {
    const r = await s.post('/api/shop/charge', { code: bad, amount: 100 });
    assert.equal(r.status, 400, String(bad));
  }
});

test('bad amounts are rejected', async () => {
  const u = await newUser(1000), s = await newShop();
  for (const amount of [0, -5, 1.5, 'abc', null, 500001, 1e20, '10e3', true]) {
    const r = await s.post('/api/shop/charge', { code: await code(u), amount });
    assert.equal(r.status, 400, String(amount));
  }
  assert.equal(await balance(u, 'user'), 1000);
});

test('MPM: customer scans shop QR and pays with PIN', async () => {
  const u = await newUser(3000), s = await newShop();
  const store = await u.get('/api/user/store?code=' + encodeURIComponent('TSUBUPAY:STORE:' + s.storeCode));
  assert.equal(store.status, 200);
  const r = await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 1200, pin: '2580' });
  assert.equal(r.status, 200);
  assert.equal(r.body.method, 'mpm');
  assert.equal(await balance(u, 'user'), 1800);
  assert.equal(await balance(s, 'shop'), 1200 - 23);
});

test('wrong PIN 5 times locks payments, then unlocks after 15 min', async () => {
  const u = await newUser(3000), s = await newShop();
  for (let i = 0; i < 4; i++) {
    const r = await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 100, pin: '0000' });
    assert.equal(r.body.error.code, 'PIN_WRONG');
  }
  assert.equal((await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 100, pin: '0000' })).body.error.code, 'PIN_LOCKED');
  // even the right PIN is refused while locked
  assert.equal((await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 100, pin: '2580' })).body.error.code, 'PIN_LOCKED');
  clockOffset += 15 * 60 * 1000 + 1;
  try {
    // new login needed? no: user session is 30 days, still valid
    assert.equal((await u.post('/api/user/pay', { storeCode: s.storeCode, amount: 100, pin: '2580' })).status, 200);
  } finally { clockOffset = 0; }
  assert.equal(await balance(u, 'user'), 2900);
});

test('refunds: partial, partial, rest; fees return exactly; no over-refund', async () => {
  const u = await newUser(10000), s = await newShop();
  const pay = (await s.post('/api/shop/charge', { code: await code(u), amount: 999 })).body; // fee 19
  assert.equal(pay.fee, 19);
  const r1 = await s.post('/api/shop/refund', { txId: pay.id, amount: 333 });
  const r2 = await s.post('/api/shop/refund', { txId: pay.id, amount: 333 });
  const r3 = await s.post('/api/shop/refund', { txId: pay.id }); // the rest
  for (const r of [r1, r2, r3]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r3.body.amount, 333);
  assert.equal(r1.body.fee + r2.body.fee + r3.body.fee, 19);
  assert.equal(await balance(u, 'user'), 10000);
  assert.equal(await balance(s, 'shop'), 0);
  const r4 = await s.post('/api/shop/refund', { txId: pay.id, amount: 1 });
  assert.equal(r4.body.error.code, 'ALREADY_REFUNDED');
});

test('refund larger than remaining is refused', async () => {
  const u = await newUser(1000), s = await newShop();
  const pay = (await s.post('/api/shop/charge', { code: await code(u), amount: 500 })).body;
  assert.equal((await s.post('/api/shop/refund', { txId: pay.id, amount: 501 })).status, 400);
});

test('a shop cannot refund another shop\'s payment', async () => {
  const u = await newUser(1000), s = await newShop(), thief = await newShop();
  const pay = (await s.post('/api/shop/charge', { code: await code(u), amount: 500 })).body;
  assert.equal((await thief.post('/api/shop/refund', { txId: pay.id })).status, 404);
});

test('refund needs shop funds if already paid out', async () => {
  const u = await newUser(1000), s = await newShop();
  const pay = (await s.post('/api/shop/charge', { code: await code(u), amount: 500 })).body;
  assert.equal((await s.post('/api/shop/payout', {})).status, 200);
  assert.equal(await balance(s, 'shop'), 0);
  assert.equal((await s.post('/api/shop/refund', { txId: pay.id })).body.error.code, 'MERCHANT_FUNDS_LOW');
});

test('payout cannot exceed balance', async () => {
  const u = await newUser(1000), s = await newShop();
  await s.post('/api/shop/charge', { code: await code(u), amount: 1000 }); // net 981
  assert.equal((await s.post('/api/shop/payout', { amount: 982 })).status, 400);
  assert.equal((await s.post('/api/shop/payout', { amount: 981 })).status, 200);
  assert.equal((await s.post('/api/shop/payout', {})).body.error.code, 'NOTHING_TO_PAY');
});

test('top-up limits: per top-up and wallet maximum', async () => {
  const u = await newUser();
  assert.equal((await u.post('/api/user/topup', { amount: 100001 })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await u.post('/api/user/topup', { amount: 100000 })).status, 200);
  assert.equal((await u.post('/api/user/topup', { amount: 1 })).body.error.code, 'WALLET_LIMIT');
});

test('idempotency: a retried top-up is applied once; key reuse with other data is refused', async () => {
  const u = await newUser();
  const h = { 'idempotency-key': 'retry-key-0001' };
  const a = await u.post('/api/user/topup', { amount: 700 }, h);
  const b = await u.post('/api/user/topup', { amount: 700 }, h);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(await balance(u, 'user'), 700);
  assert.equal((await u.post('/api/user/topup', { amount: 800 }, h)).status, 422);
});

test('idempotency: double-tapped charge charges once', async () => {
  const u = await newUser(5000), s = await newShop();
  const c = await code(u);
  const h = { 'idempotency-key': 'charge-key-0001' };
  const [a, b] = await Promise.all([
    s.post('/api/shop/charge', { code: c, amount: 300 }, h),
    s.post('/api/shop/charge', { code: c, amount: 300 }, h),
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(await balance(u, 'user'), 4700);
});

test('security: writes without the client header are refused (CSRF)', async () => {
  const u = await newUser(1000);
  const res = await fetch(base + '/api/user/topup', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(u.jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify({ amount: 100 }),
  });
  assert.equal(res.status, 403);
  const cross = await u.post('/api/user/topup', { amount: 100 }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('security: sessions are separate and required', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/user/me')).status, 401);
  assert.equal((await anon.post('/api/shop/charge', { code: '1', amount: 1 })).status, 401);
  const u = await newUser();
  assert.equal((await u.get('/api/shop/me')).status, 401); // a customer is not a shop
  assert.equal((await u.post('/api/user/logout')).status, 200);
  assert.equal((await u.get('/api/user/me')).status, 401);
});

test('login: wrong password refused, right password works', async () => {
  const c = new Client();
  await c.post('/api/user/register', { phone: '08012345678', name: 'Login Test', password: 'correct-horse', pin: '7391' });
  const d = new Client();
  assert.equal((await d.post('/api/user/login', { phone: '08012345678', password: 'wrong-pass' })).status, 401);
  assert.equal((await d.post('/api/user/login', { phone: '08099999999', password: 'wrong-pass' })).status, 401);
  assert.equal((await d.post('/api/user/login', { phone: '08012345678', password: 'correct-horse' })).status, 200);
  assert.equal((await c.post('/api/user/register', { phone: '08012345678', name: 'Dup', password: 'password123', pin: '7391' })).status, 409);
});

test('registration validation', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/user/register', { phone: '123', name: 'x', password: 'password123', pin: '2580' })).status, 400);
  assert.equal((await c.post('/api/user/register', { phone: '09011112222', name: 'x', password: 'short', pin: '2580' })).status, 400);
  assert.equal((await c.post('/api/user/register', { phone: '09011112222', name: 'x', password: 'password123', pin: '1111' })).status, 400);
  assert.equal((await c.post('/api/shop/register', { email: 'not-an-email', shopName: 'x', password: 'password123' })).status, 400);
});

test('live events: shop and customer are notified on payment', async () => {
  const u = await newUser(1000), s = await newShop();
  const listen = (client, path) => new Promise((resolve, reject) => {
    const cookie = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const req = http.get(base + path, { headers: { cookie } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const m = /event: payment\ndata: (.+)\n/.exec(buf);
        if (m) { resolve(JSON.parse(m[1])); req.destroy(); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => reject(new Error('no event')), 3000);
  });
  const shopEvt = listen(s, '/api/shop/events');
  const userEvt = listen(u, '/api/user/events');
  await new Promise((r) => setTimeout(r, 100));
  await s.post('/api/shop/charge', { code: await code(u), amount: 250 });
  assert.equal((await shopEvt).tx.amount, 250);
  assert.equal((await userEvt).tx.amount, 250);
});

test('history and today summary', async () => {
  const u = await newUser(5000), s = await newShop();
  const p = (await s.post('/api/shop/charge', { code: await code(u), amount: 2000 })).body;
  await s.post('/api/shop/refund', { txId: p.id, amount: 500 });
  const me = (await s.get('/api/shop/me')).body;
  assert.equal(me.today.payments, 1);
  assert.equal(me.today.gross, 2000);
  assert.equal(me.today.refunds, 500);
  assert.equal(me.today.net, me.balance);
  const uh = (await u.get('/api/user/history')).body.items;
  assert.deepEqual(uh.map((t) => t.type), ['refund', 'payment', 'topup']);
});

test('static files: no path traversal', async () => {
  for (const p of ['/../server/db.js', '/%2e%2e/server/db.js', '/user/../../package.json']) {
    const r = await fetch(base + p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
  }
});

test('ledger audit: every transaction balances and all money is accounted for', () => {
  const a = app.svc.auditLedger();
  assert.deepEqual(a.problems, []);
  assert.ok(a.ok);
});
