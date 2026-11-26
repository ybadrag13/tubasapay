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
  pinMaxFails: 5,
  pinLockMs: 15 * 60 * 1000,
  userSessionMs: 30 * 24 * 3600 * 1000,
  merchantSessionMs: 7 * 24 * 3600 * 1000,
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
    q(`INSERT INTO transactions (id, type, method, amount, fee, user_id, merchant_id, ref_tx, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, t.type, t.method ?? null, t.amount, t.fee ?? 0, t.userId ?? null, t.merchantId ?? null,
      t.refTx ?? null, t.note ?? null, now());
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

  function txView(row) {
    if (!row) return null;
    const m = row.merchant_id ? q('SELECT shop_name, store_code FROM merchants WHERE id = ?').get(row.merchant_id) : null;
    const u = row.user_id ? q('SELECT name FROM users WHERE id = ?').get(row.user_id) : null;
    return {
      id: row.id, type: row.type, method: row.method, amount: row.amount, fee: row.fee,
      net: row.type === 'payment' ? row.amount - row.fee : undefined,
      refundedAmount: row.refunded_amount, refTx: row.ref_tx, note: row.note,
      shopName: m?.shop_name, storeCode: m?.store_code, customerName: u?.name,
      createdAt: row.created_at,
    };
  }
  const getTx = (id) => txView(q('SELECT * FROM transactions WHERE id = ?').get(id));

  // ---------- accounts & sessions ----------
  function registerUser({ phone, name, password, pin } = {}) {
    phone = str(phone, 'Phone number', { min: 10, max: 11, re: /^0\d{9,10}$/ });
    name = str(name, 'Name', { max: 40 });
    password = str(password, 'Password', { min: 8, max: 128 });
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw err(400, 'FIELD_INVALID', 'PIN must be exactly 4 digits.');
    if (/^(\d)\1{3}$/.test(pin) || pin === '1234') throw err(400, 'PIN_WEAK', 'Choose a less obvious PIN.');
    const passHash = U.hashSecret(password), pinHash = U.hashSecret(pin);
    return tx(db, () => {
      if (q('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw err(409, 'PHONE_TAKEN', 'That phone number is already registered.');
      const r = q('INSERT INTO users (phone, name, pass_hash, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(phone, name, passHash, pinHash, now());
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

  // A fixed dummy hash so a wrong username takes as long as a wrong password.
  const DUMMY = U.hashSecret('dummy-password');

  function login(kind, idField, password) {
    const row = kind === 'user'
      ? q('SELECT id, pass_hash FROM users WHERE phone = ?').get(String(idField ?? '').trim())
      : q('SELECT id, pass_hash FROM merchants WHERE email = ?').get(String(idField ?? '').trim().toLowerCase());
    const ok = U.verifySecret(String(password ?? ''), row ? row.pass_hash : DUMMY);
    if (!row || !ok) throw err(401, 'LOGIN_FAILED', 'Wrong login details.');
    return createSession(kind, row.id);
  }

  function createSession(kind, id) {
    const token = U.newSessionToken();
    const ttl = kind === 'user' ? cfg.userSessionMs : cfg.merchantSessionMs;
    q('INSERT INTO sessions (token_hash, kind, subject_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(U.sha256(token), kind, id, now() + ttl, now());
    return { token, maxAgeSec: Math.floor(ttl / 1000) };
  }

  function sessionSubject(token, kind) {
    if (!token) return null;
    const s = q('SELECT subject_id, expires_at FROM sessions WHERE token_hash = ? AND kind = ?').get(U.sha256(token), kind);
    if (!s || s.expires_at <= now()) return null;
    return s.subject_id;
  }

  function logout(token) {
    if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(U.sha256(token));
  }

  function userProfile(id) {
    const u = q('SELECT id, phone, name FROM users WHERE id = ?').get(id);
    if (!u) throw err(404, 'NOT_FOUND', 'User not found.');
    return { ...u, balance: account('user', id).balance };
  }

  function merchantProfile(id) {
    const m = q('SELECT id, email, shop_name, store_code, fee_bps FROM merchants WHERE id = ?').get(id);
    if (!m) throw err(404, 'NOT_FOUND', 'Shop not found.');
    return {
      id: m.id, email: m.email, shopName: m.shop_name, storeCode: m.store_code,
      feeBps: m.fee_bps, balance: account('merchant', id).balance,
      storeQr: `TSUBUPAY:STORE:${m.store_code}`,
    };
  }

  // ---------- customer-presented code (CPM) ----------
  function issuePayCode(userId) {
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

  function chargeByCode(merchantId, { code, amount } = {}, idemKey) {
    code = String(code ?? '').replace(/[\s-]/g, '');
    amount = amountOrThrow(amount, cfg.paymentMax);
    if (!/^88\d{16}$/.test(code) || !U.luhnValid(code)) throw err(400, 'CODE_INVALID', 'That is not a valid TsubuPay code. Scan again.');
    return run(`charge:${merchantId}`, idemKey, `${code}|${amount}`, () => {
      const t = now();
      const pc = q('SELECT * FROM pay_codes WHERE code_hash = ?').get(U.sha256(code));
      if (!pc || pc.revoked_at) throw err(404, 'CODE_NOT_FOUND', 'Code not recognised. Ask the customer to refresh their code.');
      if (pc.used_at) throw err(409, 'CODE_USED', 'This code was already used. Ask the customer to refresh.');
      if (pc.expires_at <= t) throw err(410, 'CODE_EXPIRED', 'This code has expired. Ask the customer to refresh.');
      const m = q('SELECT id, fee_bps FROM merchants WHERE id = ?').get(merchantId);
      const ua = account('user', pc.user_id);
      if (ua.balance < amount) throw err(402, 'INSUFFICIENT_FUNDS', 'Customer balance is too low. Ask them to top up.');
      q('UPDATE pay_codes SET used_at = ? WHERE code_hash = ?').run(t, pc.code_hash);
      const fee = feeFor(amount, m.fee_bps);
      const id = insertTx({ type: 'payment', method: 'cpm', amount, fee, userId: pc.user_id, merchantId });
      post(id, [[ua.id, -amount], [account('merchant', merchantId).id, amount - fee], [account('platform', 0).id, fee]]);
      const view = getTx(id);
      return {
        result: view,
        events: [[`user:${pc.user_id}`, { type: 'payment', tx: view }], [`merchant:${merchantId}`, { type: 'payment', tx: view }]],
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
    const m = q('SELECT shop_name, store_code FROM merchants WHERE store_code = ?').get(code);
    if (!m) throw err(404, 'STORE_NOT_FOUND', 'Store not found.');
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

  function payStore(userId, { storeCode, amount, pin } = {}, idemKey) {
    const code = parseStoreCode(storeCode);
    amount = amountOrThrow(amount, cfg.paymentMax);
    // PIN failures must be saved even though the payment is refused,
    // so the check runs in its own committed transaction first.
    const pinResult = tx(db, () => checkPin(userId, pin));
    if (pinResult?.locked) throw err(423, 'PIN_LOCKED', 'Too many wrong PINs. Payments are locked for 15 minutes.');
    if (pinResult) throw err(401, 'PIN_WRONG', `Wrong PIN. ${pinResult.left} attempt(s) left.`);
    return run(`pay:${userId}`, idemKey, `${code}|${amount}`, () => {
      const m = q('SELECT id, fee_bps FROM merchants WHERE store_code = ?').get(code);
      if (!m) throw err(404, 'STORE_NOT_FOUND', 'Store not found.');
      const ua = account('user', userId);
      if (ua.balance < amount) throw err(402, 'INSUFFICIENT_FUNDS', 'Your balance is too low. Please top up.');
      const fee = feeFor(amount, m.fee_bps);
      const id = insertTx({ type: 'payment', method: 'mpm', amount, fee, userId, merchantId: m.id });
      post(id, [[ua.id, -amount], [account('merchant', m.id).id, amount - fee], [account('platform', 0).id, fee]]);
      const view = getTx(id);
      return {
        result: view,
        events: [[`user:${userId}`, { type: 'payment', tx: view }], [`merchant:${m.id}`, { type: 'payment', tx: view }]],
      };
    });
  }

  // ---------- top-up, refund, payout ----------
  function topup(userId, { amount } = {}, idemKey) {
    amount = amountOrThrow(amount, cfg.topupMax, cfg.topupMin);
    return run(`topup:${userId}`, idemKey, `${amount}`, () => {
      const ua = account('user', userId);
      if (ua.balance + amount > cfg.walletMax)
        throw err(400, 'WALLET_LIMIT', `Wallet balance cannot exceed ${cfg.walletMax.toLocaleString('en')} yen.`);
      const id = insertTx({ type: 'topup', amount, userId, note: 'Bank top-up (simulated)' });
      post(id, [[account('external', 0).id, -amount], [ua.id, amount]]);
      const view = getTx(id);
      return { result: view, events: [[`user:${userId}`, { type: 'topup', tx: view }]] };
    });
  }

  function refund(merchantId, { txId, amount, reason } = {}, idemKey) {
    txId = str(txId, 'Transaction ID', { max: 32 });
    const note = reason == null || reason === '' ? null : str(reason, 'Reason', { max: 200 });
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
      const view = getTx(id);
      return {
        result: view,
        events: [[`user:${p.user_id}`, { type: 'refund', tx: view }], [`merchant:${merchantId}`, { type: 'refund', tx: view }]],
      };
    });
  }

  function payout(merchantId, { amount } = {}, idemKey) {
    return run(`payout:${merchantId}`, idemKey, `${amount ?? ''}`, () => {
      const ma = account('merchant', merchantId);
      if (ma.balance <= 0) throw err(400, 'NOTHING_TO_PAY', 'There is no balance to pay out.');
      const amt = amount == null || amount === '' ? ma.balance : amountOrThrow(amount, ma.balance);
      const id = insertTx({ type: 'payout', amount: amt, merchantId, note: 'Bank payout (simulated)' });
      post(id, [[ma.id, -amt], [account('external', 0).id, amt]]);
      const view = getTx(id);
      return { result: view, events: [[`merchant:${merchantId}`, { type: 'payout', tx: view }]] };
    });
  }

  // ---------- history & reports ----------
  const clampLimit = (l) => Math.min(Math.max(Number.parseInt(l, 10) || 50, 1), 200);

  function userHistory(userId, limit) {
    return q('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(userId, clampLimit(limit)).map(txView);
  }

  function merchantHistory(merchantId, limit) {
    return q('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(merchantId, clampLimit(limit)).map(txView);
  }

  // Today's totals in Japan time (UTC+9, no daylight saving).
  function merchantToday(merchantId) {
    const JST = 9 * 3600 * 1000, DAY = 24 * 3600 * 1000;
    const start = Math.floor((now() + JST) / DAY) * DAY - JST;
    const pay = q(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) gross, COALESCE(SUM(fee),0) fee FROM transactions
                   WHERE merchant_id = ? AND type = 'payment' AND created_at >= ?`).get(merchantId, start);
    const ref = q(`SELECT COALESCE(SUM(amount),0) amt, COALESCE(SUM(fee),0) fee FROM transactions
                   WHERE merchant_id = ? AND type = 'refund' AND created_at >= ?`).get(merchantId, start);
    return {
      payments: pay.n, gross: pay.gross, refunds: ref.amt,
      fees: pay.fee - ref.fee, net: pay.gross - pay.fee - (ref.amt - ref.fee),
    };
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
    registerUser, registerMerchant, login, sessionSubject, logout,
    userProfile, merchantProfile,
    issuePayCode, chargeByCode, lookupStore, payStore,
    topup, refund, payout,
    userHistory, merchantHistory, merchantToday, getTx, auditLedger,
  };
}

module.exports = { createService, DEFAULTS };
