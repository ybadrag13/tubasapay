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
const COOKIE = { user: 'tp_user', merchant: 'tp_shop' };

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
  const db = open(options.dbPath || process.env.TSUBU_DB || path.resolve(__dirname, '..', 'data', 'tsubupay.db'));
  const svc = createService(db, options.service || {});
  const limiter = new RateLimiter();
  const limits = { login: 10, register: 10, chargeFail: 30, ...(options.limits || {}) };
  const secureCookies = options.secureCookies ?? process.env.TSUBU_SECURE_COOKIES === '1';

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

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16 * 1024) { reject(new ApiError(413, 'TOO_LARGE', 'Request body too large.')); req.destroy(); return; }
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
    'GET /api/health': () => ({ ok: true, name: 'TsubuPay' }),

    // customer
    'POST /api/user/register': async (req, res, body) => {
      rate(req, 'register', limits.register);
      const id = svc.registerUser(body);
      return login(req, res, 'user', body.phone, body.password, () => svc.userProfile(id));
    },
    'POST /api/user/login': async (req, res, body) => {
      rate(req, 'login', limits.login);
      return login(req, res, 'user', body.phone, body.password, (id) => svc.userProfile(id));
    },
    'POST /api/user/logout': (req, res) => logout(req, res, 'user'),
    'GET /api/user/me': (req) => svc.userProfile(auth(req, 'user')),
    'POST /api/user/paycode': (req) => svc.issuePayCode(auth(req, 'user')),
    'POST /api/user/topup': (req, res, body) => svc.topup(auth(req, 'user'), body, idem(req)),
    'GET /api/user/store': (req, res, body, url) => { auth(req, 'user'); return svc.lookupStore(url.searchParams.get('code')); },
    'POST /api/user/pay': (req, res, body) => svc.payStore(auth(req, 'user'), body, idem(req)),
    'GET /api/user/history': (req, res, body, url) => ({ items: svc.userHistory(auth(req, 'user'), url.searchParams.get('limit')) }),
    'GET /api/user/events': (req, res) => { sse(req, res, `user:${auth(req, 'user')}`); return undefined; },

    // shop
    'POST /api/shop/register': async (req, res, body) => {
      rate(req, 'register', limits.register);
      const id = svc.registerMerchant(body);
      return login(req, res, 'merchant', body.email, body.password, () => svc.merchantProfile(id));
    },
    'POST /api/shop/login': async (req, res, body) => {
      rate(req, 'login', limits.login);
      return login(req, res, 'merchant', body.email, body.password, (id) => svc.merchantProfile(id));
    },
    'POST /api/shop/logout': (req, res) => logout(req, res, 'merchant'),
    'GET /api/shop/me': (req) => { const id = auth(req, 'merchant'); return { ...svc.merchantProfile(id), today: svc.merchantToday(id) }; },
    'POST /api/shop/charge': (req, res, body) => {
      const id = auth(req, 'merchant');
      try { return svc.chargeByCode(id, body, idem(req)); }
      catch (e) {
        // throttle a shop that keeps sending bad codes (guessing attack)
        if (['CODE_INVALID', 'CODE_NOT_FOUND', 'CODE_EXPIRED', 'CODE_USED'].includes(e.code) &&
            !limiter.check(`chargefail:${id}`, limits.chargeFail, 60_000))
          throw new ApiError(429, 'RATE_LIMITED', 'Too many failed scans. Wait a minute.');
        throw e;
      }
    },
    'POST /api/shop/refund': (req, res, body) => svc.refund(auth(req, 'merchant'), body, idem(req)),
    'POST /api/shop/payout': (req, res, body) => svc.payout(auth(req, 'merchant'), body, idem(req)),
    'GET /api/shop/history': (req, res, body, url) => ({ items: svc.merchantHistory(auth(req, 'merchant'), url.searchParams.get('limit')) }),
    'GET /api/shop/events': (req, res) => { sse(req, res, `merchant:${auth(req, 'merchant')}`); return undefined; },
  };

  const idem = (req) => req.headers['idempotency-key'] || undefined;

  function login(req, res, kind, idField, password, profile) {
    const { token, maxAgeSec } = svc.login(kind, idField, password);
    const id = svc.sessionSubject(token, kind);
    res.setHeader('Set-Cookie', setCookie(req, COOKIE[kind], token, maxAgeSec));
    return profile(id);
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
    else if (rel === '/user' || rel === '/shop') { res.writeHead(301, { Location: rel + '/' }); return res.end(); }
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
      if (req.method === 'POST') { checkWrite(req); body = await readJson(req); }
      const out = await handler(req, res, body, url);
      if (out !== undefined) send(res, 200, out);
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
  return { server, svc, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { TSUBU_TLS_CERT: cert, TSUBU_TLS_KEY: key } = process.env;
  const tls = cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : undefined;
  const { server } = createApp({ tls, secureCookies: !!tls || undefined });
  const scheme = tls ? 'https' : 'http';
  server.listen(port, () => {
    console.log(`TsubuPay running on ${scheme}://localhost:${port}`);
    console.log(`  Customer app: ${scheme}://localhost:${port}/user/`);
    console.log(`  Shop app:     ${scheme}://localhost:${port}/shop/`);
  });
}

module.exports = { createApp };
