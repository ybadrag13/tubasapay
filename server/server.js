'use strict';
// TsubuPay HTTP server. Zero dependencies: Node 22 built-ins only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const { createService } = require('./service');
const { ApiError, RateLimiter } = require('./util');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const COOKIE = { user: 'tp_user', merchant: 'tp_shop', admin: 'tp_admin' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function createApp(options = {}) {
  const db = options.db || open(options.dbPath || process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'));
  const replicator = options.replicator || null; // set when Turso keeps the data permanently
  const turso = options.turso || null;
  const rawDb = db.raw || db; // the plain SQLite handle (for backups)
  let deepCache = { at: 0, ok: true, error: null };
  const storage = () => (replicator ? replicator.status() : { mode: 'local', synced: true });
  const svc = createService(db, options.service || {});
  const limiter = new RateLimiter();
  const limits = { login: 10, register: 10, chargeFail: 30, lookup: 20, adminLogin: 10, otp: 5, ...(options.limits || {}) };
  const secureCookies = options.secureCookies ?? process.env.TSUBU_SECURE_COOKIES === '1';
  const sms = options.sms || require('./sms').createSms({});
  const BIG = new Set(['/api/user/kyc', '/api/shop/kyc']); // ID photos + selfie

  // ---------- small helpers ----------
  function send(res, status, body, extra = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...extra });
    res.end(data);
  }

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function isHttps(req) {
    return secureCookies || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  }

  function setCookie(req, name, value, maxAge) {
    return `${name}=${encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
      (isHttps(req) ? '; Secure' : '');
  }

  function clientIp(req) {
    return options.trustProxy ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;
  }

  function readJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new ApiError(413, 'TOO_LARGE', 'Request body too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch { reject(new ApiError(400, 'BAD_JSON', 'Body must be a JSON object.')); }
      });
      req.on('error', reject);
    });
  }

  // CSRF defence: cookies are SameSite=Strict, and every write must be JSON
  // with our custom header, which a cross-site form cannot send.
  function checkWrite(req) {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct !== 'application/json' || req.headers['x-tsubu-client'] !== '1')
      throw new ApiError(403, 'CSRF', 'Request rejected.');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host; try { host = new URL(origin).host; } catch { host = ''; }
      if (host !== req.headers.host) throw new ApiError(403, 'CSRF', 'Cross-origin request rejected.');
    }
  }

  function rate(req, bucket, limit, windowMs = 60_000) {
    if (!limiter.check(`${bucket}:${clientIp(req)}`, limit, windowMs))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a minute.');
  }

  function auth(req, kind) {
    const id = svc.sessionSubject(cookies(req)[COOKIE[kind]], kind);
    if (!id) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in.');
    return id;
  }

  // Shop requests act as the owner (staffId null) or as a cashier.
  function shopActor(req) {
    const s = svc.session(cookies(req)[COOKIE.merchant], 'merchant');
    if (!s) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in.');
    return { merchantId: s.id, staffId: s.staffId };
  }

  // ---------- live events (Server-Sent Events) ----------
  function sse(req, res, channel) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const onEvent = (payload) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    svc.events.on(channel, onEvent);
    req.on('close', () => { clearInterval(beat); svc.events.off(channel, onEvent); });
  }

  // ---------- routes ----------
  const routes = {
    // ?deep=1 also touches Turso (at most every 5 minutes), which keeps a free database from being archived.
    'GET /api/health': async (req, res, body, url) => {
      const out = { ok: true, name: 'TsubuPay', storage: storage() };
      if (url.searchParams.get('deep') === '1' && turso) {
        if (Date.now() - deepCache.at > 5 * 60_000) {
          try { await turso.query('SELECT 1 AS ok'); deepCache = { at: Date.now(), ok: true, error: null }; }
          catch (e) { deepCache = { at: Date.now(), ok: false, error: e.message }; }
        }
        out.turso = { ok: deepCache.ok, checkedAt: deepCache.at, error: deepCache.error || undefined };
        if (!deepCache.ok) res.statusCode = 503;
      }
      return out;
    },

    // customer
    'POST /api/user/otp': async (req, res, body) => {
      rate(req, 'otp', limits.otp, 10 * 60_000);
      const { phone, code, expiresInSec } = svc.requestPhoneCode(body.phone);
      try { await sms.send(phone, `TsubuPay sign-up code: ${code} (valid ${Math.round(expiresInSec / 60)} minutes). Never share it.`); }
      catch (e) { svc.cancelPhoneCode(phone); console.error('[tsubupay] SMS failed:', e.message); throw new ApiError(502, 'SMS_FAILED', 'Could not send the SMS. Please try again.'); }
      return { sent: true, expiresInSec, demo: sms.mode === 'demo', demoCode: sms.mode === 'demo' ? code : undefined };
    },
    'POST /api/user/register': async (req, res, body) => {
      rate(req, 'register', limits.register);
      svc.registerUser(body);
      return login(req, res, 'user', body.phone, body.password, (s) => svc.userProfile(s.id));
    },
    'POST /api/user/login': async (req, res, body) => {
      rate(req, 'login', limits.login);
      return login(req, res, 'user', body.phone, body.password, (s) => svc.userProfile(s.id));
    },
    'POST /api/user/logout': (req, res) => logout(req, res, 'user'),
    'GET /api/user/me': (req) => svc.userProfile(auth(req, 'user')),
    'POST /api/user/paycode': (req) => svc.issuePayCode(auth(req, 'user')),
    'POST /api/user/topup': (req, res, body) => svc.topup(auth(req, 'user'), body, idem(req)),
    'GET /api/user/store': (req, res, body, url) => { auth(req, 'user'); return svc.lookupStore(url.searchParams.get('code')); },
    'POST /api/user/pay': (req, res, body) => svc.payStore(auth(req, 'user'), body, idem(req)),
    'GET /api/user/recipient': (req, res, body, url) => {
      const id = auth(req, 'user');
      rate(req, `recipient:${id}`, limits.lookup); // stops phone-number fishing
      return svc.lookupRecipient(id, url.searchParams.get('phone'));
    },
    'POST /api/user/transfer': (req, res, body) => svc.transfer(auth(req, 'user'), body, idem(req)),
    'GET /api/user/kyc': (req) => svc.kycInfo('user', auth(req, 'user')),
    'POST /api/user/kyc/challenge': (req) => svc.kycChallenge('user', auth(req, 'user')),
    'POST /api/user/kyc': (req, res, body) => svc.submitKyc('user', auth(req, 'user'), body),
    'GET /api/user/history': (req, res, body, url) => ({ items: svc.userHistory(auth(req, 'user'), url.searchParams.get('limit')) }),
    'GET /api/user/events': (req, res) => { sse(req, res, `user:${auth(req, 'user')}`); return undefined; },

    // shop
    'POST /api/shop/register': async (req, res, body) => {
      rate(req, 'register', limits.register);
      svc.registerMerchant(body);
      return login(req, res, 'merchant', body.email, body.password, (s) => svc.merchantProfile(s.id));
    },
    'POST /api/shop/login': async (req, res, body) => {
      rate(req, 'login', limits.login);
      return login(req, res, 'merchant', body.email, body.password, (s) => svc.merchantProfile(s.id));
    },
    'POST /api/shop/staff-login': async (req, res, body) => {
      rate(req, 'login', limits.login);
      const { token, maxAgeSec } = svc.staffLogin(body);
      const s = svc.session(token, 'merchant');
      res.setHeader('Set-Cookie', setCookie(req, COOKIE.merchant, token, maxAgeSec));
      return svc.merchantProfile(s.id, s.staffId);
    },
    'POST /api/shop/logout': (req, res) => logout(req, res, 'merchant'),
    'GET /api/shop/me': (req) => {
      const a = shopActor(req);
      const p = svc.merchantProfile(a.merchantId, a.staffId);
      return a.staffId ? p : { ...p, today: svc.merchantToday(a.merchantId) };
    },
    'POST /api/shop/charge': (req, res, body) => {
      const a = shopActor(req);
      try { return svc.chargeByCode(a, body, idem(req)); }
      catch (e) {
        // throttle a shop that keeps sending bad codes (guessing attack)
        if (['CODE_INVALID', 'CODE_NOT_FOUND', 'CODE_EXPIRED', 'CODE_USED'].includes(e.code) &&
            !limiter.check(`chargefail:${a.merchantId}`, limits.chargeFail, 60_000))
          throw new ApiError(429, 'RATE_LIMITED', 'Too many failed scans. Wait a minute.');
        throw e;
      }
    },
    'POST /api/shop/refund': (req, res, body) => svc.refund(shopActor(req), body, idem(req)),
    'POST /api/shop/payout': (req, res, body) => svc.payout(shopActor(req), body, idem(req)),
    'GET /api/shop/history': (req, res, body, url) => ({ items: svc.merchantHistory(shopActor(req), url.searchParams.get('limit')) }),
    'GET /api/shop/events': (req, res) => { sse(req, res, `merchant:${shopActor(req).merchantId}`); return undefined; },
    'GET /api/shop/kyc': (req) => svc.kycInfo('merchant', shopActor(req).merchantId),
    'POST /api/shop/kyc/challenge': (req) => { const a = shopActor(req); ownerOnly(a); return svc.kycChallenge('merchant', a.merchantId); },
    'POST /api/shop/kyc': (req, res, body) => { const a = shopActor(req); ownerOnly(a); return svc.submitKyc('merchant', a.merchantId, body); },
    'GET /api/shop/staff': (req) => ({ items: svc.listStaff(shopActor(req)) }),
    'POST /api/shop/staff': (req, res, body) => svc.createStaff(shopActor(req), body),
    'POST /api/shop/staff/active': (req, res, body) => svc.setStaffActive(shopActor(req), body),
    'POST /api/shop/staff/password': (req, res, body) => svc.resetStaffPassword(shopActor(req), body),

    // receipts: open to whoever is involved (customer, shop, or admin)
    'GET /api/receipt': (req, res, body, url) => {
      const c = cookies(req), id = url.searchParams.get('id');
      const admin = svc.sessionSubject(c[COOKIE.admin], 'admin');
      const shop = svc.session(c[COOKIE.merchant], 'merchant');
      const user = svc.sessionSubject(c[COOKIE.user], 'user');
      if (!admin && !shop && !user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in to see this receipt.');
      for (const viewer of [admin && { adminId: admin }, shop && { merchantId: shop.id, staffId: shop.staffId }, user && { userId: user }]) {
        if (!viewer) continue;
        try { return svc.receipt(id, viewer); } catch (e) { if (e.code !== 'NOT_FOUND') throw e; }
      }
      throw new ApiError(404, 'NOT_FOUND', 'Receipt not found.');
    },

    // admin
    'POST /api/admin/login': async (req, res, body) => {
      rate(req, 'adminlogin', limits.adminLogin, 15 * 60_000);
      return login(req, res, 'admin', body.email, body.password, (s) => svc.adminProfile(s.id));
    },
    'POST /api/admin/logout': (req, res) => logout(req, res, 'admin'),
    'GET /api/admin/me': (req) => svc.adminProfile(auth(req, 'admin')),
    'GET /api/admin/overview': (req) => { auth(req, 'admin'); return { ...svc.adminOverview(), storage: storage() }; },
    'GET /api/admin/users': (req, res, body, url) => { auth(req, 'admin'); return { items: svc.adminUsers(url.searchParams.get('q'), url.searchParams.get('limit')) }; },
    'GET /api/admin/merchants': (req, res, body, url) => { auth(req, 'admin'); return { items: svc.adminMerchants(url.searchParams.get('q'), url.searchParams.get('limit')) }; },
    'GET /api/admin/transactions': (req, res, body, url) => {
      auth(req, 'admin');
      return { items: svc.adminTransactions({ type: url.searchParams.get('type'), search: url.searchParams.get('q'), limit: url.searchParams.get('limit') }) };
    },
    'POST /api/admin/freeze': (req, res, body) => svc.adminSetFrozen(auth(req, 'admin'), body),
    'GET /api/admin/log': (req, res, body, url) => { auth(req, 'admin'); return { items: svc.adminLogList(url.searchParams.get('limit')) }; },
    'GET /api/admin/kyc': (req, res, body, url) => { auth(req, 'admin'); return { items: svc.adminKycList({ status: url.searchParams.get('status'), limit: url.searchParams.get('limit') }) }; },
    'GET /api/admin/kyc/image': (req, res, body, url) => {
      auth(req, 'admin');
      const { buf, type } = svc.adminKycImage(url.searchParams.get('id'), url.searchParams.get('which'));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length,
        'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline' });
      res.end(buf);
      return undefined;
    },
    'POST /api/admin/kyc/review': (req, res, body) => svc.adminKycReview(auth(req, 'admin'), body),
    // Full copy of the database as one SQLite file (includes ID photos: keep it private).
    'GET /api/admin/backup': (req, res) => {
      const adminId = auth(req, 'admin');
      rate(req, 'backup', 5, 60 * 60_000);
      const file = path.join(require('node:os').tmpdir(), `tsubupay-backup-${Date.now()}-${process.pid}.db`);
      rawDb.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      svc.recordAdminAction(adminId, 'backup');
      const stat = fs.statSync(file);
      const name = `tsubupay-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.db`;
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store, private' });
      const stream = fs.createReadStream(file);
      stream.pipe(res);
      const cleanup = () => fs.rm(file, { force: true }, () => {});
      stream.on('close', cleanup); res.on('close', cleanup);
      return undefined;
    },
  };

  const idem = (req) => req.headers['idempotency-key'] || undefined;
  const ownerOnly = (a) => { if (a.staffId) throw new ApiError(403, 'OWNER_ONLY', 'Only the shop owner can verify the shop.'); };

  function login(req, res, kind, idField, password, profile) {
    const { token, maxAgeSec } = svc.login(kind, idField, password);
    res.setHeader('Set-Cookie', setCookie(req, COOKIE[kind], token, maxAgeSec));
    return profile(svc.session(token, kind));
  }

  function logout(req, res, kind) {
    svc.logout(cookies(req)[COOKIE[kind]]);
    res.setHeader('Set-Cookie', setCookie(req, COOKIE[kind], '', 0));
    return { ok: true };
  }

  // ---------- static files ----------
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    else if (['/user', '/shop', '/admin', '/receipt'].includes(rel)) { res.writeHead(301, { Location: rel + '/' }); return res.end(); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(PUBLIC, '.' + rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const handle = async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url.pathname);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      if (!handler) throw new ApiError(404, 'NOT_FOUND', 'No such endpoint.');
      let body = {};
      if (req.method === 'POST') { checkWrite(req); body = await readJson(req, BIG.has(url.pathname) ? 6 * 1024 * 1024 : 16 * 1024); }
      const out = await handler(req, res, body, url);
      // With Turso, a write is only confirmed once it is stored permanently.
      if (replicator && req.method === 'POST' && !(await replicator.settle(10000)))
        console.error('[tsubupay] Turso is slow: reply sent before sync finished (it keeps retrying).');
      if (out !== undefined) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      if (/CHECK constraint/.test(e?.message)) // safety net fired: refuse, never corrupt
        return send(res, 409, { error: { code: 'CONSTRAINT', message: 'Operation refused by a safety check.' } });
      console.error('[tsubupay] unexpected error:', e);
      send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. Nothing was charged.' } });
    }
  };

  // HTTPS when a certificate is given (phone cameras only work on https or localhost).
  const server = options.tls ? require('node:https').createServer(options.tls, handle) : http.createServer(handle);
  return { server, svc, db, replicator };
}

async function main() {
  const { openStore } = require('./store');
  const port = Number(process.env.PORT) || 3000;
  const { TSUBU_TLS_CERT: cert, TSUBU_TLS_KEY: key, TURSO_DATABASE_URL: tursoUrl, TURSO_AUTH_TOKEN: tursoToken } = process.env;
  const tls = cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : undefined;
  const store = await openStore({ dbPath: process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'), tursoUrl, tursoToken });
  console.log(tursoUrl ? 'Storage: Turso (permanent) + local working copy' : 'Storage: local SQLite file');
  const sms = require('./sms').createSms(process.env);
  console.log(sms.mode === 'demo' ? 'SMS: demo mode (codes shown on screen, no real SMS)' : `SMS: ${sms.mode}`);
  if (!process.env.TSUBU_KYC_PEPPER) console.warn('WARNING: TSUBU_KYC_PEPPER is not set; using a built-in default. Set a long random secret in production.');
  const { server, svc } = createApp({ db: store.db, replicator: store.replicator, turso: store.turso, sms,
    service: process.env.TSUBU_KYC_PEPPER ? { kycPepper: process.env.TSUBU_KYC_PEPPER } : {}, tls, secureCookies: !!tls || undefined, trustProxy: process.env.TSUBU_TRUST_PROXY === '1' });
  // Hosts without a terminal (e.g. Render free): create the admin from settings on start.
  const { TSUBU_ADMIN_EMAIL: adminEmail, TSUBU_ADMIN_PASSWORD: adminPassword } = process.env;
  if (adminEmail && adminPassword) {
    try { console.log(`Admin account ready (${svc.ensureAdmin({ email: adminEmail, password: adminPassword })}): ${adminEmail.trim().toLowerCase()}`); }
    catch (e) { console.error('Admin not created:', e.message); }
  }
  // On shutdown (Render sleeps or redeploys), finish sending everything to Turso first.
  const stop = async (sig) => {
    console.log(`${sig}: finishing sync and shutting down…`);
    server.close();
    if (store.replicator) console.log((await store.replicator.settle(20000)) ? 'All data saved to Turso.' : 'WARNING: some changes were not saved to Turso.');
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  const scheme = tls ? 'https' : 'http';
  server.listen(port, () => {
    console.log(`TsubuPay running on ${scheme}://localhost:${port}`);
    console.log(`  Customer app: ${scheme}://localhost:${port}/user/`);
    console.log(`  Shop app:     ${scheme}://localhost:${port}/shop/`);
  });
}

if (require.main === module) {
  main().catch((e) => { console.error('TsubuPay could not start:', e.message); process.exit(1); });
}

module.exports = { createApp };
