'use strict';
// TsubuPay core: all money rules live here, independent of HTTP.
// Every money movement is one SQLite transaction with balanced ledger entries.

const { EventEmitter } = require('node:events');
const { tx } = require('./db');
const U = require('./util');

const DEFAULTS = {
  feeBps: 198,                      // merchant fee 1.98%
  codeTtlMs: 3 * 60 * 1000,         // a payment code lives 3 minutes
  maxActiveCodes: 2,                // current + previous (so a refresh mid-scan still works)
  topupMin: 1,
  topupMax: 100_000,                // per top-up
  walletMax: 1_000_000,             // max wallet balance
  paymentMax: 500_000,              // per payment
  transferMax: 100_000,             // per transfer between customers
  pinMaxFails: 5,
  pinLockMs: 15 * 60 * 1000,
  userSessionMs: 30 * 24 * 3600 * 1000,
  merchantSessionMs: 7 * 24 * 3600 * 1000,
  adminSessionMs: 8 * 3600 * 1000,
  requirePhoneOtp: true,            // sign-up needs the 6-digit SMS code
  requireKyc: true,                 // money actions need an approved identity check
  otpTtlMs: 5 * 60 * 1000,
  otpMaxAttempts: 5,
  otpResendMs: 60 * 1000,
  kycChallengeMs: 15 * 60 * 1000,
  kycPepper: 'tsubupay-dev-pepper', // override with TSUBU_KYC_PEPPER in production
};

// Gestures for the live selfie. The server picks one at random, so an old photo cannot be reused.
const GESTURES = [
  'Hold up 2 fingers next to your face', 'Hold up 3 fingers next to your face',
  'Give a thumbs-up next to your face', 'Touch your left ear with your hand',
  'Touch your right ear with your hand', 'Make an OK sign next to your face',
  'Put your open hand flat under your chin', 'Cover one eye with your hand',
];
const DOC_RULES = {
  drivers_license: { re: /^\d{12}$/, label: "driver's licence number (12 digits)", back: true },
  residence_card: { re: /^[A-Z]{2}\d{8}[A-Z]{2}$/, label: 'residence card number (e.g. AB12345678CD)', back: true },
  passport: { re: /^[A-Z]{2}\d{7}$/, label: 'passport number (e.g. TK1234567)', back: false },
};

const err = (status, code, msg) => new U.ApiError(status, code, msg);

