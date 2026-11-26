// TsubuPay shared browser helpers: API calls, safe DOM building, dialogs, sounds, camera scanner.
(function () {
  'use strict';

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  // A fresh key per user action makes retries safe: the server applies it once.
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');

  async function api(method, path, body, { idempotencyKey } = {}) {
    // Every write is sent as JSON (even with no fields) so it passes the server's CSRF check.
    if (method !== 'GET' && body === undefined) body = {};
    const headers = { 'x-tsubu-client': '1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res;
    // One automatic retry on a network failure, with the same idempotency key.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
        break;
      } catch (e) {
        if (attempt >= 1 || (method !== 'GET' && !idempotencyKey)) throw new ApiError(0, 'NETWORK', 'No connection. Please check your network.');
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'ERROR', data?.error?.message || `Request failed (${res.status}).`);
    return data;
  }

  // ---------- DOM ----------
  // h('div', {class:'x', onclick: fn}, 'text', childNode) — text is always escaped.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const $ = (sel, root = document) => root.querySelector(sel);

  // Only for SVG strings produced by our own code generator (never user text).
  function setSvg(el, svg) { el.innerHTML = svg; }

  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
  const when = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------- feedback ----------
  function toast(msg, ms = 2600) {
    let box = document.getElementById('toasts');
    if (!box) { box = h('div', { id: 'toasts', class: 'toasts' }); document.body.append(box); }
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    box.append(t);
    setTimeout(() => t.remove(), ms);
  }

  // Modal confirmation. Resolves true/false.
  function confirmBox({ title, body, ok = 'Confirm', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(false); } },
        h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
          h('h3', {}, title),
          typeof body === 'string' ? h('p', { class: 'muted' }, body) : body,
          h('div', { class: 'grid2' },
            h('button', { class: 'btn ghost', onclick: () => close(false) }, cancel),
            h('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => close(true) }, ok))));
      document.body.append(ov);
      document.addEventListener('keydown', onKey);
      ov.querySelector('.btn:not(.ghost)').focus();
    });
  }

  function resultScreen({ ok = true, title, amount, lines = [], button = 'Done' }) {
    return new Promise((resolve) => {
      const s = h('div', { class: 'success-screen' + (ok ? '' : ' fail'), role: 'alertdialog' },
        h('div', { class: 'check' }, ok ? '✓' : '!'),
        h('div', {}, title),
        amount != null ? h('div', { class: 'big' }, yen(amount)) : null,
        lines.map((l) => h('div', { class: 'muted-light' }, l)),
        h('button', { class: 'btn', onclick: () => { s.remove(); resolve(); } }, button));
      document.body.append(s);
      s.querySelector('button').focus();
    });
  }

  let audioCtx;
  function chime(ok = true) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = ok ? [880, 1318.5] : [330, 220];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = audioCtx.currentTime + i * 0.13;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.connect(g).connect(audioCtx.destination);
        o.start(t); o.stop(t + 0.3);
      });
      if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
    } catch { /* sound is optional */ }
  }

  // ---------- live events ----------
  function listen(path, handlers) {
    let es, stopped = false;
    const connect = () => {
      es = new EventSource(path);
      for (const [type, fn] of Object.entries(handlers)) es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
      es.onerror = () => { if (stopped) es.close(); }; // EventSource reconnects by itself
    };
    connect();
    return () => { stopped = true; es && es.close(); };
  }

  // ---------- camera scanner ----------
  // Uses the browser's built-in BarcodeDetector (Chrome/Edge on Android, macOS, Windows; Safari 17+ partly).
  // Callers always offer manual entry too, since not every browser has it.
  class Scanner {
    constructor(video, formats) { this.video = video; this.formats = formats; this.stream = null; this.timer = null; }
    static async available(formats) {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return false;
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        return formats.some((f) => sup.includes(f));
      } catch { return false; }
    }
    async start(onResult) {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const detector = new window.BarcodeDetector({ formats: this.formats.filter((f) => sup.includes(f)) });
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      this.video.srcObject = this.stream;
      this.video.setAttribute('playsinline', '');
      this.video.muted = true;
      await this.video.play();
      let busy = false;
      this.timer = setInterval(async () => {
        if (busy || this.video.readyState < 2) return;
        busy = true;
        try {
          const found = await detector.detect(this.video);
          if (found.length) { const v = found[0].rawValue; this.stop(); onResult(v); }
        } catch { /* frame not ready */ }
        busy = false;
      }, 150);
    }
    stop() {
      clearInterval(this.timer); this.timer = null;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (this.video) this.video.srcObject = null;
    }
  }

  window.Tsubu = { api, ApiError, newKey, h, $, setSvg, yen, when, toast, confirmBox, resultScreen, chime, listen, Scanner };
})();
