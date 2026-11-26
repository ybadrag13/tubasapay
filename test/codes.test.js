'use strict';
// Unit tests for the barcode / QR generator.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/lib/codes.js');

test('Code 128 table: 107 unique patterns, 11 modules each (stop 13)', () => {
  assert.equal(C._C128.length, 107);
  assert.equal(new Set(C._C128).size, 107);
  C._C128.forEach((p, i) => assert.equal([...p].reduce((a, b) => a + +b, 0), i === 106 ? 13 : 11, `symbol ${i}`));
});

test('Code 128 C: start C, digit pairs, correct checksum, stop', () => {
  const s = C.code128Symbols('882345678901234567');
  assert.equal(s[0], 105);
  assert.deepEqual(s.slice(1, 10), [88, 23, 45, 67, 89, 1, 23, 45, 67]);
  let sum = 105; s.slice(1, 10).forEach((v, i) => { sum += v * (i + 1); });
  assert.equal(s[10], sum % 103);
  assert.equal(s[11], 106);
});

test('Code 128 widths decode back to the same symbols', () => {
  const text = '880000000000000003';
  const w = C.code128Widths(text);
  const syms = [];
  for (let i = 0; i + 6 <= w.length - 7; i += 6) syms.push(C._C128.indexOf(w.slice(i, i + 6).join('')));
  assert.deepEqual(syms, C.code128Symbols(text).slice(0, -1));
});

test('QR: sizes grow with content and stay square', () => {
  for (const [text, size] of [['hi', 21], ['882345678901234567', 25], ['TSUBUPAY:STORE:ABCD2345', 25], ['x'.repeat(100), 41]]) {
    const m = C.qrMatrix(text);
    assert.equal(m.length, size, text);
    m.forEach((row) => assert.equal(row.length, size));
  }
});

test('QR: finder patterns are in the three corners', () => {
  const m = C.qrMatrix('882345678901234567'), n = m.length;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(m[y][x + i], true); assert.equal(m[y + 6][x + i], true);
      assert.equal(m[y + i][x], true); assert.equal(m[y + i][x + 6], true);
    }
    assert.equal(m[y + 3][x + 3], true);
    assert.equal(m[y + 1][x + 1], false);
  }
});

test('QR: refuses text that is too long', () => {
  assert.throws(() => C.qrMatrix('x'.repeat(400)));
});
