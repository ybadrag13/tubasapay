# TsubuPay（つぶペイ）

A barcode and QR payment system in the style of PayPay. It has three parts: a **customer wallet**, a **shop register** and the **server** that moves the money. The name comes from 粒 (tsubu, "a grain"), for small everyday payments.

- **Zero dependencies.** It runs on Node.js 22 alone and uses its built-in SQLite. There is no `npm install`.
- **Double-entry ledger.** Every yen is accounted for, and a built-in audit proves it.
- **Both payment directions**, like PayPay:
  - **CPM** (the shop scans you): the customer shows a rotating barcode or QR code, and the shop scans it.
  - **MPM** (you scan the shop): the shop displays a printed QR code, and the customer scans it, types the amount and confirms with a PIN.
- **33 automated tests**, including race conditions, double-spending, expiry, refunds and security.

> **Prototype notice.** Top-ups and payouts are *simulated*: no bank is connected. Running real money in Japan requires registration as a 資金移動業者 or 前払式支払手段 issuer under the 資金決済法, along with KYC (identity checks), anti-money-laundering controls and a security audit. See "Going to production" below.

---

## 1. Run it

Requires **Node.js 22.5 or newer** (check with `node --version`).

```bash
cd tsubupay
npm start           # starts on http://localhost:3000
npm test            # runs the 33 tests
npm run audit-ledger
```

Then open:

| App | URL | Best on |
|---|---|---|
| Customer wallet | http://localhost:3000/user/ | phone (or a narrow browser window) |
| Shop register | http://localhost:3000/shop/ | tablet or PC |

**Try it in two minutes:**
1. Open the shop app and register a shop.
2. In another browser (or a private window), open the customer app, sign up, and **top up** ¥5,000.
3. In the shop app, type an amount such as 1200. Copy the 18 digits under the customer's barcode into "Customer code" and press **Enter**.
4. Both screens update instantly: the shop sees ✓ and the customer sees the "Paid" screen.
5. In the shop app, open **Store QR**. In the customer app, tap **Scan to pay**, type the store code, enter an amount and enter the PIN.

### Using real phone cameras
Browsers only allow camera access on `https://` or `localhost`. To test with phones on your Wi-Fi:

```bash
# create a self-signed certificate once
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=tsubupay"
TSUBU_TLS_CERT=cert.pem TSUBU_TLS_KEY=key.pem PORT=3443 npm start
# on the phone: https://<your-PC-IP>:3443/user/  (accept the certificate warning)
```

Camera scanning uses the browser's built-in `BarcodeDetector`, which works in Chrome on Android, macOS and Windows. Where it isn't available, both apps fall back to typing the code. The shop app also works with any **USB or Bluetooth barcode scanner**: these type the digits and press Enter, and the Customer code field accepts that directly.

### Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port |
| `TSUBU_DB` | `data/tsubupay.db` | SQLite file |
| `TSUBU_TLS_CERT`, `TSUBU_TLS_KEY` | (none) | Enable HTTPS |
| `TSUBU_SECURE_COOKIES` | off | Force `Secure` cookies (set this when behind an HTTPS proxy) |

Business rules (fee, limits, code lifetime) are in `DEFAULTS` at the top of `server/service.js`.

---

## 2. How it works

```
 Customer phone                      Server (Node + SQLite)                   Shop register
 ─────────────                       ──────────────────────                   ─────────────
 POST /api/user/paycode  ─────────►  new 18-digit code, store SHA-256 hash
 draws barcode + QR      ◄─────────  {code, expiresAt}
                                                                      ◄────── POST /api/shop/charge {code, amount}
                                     one DB transaction:
                                       code valid? unused? not expired?
                                       balance enough?
                                       mark code used
                                       ledger: customer −1200
                                               shop     +1177
                                               platform +23 (fee)
 "Paid ¥1,200" screen    ◄── SSE ──  events  ── SSE ──►                       ✓ ¥1,200
```

### The payment code
- Format: `88` + 15 random digits + 1 **Luhn check digit** = 18 digits. Typos are caught before any lookup.
- Drawn on the phone as **Code 128 (set C)**, the standard barcode that shop scanners read, and as a **QR code**. Both encoders are written from scratch in `public/lib/codes.js` and verified against an independent decoder.
- Each code lives **3 minutes** and can be used **once**. The app shows a new code every minute, and only the newest two codes stay alive, so a refresh in the middle of a scan still works.
- Only the code's **SHA-256 hash** is stored, so a copy of the database contains no usable codes.
- The code contains nothing about the user. It is a temporary pointer, which makes a stolen screenshot worthless within minutes. The app also blurs the code whenever it goes into the background.

### Money safety
| Risk | How TsubuPay prevents it |
|---|---|
| Same code charged twice (two registers at once) | Each charge runs in one `BEGIN IMMEDIATE` transaction. Tested with 10 simultaneous charges: exactly 1 succeeds. |
| Network retry or double-tap charges twice | Every money request carries an **Idempotency-Key**. A retry returns the first result; reusing a key with different data is refused (422). |
| Negative balance | Checked in code, plus a database `CHECK (balance >= 0)` as a last safety net. |
| Money appearing or disappearing | Double-entry ledger: every transaction's entries sum to zero. `npm run audit-ledger` verifies every account against its entries. |
| Fee rounding drift on partial refunds | The fee is returned in proportion with cumulative rounding, so a full refund always returns exactly the whole fee (tested). |
| Over-refund, or refunding another shop's payment | Refused (tested). |
| Floats corrupting yen | Amounts are integers only; `1.5`, `"10e3"`, `true` and similar are rejected. |

