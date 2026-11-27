'use strict';
// Identity verification: SMS code at sign-up, ID + live selfie, one person = one account,
// admin review, and money actions blocked until approved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server');

let app, base;
test.before(async () => {
  app = createApp({ dbPath: ':memory:', limits: { login: 1000, register: 1000, chargeFail: 1000, lookup: 1000, adminLogin: 1000, otp: 1000 },
    service: { otpResendMs: 0, kycPepper: 'test-pepper' } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => app.server.close());

class Client {
  constructor() { this.jar = {}; }
  async req(method, p, body) {
    const h = { 'x-tsubu-client': '1' };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) this.jar[kv.slice(0, i)] = v; else delete this.jar[kv.slice(0, i)]; }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, type: ct, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}

// A fake but well-formed JPEG (right signature and size) for upload tests.
const jpeg = (seed = 1) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, seed)]).toString('base64');
let n = 0;
const phoneNo = () => '090' + String(20000000 + ++n).slice(-8);

async function signUp(phone = phoneNo()) {
  const c = new Client();
  const o = await c.post('/api/user/otp', { phone });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const r = await c.post('/api/user/register', { phone, otp: o.body.demoCode, name: 'Taro', password: 'password123', pin: '2580' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.phone = phone; c.id = r.body.id;
  return c;
}
async function submit(c, base = '/api/user', extra = {}) {
  const ch = await c.post(base + '/kyc/challenge');
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  return c.post(base + '/kyc', { docType: 'drivers_license', legalName: 'Yamada Taro', birthDate: '2000-04-01', address: 'Tokyo, Shinjuku 1-2-3',
    docNumber: String(100000000000 + ++n), docFront: jpeg(1), docBack: jpeg(2), selfie: jpeg(3), ...extra });
}
let adminC;
async function admin() {
  if (adminC) return adminC;
  app.svc.createAdmin({ email: 'kyc-admin@tsubupay.example', password: 'admin-password-1' });
  adminC = new Client();
  assert.equal((await adminC.post('/api/admin/login', { email: 'kyc-admin@tsubupay.example', password: 'admin-password-1' })).status, 200);
  return adminC;
}
async function verifyUser(c) {
  const r = await submit(c); assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await admin();
  return a.post('/api/admin/kyc/review', { id: r.body.id, decision: 'approve' });
}

// ---------------- phone code ----------------
test('sign-up needs the SMS code; wrong codes are counted and lock out', async () => {
  const phone = phoneNo(), c = new Client();
  const body = { phone, name: 'A', password: 'password123', pin: '2580' };
  assert.equal((await c.post('/api/user/register', body)).body.error.code, 'OTP_EXPIRED'); // no code requested yet
  const o = await c.post('/api/user/otp', { phone });
  assert.equal(o.body.demo, true);
  assert.match(o.body.demoCode, /^\d{6}$/);
  const wrong = o.body.demoCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/user/register', { ...body, otp: wrong })).body.error.code, 'OTP_WRONG');
  assert.equal((await c.post('/api/user/register', { ...body, otp: wrong })).body.error.code, 'OTP_LOCKED');
  // even the right code fails once locked; a new code works
  assert.equal((await c.post('/api/user/register', { ...body, otp: o.body.demoCode })).body.error.code, 'OTP_LOCKED');
  const o2 = await c.post('/api/user/otp', { phone });
  const ok = await c.post('/api/user/register', { ...body, otp: o2.body.demoCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.phoneVerified, true);
  assert.equal(ok.body.kycStatus, 'none');
});

test('one phone number = one account; no codes for registered numbers', async () => {
  const c = await signUp();
  assert.equal((await new Client().post('/api/user/otp', { phone: c.phone })).body.error.code, 'PHONE_TAKEN');
});

test('a code works once only', async () => {
  const phone = phoneNo(), c = new Client();
  const o = await c.post('/api/user/otp', { phone });
  assert.equal((await c.post('/api/user/register', { phone, otp: o.body.demoCode, name: 'B', password: 'password123', pin: '2580' })).status, 200);
  assert.equal((await new Client().post('/api/user/register', { phone, otp: o.body.demoCode, name: 'C', password: 'password123', pin: '2580' })).body.error.code, 'PHONE_TAKEN');
});

// ---------------- blocked until verified ----------------
test('before verification: no code, top-up, store payment or transfer', async () => {
  const c = await signUp();
  for (const [p, b] of [['/api/user/paycode', {}], ['/api/user/topup', { amount: 100 }], ['/api/user/pay', { storeCode: 'ABCDEFGH', amount: 1, pin: '2580' }],
    ['/api/user/transfer', { toPhone: '09099999999', amount: 1, pin: '2580' }]]) {
    const r = await c.post(p, b);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.error.code, 'KYC_REQUIRED', p);
  }
});

// ---------------- submission ----------------
test('submission checks: document number format, real images, live selfie instruction', async () => {
  const c = await signUp();
  assert.equal((await submit(c, '/api/user', { docNumber: '123' })).body.error.code, 'FIELD_INVALID');
  assert.equal((await submit(c, '/api/user', { selfie: 'data:image/jpeg;base64,' + Buffer.from('not an image at all, just text padding '.repeat(100)).toString('base64') })).body.error.code, 'IMAGE_INVALID');
  assert.equal((await submit(c, '/api/user', { docBack: undefined })).body.error.code, 'IMAGE_MISSING');
  assert.equal((await submit(c, '/api/user', { birthDate: '2001-02-30' })).body.error.code, 'FIELD_INVALID');
  // without asking for a selfie instruction first (fresh account)
  const fresh = await signUp();
  const r = await fresh.post('/api/user/kyc', { docType: 'passport', legalName: 'Yamada Taro', birthDate: '2000-04-01', address: 'Tokyo 1-2-3',
    docNumber: 'TK1234567', docFront: jpeg(), selfie: jpeg() });
  assert.equal(r.body.error.code, 'CHALLENGE_EXPIRED');
  // passport needs no back photo
  const ok = await submit(c, '/api/user', { docType: 'passport', docNumber: 'TK7654321', docBack: undefined });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await c.get('/api/user/kyc')).body.status, 'pending');
  assert.equal((await submit(c)).body.error.code, 'KYC_PENDING');
});