function createService(db, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = opts.clock || (() => Date.now());
  const events = new EventEmitter();
  events.setMaxListeners(0);

  // ---------- helpers ----------
  const q = (sql) => db.prepare(sql);

  function amountOrThrow(v, max, min = 1) {
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (!Number.isSafeInteger(v) || v < min) throw err(400, 'AMOUNT_INVALID', `Amount must be a whole number of yen, at least ${min}.`);
    if (v > max) throw err(400, 'AMOUNT_TOO_LARGE', `Amount must be ${max.toLocaleString('en')} yen or less.`);
    return v;
  }

  function str(v, name, { min = 1, max = 100, re } = {}) {
    if (typeof v !== 'string') throw err(400, 'FIELD_INVALID', `${name} is required.`);
    v = v.trim();
    if (v.length < min || v.length > max) throw err(400, 'FIELD_INVALID', `${name} must be ${min}-${max} characters.`);
    if (re && !re.test(v)) throw err(400, 'FIELD_INVALID', `${name} is not valid.`);
    return v;
  }
  const optStr = (v, name, max) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : str(v, name, { max }));

  function account(type, id) {
    const row = q('SELECT id, balance FROM accounts WHERE owner_type = ? AND owner_id = ?').get(type, id);
    if (!row) throw err(500, 'NO_ACCOUNT', 'Account missing.');
    return row;
  }

  // Applies balanced entries. Throws if they do not sum to zero.
  function post(txId, moves) {
    const sum = moves.reduce((s, [, d]) => s + d, 0);
    if (sum !== 0) throw err(500, 'LEDGER_UNBALANCED', 'Ledger entries must balance.');
    const ins = q('INSERT INTO entries (tx_id, account_id, delta) VALUES (?, ?, ?)');
    const upd = q('UPDATE accounts SET balance = balance + ? WHERE id = ?');
    for (const [acctId, delta] of moves) {
      if (delta === 0) continue;
      ins.run(txId, acctId, delta);
      upd.run(delta, acctId); // CHECK(balance >= 0) is the final safety net
    }
  }

  function insertTx(t) {
    const id = U.newTxId();
    q(`INSERT INTO transactions (id, type, method, amount, fee, user_id, to_user_id, merchant_id, staff_id, ref_tx, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, t.type, t.method ?? null, t.amount, t.fee ?? 0, t.userId ?? null, t.toUserId ?? null,
      t.merchantId ?? null, t.staffId ?? null, t.refTx ?? null, t.note ?? null, now());
    return id;
  }

  const feeFor = (amount, bps) => Math.floor((amount * bps) / 10000);

  // Runs an operation atomically, with optional idempotency.
  // fn returns { result, events: [[channel, payload], ...] }.
  function run(scope, idemKey, fp, fn) {
    if (idemKey != null) {
      if (typeof idemKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(idemKey))
        throw err(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-64 letters, digits, - or _.');
    }
    const out = tx(db, () => {
      if (idemKey) {
        const hit = q('SELECT fp, body FROM idempotency WHERE scope = ? AND key = ?').get(scope, idemKey);
        if (hit && hit.fp !== fp) throw err(422, 'IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.');
        if (hit) return { result: JSON.parse(hit.body), events: [], replay: true };
      }
      const r = fn();
      if (idemKey) {
        q('INSERT INTO idempotency (scope, key, fp, status, body, created_at) VALUES (?, ?, ?, 200, ?, ?)')
          .run(scope, idemKey, fp, JSON.stringify(r.result), now());
      }
      return r;
    });
    for (const [ch, payload] of out.events || []) events.emit(ch, payload);
    return out.result;
  }

  // ---------- frozen-account checks ----------
  function userOk(id, who = 'Your account') {
    const u = q('SELECT frozen FROM users WHERE id = ?').get(id);
    if (!u) throw err(404, 'NOT_FOUND', 'User not found.');
    if (u.frozen) throw err(403, 'ACCOUNT_FROZEN', `${who} is frozen. Please contact TsubuPay support.`);
  }
  function merchantOk(id, who = 'This shop') {
    const m = q('SELECT frozen FROM merchants WHERE id = ?').get(id);
    if (!m) throw err(404, 'NOT_FOUND', 'Shop not found.');
    if (m.frozen) throw err(403, 'ACCOUNT_FROZEN', `${who} is frozen. Please contact TsubuPay support.`);
  }
  // Money actions need an approved identity check (KYC).
  function kycOk(type, id, code = 'KYC_REQUIRED', msg) {
    if (!cfg.requireKyc) return;
    const r = q(`SELECT kyc_status FROM ${type === 'user' ? 'users' : 'merchants'} WHERE id = ?`).get(id);
    if (!r || r.kyc_status !== 'approved') {
      const pending = r && r.kyc_status === 'pending';
      throw err(403, code, msg || (pending ? 'Your identity check is being reviewed. You can pay once it is approved.'
        : 'Verify your identity first (ID document + selfie) to use payments.'));
    }
  }
  const isVerified = (type, id) => !cfg.requireKyc ||
    q(`SELECT kyc_status FROM ${type === 'user' ? 'users' : 'merchants'} WHERE id = ?`).get(id)?.kyc_status === 'approved';

  function requireOwner(actor) {
    if (actor.staffId) throw err(403, 'OWNER_ONLY', 'Only the shop owner can do this. Ask the owner to log in.');
  }

  // ---------- views ----------
  const nameOfUser = (id) => (id ? q('SELECT name FROM users WHERE id = ?').get(id)?.name : undefined);
  function txView(row) {
    if (!row) return null;
    const m = row.merchant_id ? q('SELECT shop_name, store_code FROM merchants WHERE id = ?').get(row.merchant_id) : null;
    const st = row.staff_id ? q('SELECT name FROM staff WHERE id = ?').get(row.staff_id) : null;
    return {
      id: row.id, type: row.type, method: row.method, amount: row.amount, fee: row.fee,
      net: row.type === 'payment' ? row.amount - row.fee : undefined,
      refundedAmount: row.refunded_amount, refTx: row.ref_tx, note: row.note,
      shopName: m?.shop_name, storeCode: m?.store_code,
      customerName: nameOfUser(row.user_id),
      toName: row.type === 'transfer' ? nameOfUser(row.to_user_id) : undefined,
      cashier: row.merchant_id ? (st ? st.name : 'Owner') : undefined,
      createdAt: row.created_at,
    };
  }
  const getTx = (id) => txView(q('SELECT * FROM transactions WHERE id = ?').get(id));
  // Live events reach every device of the shop, cashiers included, so they carry no fee figures.
  const shopEvent = (v) => { const e = { ...v }; delete e.fee; delete e.net; return e; };
  const forActor = (actor, v) => (actor.staffId ? shopEvent(v) : v);

  // Customer-facing view: hides the shop's fee and says which way a transfer went.
  function userTxView(row, userId) {
    const v = txView(row);
    delete v.fee; delete v.net; // the cashier's name stays: receipts show who served you (担当)
    if (row.type === 'transfer') v.direction = row.to_user_id === userId ? 'in' : 'out';
    return v;
  }

  // ---------- accounts & sessions ----------
  // ---------- phone codes (SMS) ----------
  function requestPhoneCode(phone) {
    phone = str(String(phone ?? '').replace(/[\s-]/g, ''), 'Phone number', { min: 10, max: 11, re: /^0\d{9,10}$/ });
    if (q('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw err(409, 'PHONE_TAKEN', 'That phone number already has an account. Please log in.');
    const old = q('SELECT created_at FROM phone_otps WHERE phone = ?').get(phone);
    if (old && now() - old.created_at < cfg.otpResendMs) throw err(429, 'OTP_TOO_SOON', 'A code was just sent. Wait a minute before asking again.');
    let code = '';
    for (let i = 0; i < 6; i++) code += require('node:crypto').randomInt(10);
    q(`INSERT INTO phone_otps (phone, code_hash, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`)
      .run(phone, U.sha256(`${phone}:${code}`), now() + cfg.otpTtlMs, now());
    return { phone, code, expiresInSec: Math.round(cfg.otpTtlMs / 1000) };
  }
  const cancelPhoneCode = (phone) => q('DELETE FROM phone_otps WHERE phone = ?').run(phone);

  // Wrong attempts are saved even though sign-up is refused, so the check commits on its own.
  function usePhoneCode(phone, code) {
    const r = tx(db, () => {
      const row = q('SELECT * FROM phone_otps WHERE phone = ?').get(phone);
      if (!row || row.expires_at <= now()) return 'expired';
      if (row.attempts >= cfg.otpMaxAttempts) return 'locked';
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim()) || U.sha256(`${phone}:${code.trim()}`) !== row.code_hash) {
        q('UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
        return row.attempts + 1 >= cfg.otpMaxAttempts ? 'locked' : 'wrong';
      }
      return 'ok';
    });
    if (r === 'expired') throw err(400, 'OTP_EXPIRED', 'The SMS code has expired. Ask for a new one.');
    if (r === 'locked') throw err(429, 'OTP_LOCKED', 'Too many wrong codes. Ask for a new one.');
    if (r === 'wrong') throw err(400, 'OTP_WRONG', 'Wrong SMS code. Check the message and try again.');
  }

  function registerUser({ phone, name, password, pin, otp } = {}) {
    phone = str(String(phone ?? '').replace(/[\s-]/g, ''), 'Phone number', { min: 10, max: 11, re: /^0\d{9,10}$/ });
    name = str(name, 'Name', { max: 40 });
    password = str(password, 'Password', { min: 8, max: 128 });
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw err(400, 'FIELD_INVALID', 'PIN must be exactly 4 digits.');
    if (/^(\d)\1{3}$/.test(pin) || pin === '1234') throw err(400, 'PIN_WEAK', 'Choose a less obvious PIN.');
    if (q('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw err(409, 'PHONE_TAKEN', 'That phone number is already registered.');
    if (cfg.requirePhoneOtp) usePhoneCode(phone, otp);
    const passHash = U.hashSecret(password), pinHash = U.hashSecret(pin);
    return tx(db, () => {
      // One phone number, one account (also enforced by the database's UNIQUE rule).
      if (q('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw err(409, 'PHONE_TAKEN', 'That phone number is already registered.');
      const r = q('INSERT INTO users (phone, name, pass_hash, pin_hash, phone_verified, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(phone, name, passHash, pinHash, cfg.requirePhoneOtp ? 1 : 0, now());
      if (cfg.requirePhoneOtp) q('DELETE FROM phone_otps WHERE phone = ?').run(phone);
      const id = Number(r.lastInsertRowid);
      q(`INSERT INTO accounts (owner_type, owner_id) VALUES ('user', ?)`).run(id);
      return id;
    });
  }

  function registerMerchant({ email, shopName, password } = {}) {
    email = str(email, 'Email', { min: 5, max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }).toLowerCase();
    shopName = str(shopName, 'Shop name', { max: 60 });
    password = str(password, 'Password', { min: 8, max: 128 });
    const passHash = U.hashSecret(password);
    return tx(db, () => {
      if (q('SELECT 1 FROM merchants WHERE email = ?').get(email)) throw err(409, 'EMAIL_TAKEN', 'That email is already registered.');
      let code;
      do { code = U.randomCode(8); } while (q('SELECT 1 FROM merchants WHERE store_code = ?').get(code));
      const r = q('INSERT INTO merchants (email, shop_name, pass_hash, store_code, fee_bps, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(email, shopName, passHash, code, cfg.feeBps, now());
      const id = Number(r.lastInsertRowid);
      q(`INSERT INTO accounts (owner_type, owner_id) VALUES ('merchant', ?)`).run(id);
      return id;
    });
  }

  function createAdmin({ email, password } = {}) {
    email = str(email, 'Email', { min: 5, max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }).toLowerCase();
    password = str(password, 'Password', { min: 12, max: 128 });
    if (q('SELECT 1 FROM admins WHERE email = ?').get(email)) throw err(409, 'EMAIL_TAKEN', 'That admin already exists.');
    return Number(q('INSERT INTO admins (email, pass_hash, created_at) VALUES (?, ?, ?)')
      .run(email, U.hashSecret(password), now()).lastInsertRowid);
  }

  // Used when the admin comes from hosting settings: the settings are the source of truth,
  // so changing TSUBU_ADMIN_PASSWORD and redeploying always updates the login.
  function ensureAdmin({ email, password } = {}) {
    email = str(email, 'Email', { min: 5, max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }).toLowerCase();
    password = str(password, 'Password', { min: 12, max: 128 });
    const row = q('SELECT id, pass_hash FROM admins WHERE email = ?').get(email);
    if (!row) { createAdmin({ email, password }); return 'created'; }
    if (U.verifySecret(password, row.pass_hash)) return 'unchanged';
    tx(db, () => {
      q('UPDATE admins SET pass_hash = ? WHERE id = ?').run(U.hashSecret(password), row.id);
      q(`DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ?`).run(row.id); // old logins end
    });
    return 'password updated';
  }

  // A fixed dummy hash so a wrong username takes as long as a wrong password.
  const DUMMY = U.hashSecret('dummy-password');

  function login(kind, idField, password) {
    const id = String(idField ?? '').trim();
    const row = kind === 'user' ? q('SELECT id, pass_hash FROM users WHERE phone = ?').get(id)
      : kind === 'merchant' ? q('SELECT id, pass_hash FROM merchants WHERE email = ?').get(id.toLowerCase())
        : q('SELECT id, pass_hash FROM admins WHERE email = ?').get(id.toLowerCase());
    // Sign-up trims spaces, so login must too (a pasted password often carries a space or newline).
    const ok = U.verifySecret(String(password ?? '').trim(), row ? row.pass_hash : DUMMY);
    if (!row || !ok) throw err(401, 'LOGIN_FAILED', 'Wrong login details.');
    return createSession(kind, row.id);
  }

  // Staff log in with the shop's store code + their own username + password.
  function staffLogin({ storeCode, username, password } = {}) {
    const m = q('SELECT id FROM merchants WHERE store_code = ?').get(String(storeCode ?? '').trim().toUpperCase());
    const s = m ? q('SELECT id, pass_hash, active FROM staff WHERE merchant_id = ? AND username = ?')
      .get(m.id, String(username ?? '').trim().toLowerCase()) : null;
    const ok = U.verifySecret(String(password ?? '').trim(), s ? s.pass_hash : DUMMY);
    if (!s || !ok || !s.active) throw err(401, 'LOGIN_FAILED', 'Wrong login details.');
    return createSession('merchant', m.id, s.id);
  }

  function createSession(kind, id, staffId = null) {
    const token = U.newSessionToken();
    const ttl = { user: cfg.userSessionMs, merchant: cfg.merchantSessionMs, admin: cfg.adminSessionMs }[kind];
    q('INSERT INTO sessions (token_hash, kind, subject_id, staff_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(U.sha256(token), kind, id, staffId, now() + ttl, now());
    return { token, maxAgeSec: Math.floor(ttl / 1000) };
  }

  // Returns { id, staffId } or null. Staff sessions die the moment the staff member is deactivated.
  function session(token, kind) {
    if (!token) return null;
    const s = q('SELECT subject_id, staff_id, expires_at FROM sessions WHERE token_hash = ? AND kind = ?').get(U.sha256(token), kind);
    if (!s || s.expires_at <= now()) return null;
    if (s.staff_id) {
      const st = q('SELECT active, merchant_id FROM staff WHERE id = ?').get(s.staff_id);
      if (!st || !st.active || st.merchant_id !== s.subject_id) return null;
    }
    return { id: s.subject_id, staffId: s.staff_id || null };
  }
  const sessionSubject = (token, kind) => session(token, kind)?.id ?? null;

  function logout(token) {
    if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(U.sha256(token));
  }

  function userProfile(id) {
    const u = q('SELECT id, phone, name, frozen, kyc_status, phone_verified FROM users WHERE id = ?').get(id);
    if (!u) throw err(404, 'NOT_FOUND', 'User not found.');
    return { id: u.id, phone: u.phone, name: u.name, frozen: !!u.frozen, balance: account('user', id).balance,
      kycStatus: cfg.requireKyc ? u.kyc_status : 'approved', phoneVerified: !!u.phone_verified };
  }

  function merchantProfile(id, staffId = null) {
    const m = q('SELECT id, email, shop_name, store_code, fee_bps, frozen, kyc_status FROM merchants WHERE id = ?').get(id);
    if (!m) throw err(404, 'NOT_FOUND', 'Shop not found.');
    const st = staffId ? q('SELECT name, username FROM staff WHERE id = ?').get(staffId) : null;
    const base = {
      id: m.id, shopName: m.shop_name, storeCode: m.store_code, frozen: !!m.frozen,
      kycStatus: cfg.requireKyc ? m.kyc_status : 'approved',
      storeQr: `TSUBUPAY:STORE:${m.store_code}`,
      role: staffId ? 'cashier' : 'owner', staffName: st?.name ?? null,
    };
    if (staffId) return base; // cashiers do not see the balance, email or fee
    return { ...base, email: m.email, feeBps: m.fee_bps, balance: account('merchant', id).balance };
  }

  // ---------- staff management (owner only) ----------
  function staffView(r) { return { id: r.id, name: r.name, username: r.username, active: !!r.active, createdAt: r.created_at }; }

  function listStaff(actor) {
    requireOwner(actor);
    return q('SELECT * FROM staff WHERE merchant_id = ? ORDER BY active DESC, name').all(actor.merchantId).map(staffView);
  }

  function createStaff(actor, { name, username, password } = {}) {
    requireOwner(actor);
    name = str(name, 'Staff name', { max: 40 });
    username = str(username, 'Username', { min: 3, max: 20, re: /^[A-Za-z0-9_]+$/ }).toLowerCase();
    password = str(password, 'Password', { min: 8, max: 128 });
    const hash = U.hashSecret(password);
    return tx(db, () => {
      if (q('SELECT 1 FROM staff WHERE merchant_id = ? AND username = ?').get(actor.merchantId, username))
        throw err(409, 'USERNAME_TAKEN', 'That username is already used in your shop.');
      const id = Number(q('INSERT INTO staff (merchant_id, name, username, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(actor.merchantId, name, username, hash, now()).lastInsertRowid);
      return staffView(q('SELECT * FROM staff WHERE id = ?').get(id));
    });
  }

  function ownStaff(actor, staffId) {
    const s = q('SELECT * FROM staff WHERE id = ? AND merchant_id = ?').get(Number(staffId), actor.merchantId);
    if (!s) throw err(404, 'NOT_FOUND', 'Staff member not found.');
    return s;
  }

  function setStaffActive(actor, { staffId, active } = {}) {
    requireOwner(actor);
    if (typeof active !== 'boolean') throw err(400, 'FIELD_INVALID', 'active must be true or false.');
    return tx(db, () => {
      const s = ownStaff(actor, staffId);
      q('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, s.id);
      if (!active) q('DELETE FROM sessions WHERE staff_id = ?').run(s.id); // log them out everywhere now
      return staffView(q('SELECT * FROM staff WHERE id = ?').get(s.id));
    });
  }

  function resetStaffPassword(actor, { staffId, password } = {}) {
    requireOwner(actor);
    password = str(password, 'Password', { min: 8, max: 128 });
    const hash = U.hashSecret(password);
    return tx(db, () => {
      const s = ownStaff(actor, staffId);
      q('UPDATE staff SET pass_hash = ? WHERE id = ?').run(hash, s.id);
      q('DELETE FROM sessions WHERE staff_id = ?').run(s.id);
      return staffView(q('SELECT * FROM staff WHERE id = ?').get(s.id));
    });
  }

  // ---------- customer-presented code (CPM) ----------
  function issuePayCode(userId) {
    userOk(userId);
    kycOk('user', userId);
    return tx(db, () => {
      const t = now();
      const code = U.newPayCode();
      q('INSERT INTO pay_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(U.sha256(code), userId, t + cfg.codeTtlMs, t);
      // keep only the newest N live codes; revoke the rest
      const live = q(`SELECT code_hash FROM pay_codes WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL
                      AND expires_at > ? ORDER BY created_at DESC, rowid DESC`).all(userId, t);
      const rev = q('UPDATE pay_codes SET revoked_at = ? WHERE code_hash = ?');
      for (const r of live.slice(cfg.maxActiveCodes)) rev.run(t, r.code_hash);
      // housekeeping: forget codes that died more than a day ago
      q('DELETE FROM pay_codes WHERE expires_at < ?').run(t - 24 * 3600 * 1000);
      return { code, expiresAt: t + cfg.codeTtlMs, ttlMs: cfg.codeTtlMs };
    });
  }

  function chargeByCode(actor, { code, amount } = {}, idemKey) {
    const merchantId = actor.merchantId;
    code = String(code ?? '').replace(/[\s-]/g, '');
    amount = amountOrThrow(amount, cfg.paymentMax);
    if (!/^88\d{16}$/.test(code) || !U.luhnValid(code)) throw err(400, 'CODE_INVALID', 'That is not a valid TsubuPay code. Scan again.');
    merchantOk(merchantId, 'Your shop');
    kycOk('merchant', merchantId, 'KYC_REQUIRED', 'The shop owner must verify their identity before taking payments.');
    return run(`charge:${merchantId}`, idemKey, `${code}|${amount}`, () => {
      const t = now();
      const pc = q('SELECT * FROM pay_codes WHERE code_hash = ?').get(U.sha256(code));
      if (!pc || pc.revoked_at) throw err(404, 'CODE_NOT_FOUND', 'Code not recognised. Ask the customer to refresh their code.');
      if (pc.used_at) throw err(409, 'CODE_USED', 'This code was already used. Ask the customer to refresh.');
      if (pc.expires_at <= t) throw err(410, 'CODE_EXPIRED', 'This code has expired. Ask the customer to refresh.');
      userOk(pc.user_id, 'The customer\'s account');
      kycOk('user', pc.user_id, 'KYC_REQUIRED', 'The customer has not finished identity verification.');
      const m = q('SELECT id, fee_bps FROM merchants WHERE id = ?').get(merchantId);
      const ua = account('user', pc.user_id);
      if (ua.balance < amount) throw err(402, 'INSUFFICIENT_FUNDS', 'Customer balance is too low. Ask them to top up.');
      q('UPDATE pay_codes SET used_at = ? WHERE code_hash = ?').run(t, pc.code_hash);
      const fee = feeFor(amount, m.fee_bps);
      const id = insertTx({ type: 'payment', method: 'cpm', amount, fee, userId: pc.user_id, merchantId, staffId: actor.staffId });
      post(id, [[ua.id, -amount], [account('merchant', merchantId).id, amount - fee], [account('platform', 0).id, fee]]);
      const view = getTx(id);
      return {
        result: forActor(actor, view),
        events: [[`user:${pc.user_id}`, { type: 'payment', tx: userTxView(q('SELECT * FROM transactions WHERE id = ?').get(id), pc.user_id) }],
          [`merchant:${merchantId}`, { type: 'payment', tx: shopEvent(view) }]],
      };
    });
  }

  // ---------- merchant-presented code (MPM) ----------
  function parseStoreCode(input) {
    const s = String(input ?? '').trim().toUpperCase();
    const m = /^(?:TSUBUPAY:STORE:)?([A-Z2-9]{8})$/.exec(s);
    if (!m) throw err(400, 'STORE_INVALID', 'That is not a TsubuPay store code.');
    return m[1];
  }

  function lookupStore(input) {
    const code = parseStoreCode(input);
    const m = q('SELECT shop_name, store_code, frozen FROM merchants WHERE store_code = ?').get(code);
    if (!m) throw err(404, 'STORE_NOT_FOUND', 'Store not found.');
    if (m.frozen) throw err(403, 'STORE_UNAVAILABLE', 'This shop cannot accept TsubuPay right now.');
    const mid = q('SELECT id FROM merchants WHERE store_code = ?').get(m.store_code).id;
    if (!isVerified('merchant', mid)) throw err(403, 'STORE_UNAVAILABLE', 'This shop cannot accept TsubuPay yet (owner not verified).');
    return { shopName: m.shop_name, storeCode: m.store_code };
  }

  function checkPin(userId, pin) {
    const u = q('SELECT pin_hash, pin_fails, pin_locked_until FROM users WHERE id = ?').get(userId);
    const t = now();
    if (u.pin_locked_until > t) {
      const mins = Math.ceil((u.pin_locked_until - t) / 60000);
      throw err(423, 'PIN_LOCKED', `Too many wrong PINs. Try again in ${mins} minute(s).`);
    }
    if (typeof pin === 'string' && /^\d{4}$/.test(pin) && U.verifySecret(pin, u.pin_hash)) {
      if (u.pin_fails) q('UPDATE users SET pin_fails = 0 WHERE id = ?').run(userId);
      return;
    }
    const fails = u.pin_fails + 1;
    if (fails >= cfg.pinMaxFails) {
      q('UPDATE users SET pin_fails = 0, pin_locked_until = ? WHERE id = ?').run(t + cfg.pinLockMs, userId);
      return { locked: true };
    }
    q('UPDATE users SET pin_fails = ? WHERE id = ?').run(fails, userId);
    return { left: cfg.pinMaxFails - fails };
  }

  // PIN failures must be saved even though the payment is refused,
  // so the check runs in its own committed transaction first.
  function pinOrThrow(userId, pin) {
    const r = tx(db, () => checkPin(userId, pin));
    if (r?.locked) throw err(423, 'PIN_LOCKED', 'Too many wrong PINs. Payments are locked for 15 minutes.');
    if (r) throw err(401, 'PIN_WRONG', `Wrong PIN. ${r.left} attempt(s) left.`);
  }

  function payStore(userId, { storeCode, amount, pin } = {}, idemKey) {
    const code = parseStoreCode(storeCode);
    amount = amountOrThrow(amount, cfg.paymentMax);
    userOk(userId);
    kycOk('user', userId);
    pinOrThrow(userId, pin);
    return run(`pay:${userId}`, idemKey, `${code}|${amount}`, () => {
      const m = q('SELECT id, fee_bps, frozen FROM merchants WHERE store_code = ?').get(code);
      if (!m) throw err(404, 'STORE_NOT_FOUND', 'Store not found.');
      if (m.frozen || !isVerified('merchant', m.id)) throw err(403, 'STORE_UNAVAILABLE', 'This shop cannot accept TsubuPay right now.');
      const ua = account('user', userId);
      if (ua.balance < amount) throw err(402, 'INSUFFICIENT_FUNDS', 'Your balance is too low. Please top up.');
      const fee = feeFor(amount, m.fee_bps);
      const id = insertTx({ type: 'payment', method: 'mpm', amount, fee, userId, merchantId: m.id });
      post(id, [[ua.id, -amount], [account('merchant', m.id).id, amount - fee], [account('platform', 0).id, fee]]);
      const row = q('SELECT * FROM transactions WHERE id = ?').get(id);
      const uv = userTxView(row, userId);
      return { result: uv, events: [[`user:${userId}`, { type: 'payment', tx: uv }], [`merchant:${m.id}`, { type: 'payment', tx: shopEvent(txView(row)) }]] };
    });
  }

  // ---------- customer-to-customer transfers ----------
  function normalisePhone(v) { return String(v ?? '').replace(/[\s-]/g, ''); }

  function lookupRecipient(userId, phone) {
    phone = normalisePhone(phone);
    if (!/^0\d{9,10}$/.test(phone)) throw err(400, 'FIELD_INVALID', 'Enter a phone number like 09012345678.');
    const r = q('SELECT id, name, frozen FROM users WHERE phone = ?').get(phone);
    if (!r) throw err(404, 'RECIPIENT_NOT_FOUND', 'No TsubuPay account uses that number.');
    if (r.id === userId) throw err(400, 'SELF_TRANSFER', 'You cannot send money to yourself.');
    if (r.frozen || !isVerified('user', r.id)) throw err(403, 'RECIPIENT_UNAVAILABLE', 'This person cannot receive money right now.');
    return { name: r.name, phone: phone.slice(0, 3) + '****' + phone.slice(-4) };
  }

  function transfer(userId, { toPhone, amount, pin, message } = {}, idemKey) {
    const phone = normalisePhone(toPhone);
    amount = amountOrThrow(amount, cfg.transferMax);
    message = optStr(message, 'Message', 50);
    userOk(userId);
    kycOk('user', userId);
    lookupRecipient(userId, phone);
    pinOrThrow(userId, pin);
    return run(`transfer:${userId}`, idemKey, `${phone}|${amount}|${message ?? ''}`, () => {
      const to = q('SELECT id, frozen FROM users WHERE phone = ?').get(phone);
      if (!to || to.frozen || !isVerified('user', to.id)) throw err(403, 'RECIPIENT_UNAVAILABLE', 'This person cannot receive money right now.');
      const from = account('user', userId), dest = account('user', to.id);
      if (from.balance < amount) throw err(402, 'INSUFFICIENT_FUNDS', 'Your balance is too low. Please top up.');
      if (dest.balance + amount > cfg.walletMax) throw err(400, 'RECIPIENT_WALLET_LIMIT', 'The recipient\'s wallet is full. Try a smaller amount.');
      const id = insertTx({ type: 'transfer', amount, userId, toUserId: to.id, note: message });
      post(id, [[from.id, -amount], [dest.id, amount]]);
      const row = q('SELECT * FROM transactions WHERE id = ?').get(id);
      const out = userTxView(row, userId);
      return { result: out, events: [[`user:${userId}`, { type: 'transfer', tx: out }], [`user:${to.id}`, { type: 'transfer', tx: userTxView(row, to.id) }]] };
    });
  }

  // ---------- top-up, refund, payout ----------
  function topup(userId, { amount } = {}, idemKey) {
    amount = amountOrThrow(amount, cfg.topupMax, cfg.topupMin);
    userOk(userId);
    kycOk('user', userId);
    return run(`topup:${userId}`, idemKey, `${amount}`, () => {
      const ua = account('user', userId);
      if (ua.balance + amount > cfg.walletMax)
        throw err(400, 'WALLET_LIMIT', `Wallet balance cannot exceed ${cfg.walletMax.toLocaleString('en')} yen.`);
      const id = insertTx({ type: 'topup', amount, userId, note: 'Bank top-up (simulated)' });
      post(id, [[account('external', 0).id, -amount], [ua.id, amount]]);
      const uv = userTxView(q('SELECT * FROM transactions WHERE id = ?').get(id), userId);
      return { result: uv, events: [[`user:${userId}`, { type: 'topup', tx: uv }]] };
    });
  }

  // Refunds are allowed even for a frozen shop: returning money to customers is always safe.
  function refund(actor, { txId, amount, reason } = {}, idemKey) {
    requireOwner(actor);
    const merchantId = actor.merchantId;
    txId = str(txId, 'Transaction ID', { max: 32 });
    const note = optStr(reason, 'Reason', 200);
    return run(`refund:${merchantId}`, idemKey, `${txId}|${amount ?? ''}`, () => {
      const p = q('SELECT * FROM transactions WHERE id = ?').get(txId);
      if (!p || p.merchant_id !== merchantId || p.type !== 'payment') throw err(404, 'TX_NOT_FOUND', 'Payment not found for this shop.');
      const left = p.amount - p.refunded_amount;
      if (left <= 0) throw err(409, 'ALREADY_REFUNDED', 'This payment is already fully refunded.');
      const amt = amount == null || amount === '' ? left : amountOrThrow(amount, left);
      // Fee is returned in proportion, rounded so a full refund returns exactly the whole fee.
      const newRefunded = p.refunded_amount + amt;
      const feeBack = Math.floor((p.fee * newRefunded) / p.amount) - p.refunded_fee;
      const ma = account('merchant', merchantId);
      if (ma.balance < amt - feeBack) throw err(402, 'MERCHANT_FUNDS_LOW', 'Shop balance is too low to cover this refund.');
      q('UPDATE transactions SET refunded_amount = ?, refunded_fee = refunded_fee + ? WHERE id = ?').run(newRefunded, feeBack, p.id);
      const id = insertTx({ type: 'refund', amount: amt, fee: feeBack, userId: p.user_id, merchantId, refTx: p.id, note });
      post(id, [[account('user', p.user_id).id, amt], [ma.id, -(amt - feeBack)], [account('platform', 0).id, -feeBack]]);
      const row = q('SELECT * FROM transactions WHERE id = ?').get(id);
      const view = txView(row);
      return {
        result: view,
        events: [[`user:${p.user_id}`, { type: 'refund', tx: userTxView(row, p.user_id) }], [`merchant:${merchantId}`, { type: 'refund', tx: shopEvent(view) }]],
      };
    });
  }

  function payout(actor, { amount } = {}, idemKey) {
    requireOwner(actor);
    const merchantId = actor.merchantId;
    merchantOk(merchantId, 'Your shop');
    kycOk('merchant', merchantId, 'KYC_REQUIRED', 'Verify your identity before paying out.');
    return run(`payout:${merchantId}`, idemKey, `${amount ?? ''}`, () => {
      const ma = account('merchant', merchantId);
      if (ma.balance <= 0) throw err(400, 'NOTHING_TO_PAY', 'There is no balance to pay out.');
      const amt = amount == null || amount === '' ? ma.balance : amountOrThrow(amount, ma.balance);
      const id = insertTx({ type: 'payout', amount: amt, merchantId, note: 'Bank payout (simulated)' });
      post(id, [[ma.id, -amt], [account('external', 0).id, amt]]);
      const view = getTx(id);
      return { result: view, events: [[`merchant:${merchantId}`, { type: 'payout', tx: shopEvent(view) }]] };
    });
  }

  // ---------- history & reports ----------
  const clampLimit = (l) => Math.min(Math.max(Number.parseInt(l, 10) || 50, 1), 200);

  function userHistory(userId, limit) {
    return q(`SELECT * FROM transactions WHERE user_id = ? OR to_user_id = ?
              ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(userId, userId, clampLimit(limit))
      .map((r) => userTxView(r, userId));
  }

  // Cashiers see payments and refunds only; payouts are the owner's business.
  function merchantHistory(actor, limit) {
    const sql = actor.staffId
      ? `SELECT * FROM transactions WHERE merchant_id = ? AND type IN ('payment','refund') ORDER BY created_at DESC, rowid DESC LIMIT ?`
      : 'SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?';
    return q(sql).all(actor.merchantId, clampLimit(limit)).map((r) => {
      const v = txView(r);
      if (actor.staffId) { delete v.fee; delete v.net; }
      return v;
    });
  }

  const JST = 9 * 3600 * 1000, DAY = 24 * 3600 * 1000;
  const startOfTodayJst = () => Math.floor((now() + JST) / DAY) * DAY - JST;

  // Today's totals in Japan time (UTC+9, no daylight saving).
  function merchantToday(merchantId) {
    const start = startOfTodayJst();
    const pay = q(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) gross, COALESCE(SUM(fee),0) fee FROM transactions
                   WHERE merchant_id = ? AND type = 'payment' AND created_at >= ?`).get(merchantId, start);
    const ref = q(`SELECT COALESCE(SUM(amount),0) amt, COALESCE(SUM(fee),0) fee FROM transactions
                   WHERE merchant_id = ? AND type = 'refund' AND created_at >= ?`).get(merchantId, start);
    return {
      payments: pay.n, gross: pay.gross, refunds: ref.amt,
      fees: pay.fee - ref.fee, net: pay.gross - pay.fee - (ref.amt - ref.fee),
    };
  }

  // ---------- receipts ----------
  // viewer: { userId } | { merchantId } | { adminId }. Anyone not involved gets "not found".
  function receipt(id, viewer) {
    const row = q('SELECT * FROM transactions WHERE id = ?').get(String(id ?? ''));
    const allowed = row && (viewer.adminId || (viewer.userId && (row.user_id === viewer.userId || row.to_user_id === viewer.userId))
      || (viewer.merchantId && row.merchant_id === viewer.merchantId));
    if (!allowed) throw err(404, 'NOT_FOUND', 'Receipt not found.');
    const forCustomer = !!viewer.userId && !viewer.adminId && !viewer.merchantId;
    const view = forCustomer ? userTxView(row, viewer.userId) : txView(row);
    if (viewer.merchantId && viewer.staffId) { delete view.fee; delete view.net; }
    const related = row.type === 'payment'
      ? q(`SELECT * FROM transactions WHERE ref_tx = ? ORDER BY created_at`).all(row.id)
      : row.ref_tx ? [q('SELECT * FROM transactions WHERE id = ?').get(row.ref_tx)] : [];
    return {
      ...view,
      related: related.map((r) => ({ id: r.id, type: r.type, amount: r.amount, createdAt: r.created_at })),
      issuer: 'TsubuPay',
    };
  }

  // ---------- identity verification (KYC) ----------
  const subjTable = (t) => (t === 'user' ? 'users' : t === 'merchant' ? 'merchants' : null);

  function kycChallenge(type, id) {
    const current = q('SELECT kyc_status FROM ' + subjTable(type) + ' WHERE id = ?').get(id);
    if (current.kyc_status === 'approved') throw err(409, 'ALREADY_VERIFIED', 'Your identity is already verified.');
    const gesture = GESTURES[require('node:crypto').randomInt(GESTURES.length)];
    q(`INSERT INTO kyc_challenges (subject_type, subject_id, gesture, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(subject_type, subject_id) DO UPDATE SET gesture = excluded.gesture, expires_at = excluded.expires_at`)
      .run(type, id, gesture, now() + cfg.kycChallengeMs);
    return { gesture, expiresInSec: Math.round(cfg.kycChallengeMs / 1000) };
  }

  function kycInfo(type, id) {
    const subj = q('SELECT kyc_status FROM ' + subjTable(type) + ' WHERE id = ?').get(id);
    const last = q(`SELECT doc_type, status, reason, created_at, reviewed_at FROM kyc_submissions
                    WHERE subject_type = ? AND subject_id = ? ORDER BY id DESC LIMIT 1`).get(type, id);
    return { status: cfg.requireKyc ? subj.kyc_status : 'approved', required: cfg.requireKyc,
      lastSubmission: last ? { docType: last.doc_type, status: last.status, reason: last.reason, submittedAt: last.created_at, reviewedAt: last.reviewed_at } : null };
  }

  // Accepts a data URL or bare base64; checks it really is a JPEG or PNG of a sensible size.
  function image(v, name) {
    if (typeof v !== 'string' || !v) throw err(400, 'IMAGE_MISSING', `${name} photo is required.`);
    const b64 = v.replace(/^data:image\/(jpeg|png);base64,/, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw err(400, 'IMAGE_INVALID', `${name} photo is not a valid image.`);
    const buf = Buffer.from(b64, 'base64');
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!jpeg && !png) throw err(400, 'IMAGE_INVALID', `${name} photo must be a JPEG or PNG image.`);
    if (buf.length < 2000) throw err(400, 'IMAGE_INVALID', `${name} photo is too small to read.`);
    if (buf.length > 1_500_000) throw err(400, 'IMAGE_TOO_LARGE', `${name} photo is too large (max 1.5 MB).`);
    return buf;
  }

  function submitKyc(type, id, b = {}) {
    if (!subjTable(type)) throw err(400, 'FIELD_INVALID', 'Unknown account type.');
    const rule = DOC_RULES[b.docType];
    if (!rule) throw err(400, 'FIELD_INVALID', 'Choose a driver\'s licence, residence card or passport.');
    const legalName = str(b.legalName, 'Full legal name', { min: 2, max: 60 });
    const birthDate = str(b.birthDate, 'Date of birth', { min: 10, max: 10, re: /^\d{4}-\d{2}-\d{2}$/ });
    const bd = new Date(birthDate + 'T00:00:00Z');
    if (Number.isNaN(bd.getTime()) || bd.toISOString().slice(0, 10) !== birthDate || bd.getUTCFullYear() < 1900 || bd.getTime() > now())
      throw err(400, 'FIELD_INVALID', 'Date of birth is not a real date.');
    const address = str(b.address, 'Address', { min: 5, max: 200 });
    const docNumber = String(b.docNumber ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!rule.re.test(docNumber)) throw err(400, 'FIELD_INVALID', `Enter a valid ${rule.label}.`);
    const front = image(b.docFront, 'Front of ID');
    const back = rule.back ? image(b.docBack, 'Back of ID') : null;
    const selfie = image(b.selfie, 'Selfie');
    const docHash = require('node:crypto').createHmac('sha256', String(cfg.kycPepper)).update(`${b.docType}:${docNumber}`).digest('hex');

    return tx(db, () => {
      const subj = q('SELECT kyc_status FROM ' + subjTable(type) + ' WHERE id = ?').get(id);
      if (subj.kyc_status === 'approved') throw err(409, 'ALREADY_VERIFIED', 'Your identity is already verified.');
      if (subj.kyc_status === 'pending') throw err(409, 'KYC_PENDING', 'Your documents are already being reviewed.');
      const ch = q('SELECT gesture, expires_at FROM kyc_challenges WHERE subject_type = ? AND subject_id = ?').get(type, id);
      if (!ch || ch.expires_at <= now()) throw err(400, 'CHALLENGE_EXPIRED', 'The selfie instruction expired. Take the selfie again.');
      // One person, one account: the same ID document cannot verify another account.
      const dup = q(`SELECT 1 FROM kyc_submissions WHERE doc_hash = ? AND status IN ('pending','approved')
                     AND NOT (subject_type = ? AND subject_id = ?)`).get(docHash, type, id);
      if (dup) throw err(409, 'DOC_ALREADY_USED', 'This ID document is already used by another TsubuPay account.');
      const r = q(`INSERT INTO kyc_submissions (subject_type, subject_id, doc_type, legal_name, birth_date, address, doc_hash, doc_last4,
                   doc_front, doc_back, selfie, gesture, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(type, id, b.docType, legalName, birthDate, address, docHash, docNumber.slice(-4), front, back, selfie, ch.gesture, now());
      q(`UPDATE ${subjTable(type)} SET kyc_status = 'pending' WHERE id = ?`).run(id);
      q('DELETE FROM kyc_challenges WHERE subject_type = ? AND subject_id = ?').run(type, id);
      return { id: Number(r.lastInsertRowid), status: 'pending' };
    });
  }

  function adminKycList({ status = 'pending', limit } = {}) {
    const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
    return q(`SELECT k.id, k.subject_type, k.subject_id, k.doc_type, k.legal_name, k.birth_date, k.address, k.doc_last4, k.gesture,
                     k.status, k.reason, k.created_at, k.reviewed_at, (k.doc_back IS NOT NULL) has_back,
                     (SELECT COUNT(*) FROM kyc_submissions o WHERE o.doc_hash = k.doc_hash
                        AND NOT (o.subject_type = k.subject_type AND o.subject_id = k.subject_id)) other_accounts
              FROM kyc_submissions k WHERE k.status = ? ORDER BY k.created_at ${st === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(st, clampLimit(limit)).map((r) => {
        const acct = r.subject_type === 'user'
          ? q('SELECT name, phone, phone_verified FROM users WHERE id = ?').get(r.subject_id)
          : q('SELECT shop_name, email FROM merchants WHERE id = ?').get(r.subject_id);
        return { id: r.id, subjectType: r.subject_type, subjectId: r.subject_id,
          account: r.subject_type === 'user' ? `${acct.name} · ${acct.phone}${acct.phone_verified ? ' ✓' : ''}` : `${acct.shop_name} · ${acct.email}`,
          docType: r.doc_type, legalName: r.legal_name, birthDate: r.birth_date, address: r.address, docLast4: r.doc_last4,
          gesture: r.gesture, status: r.status, reason: r.reason, hasBack: !!r.has_back, otherAccounts: r.other_accounts,
          createdAt: r.created_at, reviewedAt: r.reviewed_at };
      });
  }

  function adminKycImage(id, which) {
    const col = { front: 'doc_front', back: 'doc_back', selfie: 'selfie' }[which];
    if (!col) throw err(400, 'FIELD_INVALID', 'which must be front, back or selfie.');
    const r = q(`SELECT ${col} img FROM kyc_submissions WHERE id = ?`).get(Number(id));
    if (!r || !r.img) throw err(404, 'NOT_FOUND', 'Image not found.');
    const buf = Buffer.from(r.img);
    return { buf, type: buf[0] === 0xff ? 'image/jpeg' : 'image/png' };
  }

  function adminKycReview(adminId, { id, decision, reason } = {}) {
    if (decision !== 'approve' && decision !== 'reject') throw err(400, 'FIELD_INVALID', 'decision must be approve or reject.');
    reason = decision === 'reject' ? str(reason, 'Reason', { min: 3, max: 200 }) : optStr(reason, 'Note', 200);
    const out = tx(db, () => {
      const k = q('SELECT * FROM kyc_submissions WHERE id = ?').get(Number(id));
      if (!k) throw err(404, 'NOT_FOUND', 'Submission not found.');
      if (k.status !== 'pending') throw err(409, 'ALREADY_REVIEWED', 'This submission was already reviewed.');
      if (decision === 'approve' && q(`SELECT 1 FROM kyc_submissions WHERE doc_hash = ? AND status = 'approved' AND id <> ?`).get(k.doc_hash, k.id))
        throw err(409, 'DOC_ALREADY_USED', 'This ID document already verified another account. Reject this one.');
      const status = decision === 'approve' ? 'approved' : 'rejected';
      q('UPDATE kyc_submissions SET status = ?, reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(status, reason, adminId, now(), k.id);
      q(`UPDATE ${subjTable(k.subject_type)} SET kyc_status = ? WHERE id = ?`).run(status, k.subject_id);
      adminLog(adminId, decision === 'approve' ? 'kyc_approve' : 'kyc_reject', k.subject_type, k.subject_id, reason);
      return { k, status };
    });
    events.emit(`${out.k.subject_type}:${out.k.subject_id}`, { type: 'kyc', status: out.status, reason });
    return { id: out.k.id, status: out.status };
  }

  // ---------- admin ----------
  function adminLog(adminId, action, targetType, targetId, reason) {
    q('INSERT INTO admin_log (admin_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(adminId, action, targetType, targetId, reason, now());
  }

  function adminOverview() {
    const n = (sql, ...a) => q(sql).get(...a).n;
    const start = startOfTodayJst();
    const sumBal = (type) => q('SELECT COALESCE(SUM(balance),0) n FROM accounts WHERE owner_type = ?').get(type).n;
    return {
      users: n('SELECT COUNT(*) n FROM users'), frozenUsers: n('SELECT COUNT(*) n FROM users WHERE frozen = 1'),
      merchants: n('SELECT COUNT(*) n FROM merchants'), frozenMerchants: n('SELECT COUNT(*) n FROM merchants WHERE frozen = 1'),
      kycPending: n(`SELECT COUNT(*) n FROM kyc_submissions WHERE status = 'pending'`),
      kycApproved: n(`SELECT COUNT(*) n FROM users WHERE kyc_status = 'approved'`) + n(`SELECT COUNT(*) n FROM merchants WHERE kyc_status = 'approved'`),
      today: {
        transactions: n('SELECT COUNT(*) n FROM transactions WHERE created_at >= ?', start),
        paymentVolume: n(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE type = 'payment' AND created_at >= ?`, start),
        transferVolume: n(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE type = 'transfer' AND created_at >= ?`, start),
      },
      money: {
        customerWallets: sumBal('user'), shopBalances: sumBal('merchant'), platformFees: sumBal('platform'),
        // money held for customers and shops = what came in from banks minus what went out
        heldTotal: -sumBal('external'),
      },
      audit: auditLedger(),
    };
  }

  function adminUsers(search, limit) {
    const s = `%${String(search ?? '').trim()}%`;
    return q(`SELECT u.id, u.phone, u.name, u.frozen, u.frozen_reason, u.created_at, u.kyc_status, a.balance FROM users u
              JOIN accounts a ON a.owner_type = 'user' AND a.owner_id = u.id
              WHERE u.phone LIKE ? OR u.name LIKE ? ORDER BY u.id DESC LIMIT ?`).all(s, s, clampLimit(limit))
      .map((r) => ({ id: r.id, phone: r.phone, name: r.name, frozen: !!r.frozen, frozenReason: r.frozen_reason, balance: r.balance, createdAt: r.created_at, kycStatus: r.kyc_status }));
  }

  function adminMerchants(search, limit) {
    const s = `%${String(search ?? '').trim()}%`;
    return q(`SELECT m.id, m.email, m.shop_name, m.store_code, m.frozen, m.frozen_reason, m.created_at, m.kyc_status, a.balance,
                     (SELECT COUNT(*) FROM staff st WHERE st.merchant_id = m.id AND st.active = 1) staff
              FROM merchants m JOIN accounts a ON a.owner_type = 'merchant' AND a.owner_id = m.id
              WHERE m.shop_name LIKE ? OR m.email LIKE ? OR m.store_code LIKE ? ORDER BY m.id DESC LIMIT ?`)
      .all(s, s, s, clampLimit(limit))
      .map((r) => ({ id: r.id, email: r.email, shopName: r.shop_name, storeCode: r.store_code, frozen: !!r.frozen,
        frozenReason: r.frozen_reason, balance: r.balance, staff: r.staff, createdAt: r.created_at, kycStatus: r.kyc_status }));
  }

  function adminTransactions({ type, search, limit } = {}) {
    const types = ['topup', 'payment', 'refund', 'payout', 'transfer'];
    const where = [], args = [];
    if (type && types.includes(type)) { where.push('type = ?'); args.push(type); }
    if (search) { where.push('id LIKE ?'); args.push(`%${String(search).trim().toUpperCase()}%`); }
    const sql = `SELECT * FROM transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return q(sql).all(...args, clampLimit(limit)).map(txView);
  }

  function adminSetFrozen(adminId, { kind, id, frozen, reason } = {}) {
    if (kind !== 'user' && kind !== 'merchant') throw err(400, 'FIELD_INVALID', 'kind must be user or merchant.');
    if (typeof frozen !== 'boolean') throw err(400, 'FIELD_INVALID', 'frozen must be true or false.');
    reason = frozen ? str(reason, 'Reason', { min: 3, max: 200 }) : optStr(reason, 'Reason', 200);
    const table = kind === 'user' ? 'users' : 'merchants';
    return tx(db, () => {
      const row = q(`SELECT id FROM ${table} WHERE id = ?`).get(Number(id));
      if (!row) throw err(404, 'NOT_FOUND', 'Account not found.');
      q(`UPDATE ${table} SET frozen = ?, frozen_reason = ? WHERE id = ?`).run(frozen ? 1 : 0, frozen ? reason : null, row.id);
      adminLog(adminId, frozen ? 'freeze' : 'unfreeze', kind, row.id, reason);
      return { kind, id: row.id, frozen };
    });
  }

  function adminLogList(limit) {
    return q(`SELECT l.*, a.email FROM admin_log l JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT ?`)
      .all(clampLimit(limit)).map((r) => ({ id: r.id, admin: r.email, action: r.action, targetType: r.target_type,
        targetId: r.target_id, reason: r.reason, createdAt: r.created_at }));
  }

  function adminProfile(id) {
    const a = q('SELECT id, email FROM admins WHERE id = ?').get(id);
    if (!a) throw err(404, 'NOT_FOUND', 'Admin not found.');
    return a;
  }

  // ---------- integrity audit ----------
  function auditLedger() {
    const problems = [];
    const unbalanced = q('SELECT tx_id, SUM(delta) s FROM entries GROUP BY tx_id HAVING s <> 0').all();
    for (const r of unbalanced) problems.push(`tx ${r.tx_id} entries sum to ${r.s}`);
    const mismatch = q(`SELECT a.id, a.balance, COALESCE(SUM(e.delta),0) s FROM accounts a
                        LEFT JOIN entries e ON e.account_id = a.id GROUP BY a.id HAVING a.balance <> s`).all();
    for (const r of mismatch) problems.push(`account ${r.id} balance ${r.balance} but entries sum ${r.s}`);
    const total = q('SELECT COALESCE(SUM(balance),0) s FROM accounts').get().s;
    if (total !== 0) problems.push(`all balances sum to ${total}, expected 0`);
    return { ok: problems.length === 0, problems };
  }

  return {
    cfg, events,
    registerUser, registerMerchant, createAdmin, ensureAdmin, requestPhoneCode, cancelPhoneCode,
    kycChallenge, kycInfo, submitKyc, adminKycList, adminKycImage, adminKycReview, login, staffLogin, session, sessionSubject, logout,
    userProfile, merchantProfile, adminProfile,
    listStaff, createStaff, setStaffActive, resetStaffPassword,
    issuePayCode, chargeByCode, lookupStore, payStore, lookupRecipient, transfer,
    topup, refund, payout,
    userHistory, merchantHistory, merchantToday, getTx, receipt,
    adminOverview, adminUsers, adminMerchants, adminTransactions, adminSetFrozen, adminLogList,
    auditLedger,
  };
}

module.exports = { createService, DEFAULTS };
