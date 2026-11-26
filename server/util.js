'use strict';
const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Password / PIN hashing with scrypt (memory-hard, built into Node).
function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifySecret(secret, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// Luhn check digit, so typing mistakes in a code are caught before lookup.
function luhnDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
const luhnValid = (code) => /^\d+$/.test(code) && luhnDigit(code.slice(0, -1)) === code.slice(-1);

// 18-digit payment code: "88" prefix + 15 random digits + 1 check digit.
function newPayCode() {
  let body = '88';
  for (let i = 0; i < 15; i++) body += crypto.randomInt(10);
  return body + luhnDigit(body);
}

// Unambiguous alphabet (no 0/O, 1/I/L) for codes people may read aloud.
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}
const newTxId = () => 'TX' + randomCode(14);
const newSessionToken = () => crypto.randomBytes(32).toString('base64url');

// Simple in-memory sliding-window rate limiter.
class RateLimiter {
  constructor() { this.hits = new Map(); }
  check(key, limit, windowMs, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50000) this.sweep(now, windowMs);
    return true;
  }
  sweep(now, windowMs) {
    for (const [k, arr] of this.hits) if (!arr.some((t) => now - t < windowMs)) this.hits.delete(k);
  }
}

module.exports = {
  ApiError, sha256, hashSecret, verifySecret, luhnDigit, luhnValid,
  newPayCode, randomCode, newTxId, newSessionToken, RateLimiter,
};