### Security
- Passwords and PINs are hashed with **scrypt** (salted, memory-hard). Logins take equal time whether or not the account exists.
- Sessions use random 256-bit tokens in **HttpOnly, SameSite=Strict** cookies, stored hashed. Customer and shop sessions are separate.
- **CSRF protection:** every write must be JSON with a custom header and the same origin.
- **Rate limits** on login and registration. A shop that keeps sending bad codes (a guessing attack) is throttled.
- **PIN lockout:** 5 wrong PINs block store-QR payments for 15 minutes.
- **Strict Content-Security-Policy** (no inline scripts), `X-Frame-Options: DENY`, `nosniff`, and no-store caching on the API. All user text is inserted as text, never as HTML.
- Static file serving blocks path traversal (tested).

### Fees and limits (defaults)
| Rule | Value |
|---|---|
| Shop fee | 1.98% per payment (rounded down) |
| Max per payment | ¥500,000 |
| Max per top-up | ¥100,000 |
| Max wallet balance | ¥1,000,000 |
| Code lifetime / refresh | 3 min / 1 min |

---

## 3. Project layout

```
tsubupay/
├── server/
│   ├── server.js     HTTP server: routes, cookies, CSRF, rate limits, live events, static files
│   ├── service.js    all money rules (payments, refunds, top-ups, payouts, audit)
│   ├── db.js         SQLite schema + transaction helper
│   └── util.js       hashing, code generation, Luhn, rate limiter
├── public/
│   ├── index.html    landing page
│   ├── user/         customer wallet (index.html, app.js)
│   ├── shop/         shop register (index.html, app.js)
│   └── lib/          codes.js (barcode + QR), common.js (API, UI, scanner), styles.css
├── test/             api.test.js (27 end-to-end tests), codes.test.js (6 tests)
└── scripts/          audit.js, verify_codes.py (optional OpenCV check)
```

### Database tables
`users`, `merchants`, `accounts` (one per user, shop, the platform, and "external" for the bank side), `transactions`, `entries` (ledger lines), `pay_codes`, `sessions`, `idempotency`.

---

## 4. API reference

Every `POST` needs the headers `Content-Type: application/json` and `X-Tsubu-Client: 1`. Money endpoints also accept `Idempotency-Key` (8–64 characters of `A-Z a-z 0-9 _ -`). Errors return `{ "error": { "code": "...", "message": "..." } }`.

**Customer** (`tp_user` cookie)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/user/register` | `phone, name, password, pin` | logs in |
| POST | `/api/user/login` | `phone, password` | |
| POST | `/api/user/logout` | | |
| GET | `/api/user/me` | | profile + balance |
| POST | `/api/user/paycode` | | new code `{code, expiresAt}` |
| POST | `/api/user/topup` | `amount` | simulated bank |
| GET | `/api/user/store?code=` | | look up a store before paying |
| POST | `/api/user/pay` | `storeCode, amount, pin` | MPM payment |
| GET | `/api/user/history?limit=` | | |
| GET | `/api/user/events` | | live events (SSE): `payment`, `refund`, `topup` |

**Shop** (`tp_shop` cookie)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/shop/register` | `email, shopName, password` | logs in |
| POST | `/api/shop/login` / `logout` | `email, password` | |
| GET | `/api/shop/me` | | profile, balance, store QR, today's totals |
| POST | `/api/shop/charge` | `code, amount` | CPM payment |
| POST | `/api/shop/refund` | `txId, amount?, reason?` | omit `amount` to refund the rest |
| POST | `/api/shop/payout` | `amount?` | omit to pay out everything |
| GET | `/api/shop/history?limit=` | | |
| GET | `/api/shop/events` | | live events (SSE): `payment`, `refund`, `payout` |

Error codes include `CODE_INVALID`, `CODE_NOT_FOUND`, `CODE_USED`, `CODE_EXPIRED`, `INSUFFICIENT_FUNDS`, `PIN_WRONG`, `PIN_LOCKED`, `ALREADY_REFUNDED`, `MERCHANT_FUNDS_LOW`, `WALLET_LIMIT`, `IDEMPOTENCY_MISMATCH`, `RATE_LIMITED` and `CSRF`.

---

## 5. Going to production: what this prototype does not have

Be honest with anyone you show this to: TsubuPay is a correct, well-tested **prototype**, not a licensed payment service. A real launch needs:

1. **Licence and law:** registration under the 資金決済法 (資金移動業, or 前払式支払手段 for prepaid-only), terms of service, a privacy policy, and protection of customer funds (供託 or a trust).
2. **Identity checks (KYC/eKYC)** and anti-money-laundering monitoring under 犯収法.
3. **Real bank connections** for top-ups (bank API or Pay-easy) and shop payouts (全銀 transfers), with daily reconciliation against the ledger.
4. **Infrastructure:** PostgreSQL with replication and backups instead of one SQLite file; several servers with shared rate limits and events (for example Redis); monitoring and alerts.
5. **Stronger authentication:** SMS or app 2FA, device binding, staff accounts with roles (cashier vs owner, with refunds and payouts restricted to owners), and an admin console.
6. **Native apps** (iOS/Android) with secure storage, biometric unlock and screenshot blocking on the code screen.
7. **An external security audit and penetration test** before any real money moves.

## License
MIT