test('one person = one account: the same ID cannot verify a second account', async () => {
  const a = await signUp(), b = await signUp();
  assert.equal((await submit(a, '/api/user', { docNumber: '555566667777' })).status, 200);
  const r = await submit(b, '/api/user', { docNumber: '5555-6666-7777' }); // same number, typed differently
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DOC_ALREADY_USED');
});

test('ID numbers are never stored, only a keyed hash and the last 4', () => {
  const row = app.db.prepare(`SELECT * FROM kyc_submissions WHERE doc_last4 = '7777' LIMIT 1`).get();
  assert.ok(row);
  for (const v of Object.values(row)) if (typeof v === 'string') assert.ok(!v.includes('555566667777'));
  assert.match(row.doc_hash, /^[0-9a-f]{64}$/);
});

// ---------------- admin review ----------------
test('admin approves: the customer can then pay; admin sees photos; others cannot', async () => {
  const c = await signUp();
  const sub = (await submit(c)).body;
  const a = await admin();
  const list = (await a.get('/api/admin/kyc?status=pending')).body.items;
  const item = list.find((x) => x.id === sub.id);
  assert.ok(item && item.gesture && item.account.includes(c.phone));
  assert.equal(item.docFront, undefined); // list has no images
  const img = await a.get(`/api/admin/kyc/image?id=${sub.id}&which=selfie`);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(img.body[0], 0xff);
  assert.equal((await c.get(`/api/admin/kyc/image?id=${sub.id}&which=selfie`)).status, 401); // a customer cannot see ID photos
  assert.equal((await a.post('/api/admin/kyc/review', { id: sub.id, decision: 'approve' })).status, 200);
  assert.equal((await c.get('/api/user/me')).body.kycStatus, 'approved');
  assert.equal((await c.post('/api/user/topup', { amount: 500 })).status, 200);
  assert.equal((await a.post('/api/admin/kyc/review', { id: sub.id, decision: 'reject', reason: 'late' })).body.error.code, 'ALREADY_REVIEWED');
  assert.equal((await c.post('/api/user/kyc/challenge')).body.error.code, 'ALREADY_VERIFIED');
});

