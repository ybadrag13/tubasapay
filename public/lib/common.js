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

  function resultScreen({ ok = true, title, amount, lines = [], button = 'Done', receiptId }) {
    return new Promise((resolve) => {
      const s = h('div', { class: 'success-screen' + (ok ? '' : ' fail'), role: 'alertdialog' },
        h('div', { class: 'check' }, ok ? '✓' : '!'),
        h('div', {}, title),
        amount != null ? h('div', { class: 'big' }, yen(amount)) : null,
        lines.map((l) => h('div', { class: 'muted-light' }, l)),
        h('button', { class: 'btn', onclick: () => { s.remove(); resolve(); } }, button),
        receiptId ? h('a', { class: 'link-light', href: `/receipt/?id=${encodeURIComponent(receiptId)}`, target: '_blank', rel: 'noopener' }, 'View receipt') : null);
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

  // ---------- identity verification (KYC) ----------
  // Shrinks a photo to a sensible size and returns a JPEG data URL.
  async function toJpeg(source, maxSide = 1280, quality = 0.82) {
    const bmp = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let q = quality, url = c.toDataURL('image/jpeg', q);
    while (url.length * 0.75 > 1_300_000 && q > 0.4) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
    return url;
  }

  const DOCS = {
    drivers_license: { label: "Driver's licence (運転免許証)", number: 'Licence number (12 digits)', placeholder: '123456789012', back: true },
    residence_card: { label: 'Residence card (在留カード)', number: 'Card number (12 characters)', placeholder: 'AB12345678CD', back: true },
    passport: { label: 'Passport (パスポート)', number: 'Passport number', placeholder: 'TK1234567', back: false },
  };

  // Full verification screen. base = '/api/user' or '/api/shop'.
  async function kycScreen(rawView, { base, onBack, who = 'you' }) {
    // Empty slots (null) are skipped, never drawn as text.
    const view = { replaceChildren: (...n) => rawView.replaceChildren(...n.filter(Boolean)) };
    const back = h('button', { class: 'btn ghost small', onclick: onBack }, '← Back');
    let info;
    try { info = await api('GET', base + '/kyc'); } catch (e) { view.replaceChildren(back, h('div', { class: 'card' }, e.message)); return; }
    const card = (...c) => h('div', { class: 'card' }, ...c);
    if (info.status === 'approved') {
      view.replaceChildren(back, card(h('div', { class: 'result ok' }, h('div', { class: 'big' }, '✓'), 'Identity verified. All features are unlocked.')));
      return;
    }
    if (info.status === 'pending') {
      view.replaceChildren(back, card(h('h2', {}, 'Under review'),
        h('div', { class: 'result ok' }, 'Your ID and selfie were received. TsubuPay staff check them, usually within 1 business day.'),
        h('p', { class: 'muted' }, 'You will see the result here and in the app as soon as it is decided.')));
      return;
    }

    const err = h('div', { class: 'form-error', role: 'alert' });
    const docType = h('select', { id: 'kyc-doc' }, Object.entries(DOCS).map(([v, d]) => h('option', { value: v }, d.label)));
    const name = h('input', { id: 'kyc-name', maxlength: 60, placeholder: 'As written on the document', autocomplete: 'name' });
    const birth = h('input', { id: 'kyc-birth', type: 'date', max: new Date().toISOString().slice(0, 10) });
    const address = h('input', { id: 'kyc-address', maxlength: 200, placeholder: 'As written on the document', autocomplete: 'street-address' });
    const number = h('input', { id: 'kyc-number', maxlength: 20, autocomplete: 'off' });
    const numberLabel = h('label', { for: 'kyc-number' });
    const photos = { front: null, back: null, selfie: null };

    const photoPicker = (key, title) => {
      const preview = h('div', { class: 'kyc-preview empty' }, 'No photo yet');
      const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'kyc-file', id: 'kyc-' + key });
      input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        try {
          photos[key] = await toJpeg(input.files[0]);
          preview.replaceChildren(h('img', { src: photos[key], alt: title }));
          preview.classList.remove('empty');
        } catch { toast('Could not read that photo. Try another.'); }
      });
      return h('div', { class: 'kyc-photo', id: 'box-' + key }, h('label', { for: 'kyc-' + key }, title), preview,
        h('label', { class: 'btn secondary small', for: 'kyc-' + key }, '📷 Take / choose photo'), input);
    };
    const frontBox = photoPicker('front', 'Front of the document');
    const backBox = photoPicker('back', 'Back of the document');

    // Live selfie: camera only (no uploads), with a random gesture from the server.
    const gestureBox = h('div', { class: 'kyc-gesture', hidden: true });
    const video = h('video', { class: 'kyc-video', 'aria-label': 'Front camera', playsinline: true });
    const selfiePreview = h('div', { class: 'kyc-preview empty' }, 'No selfie yet');
    const camWrap = h('div', { class: 'kyc-cam', hidden: true }, video);
    let stream = null;
    const stopCam = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; camWrap.hidden = true; };
    const startBtn = h('button', { class: 'btn secondary small', type: 'button' }, '🤳 Start live selfie');
    const snapBtn = h('button', { class: 'btn small', type: 'button', hidden: true }, 'Take selfie');
    startBtn.addEventListener('click', async () => {
      err.textContent = '';
      try {
        const ch = await api('POST', base + '/kyc/challenge');
        gestureBox.hidden = false;
        gestureBox.replaceChildren(h('div', { class: 'balance-label' }, 'In your selfie, please:'), h('div', { class: 'kyc-gesture-text' }, ch.gesture));
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera. Use Chrome or Safari on your phone.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        video.srcObject = stream; video.muted = true; await video.play();
        camWrap.hidden = false; snapBtn.hidden = false; startBtn.textContent = '↻ New instruction';
      } catch (e) { err.textContent = e.message || 'Camera not available. Allow camera access and try again.'; }
    });
    snapBtn.addEventListener('click', async () => {
      if (!video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      photos.selfie = await toJpeg(c, 960);
      selfiePreview.replaceChildren(h('img', { src: photos.selfie, alt: 'Your selfie' }));
      selfiePreview.classList.remove('empty');
      stopCam(); snapBtn.hidden = true; startBtn.textContent = '↻ Retake selfie';
    });

    const syncDoc = () => {
      const d = DOCS[docType.value];
      numberLabel.textContent = d.number; number.placeholder = d.placeholder;
      backBox.hidden = !d.back;
    };
    docType.addEventListener('change', syncDoc); syncDoc();

    const submit = h('button', { class: 'btn' }, 'Submit for review');
    submit.addEventListener('click', async () => {
      err.textContent = '';
      const d = DOCS[docType.value];
      if (!photos.front || (d.back && !photos.back)) { err.textContent = 'Add photos of the document' + (d.back ? ' (front and back).' : '.'); return; }
      if (!photos.selfie) { err.textContent = 'Take the live selfie, following the instruction.'; return; }
      if (!(await confirmBox({ title: 'Submit your identity check?', body: 'Your ID photos and selfie are sent to TsubuPay staff for checking. Only staff can see them.', ok: 'Submit' }))) return;
      submit.disabled = true; submit.textContent = 'Uploading…';
      try {
        await api('POST', base + '/kyc', { docType: docType.value, legalName: name.value, birthDate: birth.value, address: address.value,
          docNumber: number.value, docFront: photos.front, docBack: d.back ? photos.back : undefined, selfie: photos.selfie });
        stopCam(); chime(true); toast('Submitted. We will review it soon.');
        kycScreen(rawView, { base, onBack, who });
      } catch (e) { err.textContent = e.message; submit.disabled = false; submit.textContent = 'Submit for review'; }
    });

    const rejected = info.status === 'rejected' && info.lastSubmission
      ? h('div', { class: 'banner' }, 'Your last check was not approved: ', info.lastSubmission.reason || 'no reason given', '. Please try again.') : null;
    view.replaceChildren(back, rejected,
      card(h('h2', {}, 'Verify your identity'),
        h('p', { class: 'muted' }, `To keep TsubuPay safe, ${who} must prove you are the real owner. One person can have one account. It takes about 3 minutes.`),
        h('ol', { class: 'kyc-steps' }, h('li', {}, 'Your details, exactly as on your ID'), h('li', {}, 'Photos of your ID'), h('li', {}, 'A live selfie with a simple gesture'))),
      card(h('h2', {}, '1. Your details'),
        h('label', { for: 'kyc-doc' }, 'ID document'), docType,
        h('label', { for: 'kyc-name' }, 'Full legal name'), name,
        h('label', { for: 'kyc-birth' }, 'Date of birth'), birth,
        h('label', { for: 'kyc-address' }, 'Address'), address,
        numberLabel, number,
        h('p', { class: 'muted' }, 'We never store your document number, only a coded fingerprint that stops it being used for a second account.')),
      card(h('h2', {}, '2. Photos of your ID'), h('p', { class: 'muted' }, 'Place it on a dark table, all four corners visible, no glare.'),
        h('div', { class: 'kyc-photos' }, frontBox, backBox)),
      card(h('h2', {}, '3. Live selfie'), h('p', { class: 'muted' }, 'Taken with your camera now (uploads are not accepted), so we know it is really you.'),
        gestureBox, camWrap, h('div', { class: 'row' }, startBtn, snapBtn), h('p'), selfiePreview),
      card(err, submit));
    window.addEventListener('pagehide', stopCam, { once: true });
  }

  window.Tsubu = { api, ApiError, newKey, h, $, setSvg, yen, when, toast, confirmBox, resultScreen, chime, listen, Scanner, kycScreen, toJpeg };
})();