test('admin rejects with a reason: the customer sees it and can try again', async () => {
  const c = await signUp();
  const sub = (await submit(c)).body;
  const a = await admin();
  assert.equal((await a.post('/api/admin/kyc/review', { id: sub.id, decision: 'reject' })).status, 400); // reason required
  assert.equal((await a.post('/api/admin/kyc/review', { id: sub.id, decision: 'reject', reason: 'Selfie is blurry' })).status, 200);
  const info = (await c.get('/api/user/kyc')).body;
  assert.equal(info.status, 'rejected');
  assert.equal(info.lastSubmission.reason, 'Selfie is blurry');
  assert.equal((await submit(c)).status, 200); // resubmit allowed
  const log = (await a.get('/api/admin/log')).body.items;
  assert.ok(log.some((l) => l.action === 'kyc_reject' && l.reason === 'Selfie is blurry'));
});

test('rejected documents can be reused by the same person, not by others', async () => {
  const a = await signUp(), b = await signUp();
  const s1 = (await submit(a, '/api/user', { docNumber: '999988887777' })).body;
  const adm = await admin();
  await adm.post('/api/admin/kyc/review', { id: s1.id, decision: 'reject', reason: 'Photo cut off' });
  assert.equal((await submit(a, '/api/user', { docNumber: '999988887777' })).status, 200); // same person retries
  assert.equal((await submit(b, '/api/user', { docNumber: '999988887777' })).body.error.code, 'DOC_ALREADY_USED');
});

// ---------------- shops ----------------
test('shops: unverified shops cannot take money; only the owner can verify', async () => {
  const owner = new Client();
  const s = (await owner.post('/api/shop/register', { email: `kyc-shop${++n}@ex.com`, shopName: 'Verified Cafe', password: 'password123' })).body;
  assert.equal(s.kycStatus, 'none');
  const cust = await signUp(); await verifyUser(cust);
  await cust.post('/api/user/topup', { amount: 3000 });
  const code = (await cust.post('/api/user/paycode')).body.code;
  assert.equal((await owner.post('/api/shop/charge', { code, amount: 100 })).body.error.code, 'KYC_REQUIRED');
  assert.equal((await cust.get('/api/user/store?code=' + s.storeCode)).body.error.code, 'STORE_UNAVAILABLE');
  // a cashier cannot verify the shop
  await owner.post('/api/shop/staff', { name: 'Aki', username: 'akik', password: 'cashier123' });
  const cashier = new Client();
  await cashier.post('/api/shop/staff-login', { storeCode: s.storeCode, username: 'akik', password: 'cashier123' });
  assert.equal((await cashier.post('/api/shop/kyc/challenge')).body.error.code, 'OWNER_ONLY');
  const sub = await submit(owner, '/api/shop');
  assert.equal(sub.status, 200);
  await (await admin()).post('/api/admin/kyc/review', { id: sub.body.id, decision: 'approve' });
  assert.equal((await owner.post('/api/shop/charge', { code, amount: 100 })).status, 200);
});

test('transfers only between verified customers', async () => {
  const a = await signUp(), b = await signUp();
  await verifyUser(a);
  await a.post('/api/user/topup', { amount: 1000 });
  assert.equal((await a.get('/api/user/recipient?phone=' + b.phone)).body.error.code, 'RECIPIENT_UNAVAILABLE');
  await verifyUser(b);
  assert.equal((await a.post('/api/user/transfer', { toPhone: b.phone, amount: 300, pin: '2580' })).status, 200);
});

test('overview counts pending checks; ledger still balances', async () => {
  const o = (await (await admin()).get('/api/admin/overview')).body;
  assert.ok(o.kycPending >= 1);
  assert.deepEqual(app.svc.auditLedger().problems, []);
});
