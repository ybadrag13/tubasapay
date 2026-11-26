// TsubuPay customer app
(function () {
  'use strict';
  const { api, newKey, h, $, setSvg, yen, when, toast, confirmBox, resultScreen, chime, listen, Scanner } = window.Tsubu;
  const view = $('#view');
  const logoutBtn = $('#logout');

  const REFRESH_MS = 60_000; // show a new code every minute (each lives 3 minutes)
  let me = null, stopEvents = null, codeTimer = null, tickTimer = null;
  const shownTx = new Set(); // avoid showing the same "paid" screen twice
  let inflight = Promise.resolve();
  const track = (p) => { inflight = p.catch(() => {}); return p; };

  // Empty slots (null/false) are skipped, never drawn as text.
  function show(...nodes) { stopCode(); view.replaceChildren(...nodes.filter(Boolean)); window.scrollTo(0, 0); }
  const back = (label = '← Back') => h('button', { class: 'btn ghost small', onclick: home }, label);
  const errorLine = () => h('div', { class: 'form-error', role: 'alert' });

  // ================= auth =================
  function authView(mode = 'login') {
    logoutBtn.hidden = true;
    const err = errorLine();
    const field = (lab, attrs) => [h('label', { for: attrs.id }, lab), h('input', attrs)];
    const form = h('form', { novalidate: true },
      mode === 'signup' ? field('Your name', { id: 'name', autocomplete: 'name', maxlength: 40, required: true }) : null,
      field('Phone number', { id: 'phone', inputmode: 'numeric', autocomplete: 'tel', placeholder: '09012345678', maxlength: 11 }),
      field('Password', { id: 'password', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', minlength: 8 }),
      mode === 'signup' ? field('4-digit payment PIN', { id: 'pin', type: 'password', inputmode: 'numeric', maxlength: 4, autocomplete: 'off' }) : null,
      mode === 'signup' ? h('p', { class: 'muted' }, 'Password: 8+ characters. PIN: used to confirm payments when you scan a shop\'s QR.') : null,
      err,
      h('button', { class: 'btn', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Log in'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; err.textContent = '';
      const v = (id) => form.querySelector('#' + id)?.value ?? '';
      try {
        me = mode === 'signup'
          ? await api('POST', '/api/user/register', { name: v('name'), phone: v('phone').replace(/\D/g, ''), password: v('password'), pin: v('pin') })
          : await api('POST', '/api/user/login', { phone: v('phone').replace(/\D/g, ''), password: v('password') });
        start();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });

    show(h('div', { class: 'card' },
      h('div', { class: 'tabs', role: 'tablist' },
        h('button', { class: mode === 'login' ? 'active' : '', onclick: () => authView('login') }, 'Log in'),
        h('button', { class: mode === 'signup' ? 'active' : '', onclick: () => authView('signup') }, 'Sign up')),
      form));
  }

  // ================= home: balance + rotating code =================
  function home() {
    logoutBtn.hidden = false;
    const balanceEl = h('div', { class: 'balance', id: 'balance' }, yen(me.balance));
    const bar = h('div', { class: 'barcode', id: 'barcode' });
    const digits = h('div', { class: 'code-digits', id: 'digits' }, '•••• •••• •••• •••• ••');
    const qr = h('div', { class: 'qr', id: 'qr' });
    const timerFill = h('div');
    const timerText = h('div', { class: 'muted', id: 'timer-text' }, 'Loading code…');

    const frozen = me.frozen ? h('div', { class: 'banner', role: 'alert' },
      'Your account is frozen, so payments are paused. Please contact TsubuPay support.') : null;
    show(
      frozen,
      h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', {}, h('div', { class: 'balance-label' }, 'Balance'), balanceEl),
          h('div', { class: 'muted', 'aria-label': 'Account name' }, me.name))),
      me.frozen ? null : h('div', { class: 'card paycard' },
        h('div', { class: 'balance-label' }, 'Show this at the register'),
        bar, digits, qr,
        h('div', { class: 'timer' }, timerFill), timerText,
        h('button', { class: 'btn secondary small', onclick: refreshCode }, '↻ New code')),
      h('div', { class: 'actions four' },
        h('button', { class: 'action', onclick: scanView, disabled: me.frozen }, h('span', { class: 'ico' }, '⌗'), 'Scan'),
        h('button', { class: 'action', onclick: sendView, disabled: me.frozen }, h('span', { class: 'ico' }, '↗'), 'Send'),
        h('button', { class: 'action', onclick: topupView, disabled: me.frozen }, h('span', { class: 'ico' }, '+'), 'Top up'),
        h('button', { class: 'action', onclick: historyView }, h('span', { class: 'ico' }, '≡'), 'History')));

    if (!me.frozen) refreshCode();
  }

  async function refreshCode() {
    clearTimeout(codeTimer); clearInterval(tickTimer);
    const bar = $('#barcode'), qr = $('#qr'), digits = $('#digits'), tText = $('#timer-text');
    if (!bar) return;
    bar.classList.add('blurred'); qr.classList.add('blurred');
    try {
      const { code } = await api('POST', '/api/user/paycode');
      if (!$('#barcode')) return; // user left the screen meanwhile
      setSvg(bar, TsubuCodes.code128Svg(code, { height: 80 }));
      setSvg(qr, TsubuCodes.qrSvg(code));
      digits.textContent = code.replace(/(\d{4})(?=\d)/g, '$1 ');
      bar.classList.remove('blurred'); qr.classList.remove('blurred');
      const until = Date.now() + REFRESH_MS;
      const fill = $('.timer > div');
      const tick = () => {
        const left = Math.max(0, until - Date.now());
        fill.style.width = (left / REFRESH_MS) * 100 + '%';
        tText.textContent = `Refreshes in ${Math.ceil(left / 1000)}s · do not share screenshots`;
      };
      tick();
      tickTimer = setInterval(tick, 1000);
      codeTimer = setTimeout(refreshCode, REFRESH_MS);
    } catch (ex) {
      if (ex.status === 401) return authView();
      if (ex.code === 'ACCOUNT_FROZEN') return reloadMe();
      tText.textContent = ex.message + ' Tap "New code" to retry.';
      codeTimer = setTimeout(refreshCode, 10_000);
    }
  }

  function stopCode() { clearTimeout(codeTimer); clearInterval(tickTimer); codeTimer = tickTimer = null; }

  // Never leave a live code on screen while the app is in the background.
  document.addEventListener('visibilitychange', () => {
    if (!$('#barcode')) return;
    if (document.hidden) { stopCode(); $('#barcode').classList.add('blurred'); $('#qr').classList.add('blurred'); }
    else refreshCode();
  });

  async function reloadMe() {
    try {
      const wasFrozen = me?.frozen;
      me = await api('GET', '/api/user/me');
      const b = $('#balance'); if (b) b.textContent = yen(me.balance);
      if (b && wasFrozen !== me.frozen) home();
    }
    catch (ex) { if (ex.status === 401) authView(); }
  }

  // ================= top-up =================
  function topupView() {
    logoutBtn.hidden = false;
    const input = h('input', { id: 'topup-amount', inputmode: 'numeric', placeholder: 'Amount in yen', maxlength: 6 });
    const err = errorLine();
    const chips = h('div', { class: 'chips' }, [1000, 3000, 5000, 10000].map((v) =>
      h('button', { class: 'chip', type: 'button', onclick: () => { input.value = v; } }, yen(v))));
    const go = h('button', { class: 'btn' }, 'Top up');
    go.addEventListener('click', async () => {
      err.textContent = '';
      const amount = Number(input.value.replace(/\D/g, ''));
      if (!amount) { err.textContent = 'Enter an amount.'; return; }
      if (!(await confirmBox({ title: `Top up ${yen(amount)}?`, body: 'Money is taken from your linked bank account. (Simulated in this prototype.)', ok: 'Top up' }))) return;
      go.disabled = true;
      try {
        await api('POST', '/api/user/topup', { amount }, { idempotencyKey: newKey() });
        chime(true);
        await reloadMe();
        toast(`Added ${yen(amount)}. Balance ${yen(me.balance)}.`);
        home();
      } catch (ex) { err.textContent = ex.message; go.disabled = false; }
    });
    show(back(), h('div', { class: 'card' },
      h('h2', {}, 'Top up'),
      h('p', { class: 'muted' }, `Balance ${yen(me.balance)} · up to ¥100,000 per top-up`),
      chips, h('label', { for: 'topup-amount' }, 'Amount'), input, err, go));
    input.focus();
  }

  // ================= scan shop QR (MPM) =================
  async function scanView() {
    logoutBtn.hidden = false;
    const err = errorLine();
    const manual = h('input', { id: 'store-code', placeholder: 'e.g. ABCD2345', maxlength: 30, autocapitalize: 'characters', autocomplete: 'off' });
    const video = h('video', { 'aria-label': 'Camera' });
    const camBox = h('div', { class: 'scanner' }, video, h('div', { class: 'frame' }), h('div', { class: 'hint' }, 'Point at the shop\'s TsubuPay QR'));
    camBox.hidden = true;
    const scanner = new Scanner(video, ['qr_code']);
    const leave = () => scanner.stop();

    const useCode = async (raw) => {
      err.textContent = '';
      try {
        const store = await api('GET', '/api/user/store?code=' + encodeURIComponent(raw));
        leave();
        payStoreView(store);
      } catch (ex) {
        err.textContent = ex.message;
        if (!camBox.hidden) scanner.start(useCode).catch(() => {});
      }
    };

    show(
      h('button', { class: 'btn ghost small', onclick: () => { leave(); home(); } }, '← Back'),
      h('div', { class: 'card' },
        h('h2', {}, 'Scan to pay'),
        camBox,
        h('p', { class: 'muted', id: 'cam-msg' }, 'Starting camera…'),
        h('label', { for: 'store-code' }, 'Or type the store code'),
        h('div', { class: 'row' }, manual, h('button', { class: 'btn small', onclick: () => useCode(manual.value) }, 'Next')),
        err));
    manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') useCode(manual.value); });

    const msg = $('#cam-msg');
    if (await Scanner.available(['qr_code'])) {
      try { camBox.hidden = false; await scanner.start(useCode); msg.textContent = ''; }
      catch { camBox.hidden = true; msg.textContent = 'Camera not available (permission denied or no camera). Type the code instead.'; }
    } else {
      msg.textContent = 'This browser cannot scan QR codes. Type the code printed under the shop\'s QR.';
    }
  }

  function payStoreView(store) {
    let amount = '';
    const display = h('div', { class: 'amount-display' }, '¥0');
    const err = errorLine();
    const set = (v) => { amount = v.replace(/^0+/, '').slice(0, 6); display.textContent = yen(amount || 0); };
    const key = (k) => h('button', { type: 'button', class: k.length > 1 ? 'fn' : '', onclick: () => {
      if (k === 'C') set(''); else if (k === '⌫') set(amount.slice(0, -1)); else set(amount + k);
    } }, k);
    const go = h('button', { class: 'btn' }, 'Pay');
    go.addEventListener('click', async () => {
      err.textContent = '';
      const n = Number(amount);
      if (!n) { err.textContent = 'Enter the amount shown by the shop.'; return; }
      if (n > me.balance) { err.textContent = `Not enough balance (${yen(me.balance)}). Please top up.`; return; }
      const pin = await pinSheet(`Pay ${yen(n)} to ${store.shopName}`);
      if (!pin) return;
      go.disabled = true;
      try {
        const tx = await track(api('POST', '/api/user/pay', { storeCode: store.storeCode, amount: n, pin }, { idempotencyKey: newKey() }));
        shownTx.add(tx.id);
        chime(true);
        await reloadMe();
        await resultScreen({ title: `Paid to ${tx.shopName}`, amount: tx.amount, lines: [when(tx.createdAt), `Ref ${tx.id}`, 'Show this screen to the shop.'], receiptId: tx.id });
        home();
      } catch (ex) { chime(false); err.textContent = ex.message; go.disabled = false; }
    });
    show(back('← Cancel'), h('div', { class: 'card' },
      h('div', { class: 'muted' }, 'Paying'),
      h('h2', {}, store.shopName),
      h('div', { class: 'muted' }, `Store ${store.storeCode} · Balance ${yen(me.balance)}`),
      display,
      h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key)),
      err, h('div', { class: 'row' }, go)));
  }

  function pinSheet(title) {
    return new Promise((resolve) => {
      let pin = '';
      const dots = h('div', { class: 'pin-dots', 'aria-label': 'PIN entered' }, [0, 1, 2, 3].map(() => h('span')));
      const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < pin.length));
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const press = (k) => {
        if (k === 'Cancel') return done(null);
        if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
        paint();
        if (pin.length === 4) setTimeout(() => done(pin), 120);
      };
      const onKey = (e) => {
        if (/^\d$/.test(e.key)) press(e.key);
        else if (e.key === 'Backspace') press('⌫');
        else if (e.key === 'Escape') press('Cancel');
      };
      const ov = h('div', { class: 'overlay' }, h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'center' }, 'Enter your PIN'), h('p', { class: 'muted center' }, title), dots,
        h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Cancel', '0', '⌫'].map((k) =>
          h('button', { type: 'button', class: k.length > 1 ? 'fn' : '', onclick: () => press(k) }, k)))));
      document.body.append(ov);
      document.addEventListener('keydown', onKey);
    });
  }

  // ================= send money to a friend =================
  function sendView() {
    const err = errorLine();
    const phone = h('input', { id: 'to-phone', inputmode: 'tel', placeholder: '09012345678', maxlength: 13, autocomplete: 'off' });
    const next = h('button', { class: 'btn' }, 'Next');
    const find = async () => {
      err.textContent = '';
      const p = phone.value.replace(/\D/g, '');
      if (!p) { err.textContent = 'Enter your friend\'s phone number.'; return; }
      next.disabled = true;
      try { sendAmountView(p, await api('GET', '/api/user/recipient?phone=' + encodeURIComponent(p))); }
      catch (ex) { if (ex.status === 401) return authView(); err.textContent = ex.message; next.disabled = false; }
    };
    next.addEventListener('click', find);
    phone.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
    show(back(), h('div', { class: 'card' },
      h('h2', {}, 'Send money'),
      h('p', { class: 'muted' }, 'Send to anyone with TsubuPay, free. Up to ¥100,000 each time.'),
      h('label', { for: 'to-phone' }, 'Their phone number'), phone, err, h('p'), next));
    phone.focus();
  }

  function sendAmountView(phone, who) {
    let amount = '';
    const display = h('div', { class: 'amount-display' }, '¥0');
    const msg = h('input', { id: 'send-msg', maxlength: 50, placeholder: 'Message (optional), e.g. Lunch 🍜' });
    const err = errorLine();
    const set = (v) => { amount = v.replace(/^0+/, '').slice(0, 6); display.textContent = yen(amount || 0); };
    const key = (k) => h('button', { type: 'button', class: k.length > 1 ? 'fn' : '', onclick: () => {
      if (k === 'C') set(''); else if (k === '⌫') set(amount.slice(0, -1)); else set(amount + k);
    } }, k);
    const go = h('button', { class: 'btn' }, 'Send');
    go.addEventListener('click', async () => {
      err.textContent = '';
      const n = Number(amount);
      if (!n) { err.textContent = 'Enter an amount.'; return; }
      if (n > me.balance) { err.textContent = `Not enough balance (${yen(me.balance)}). Please top up.`; return; }
      const pin = await pinSheet(`Send ${yen(n)} to ${who.name}`);
      if (!pin) return;
      go.disabled = true;
      try {
        const tx = await track(api('POST', '/api/user/transfer', { toPhone: phone, amount: n, pin, message: msg.value.trim() }, { idempotencyKey: newKey() }));
        shownTx.add(tx.id);
        chime(true);
        await reloadMe();
        await resultScreen({ title: `Sent to ${tx.toName}`, amount: tx.amount, lines: [when(tx.createdAt), tx.note ? `“${tx.note}”` : null, `Ref ${tx.id}`].filter(Boolean), receiptId: tx.id });
        home();
      } catch (ex) { chime(false); err.textContent = ex.message; go.disabled = false; }
    });
    show(back('← Cancel'), h('div', { class: 'card' },
      h('div', { class: 'muted' }, 'Sending to'),
      h('h2', {}, who.name), h('div', { class: 'muted' }, `${who.phone} · Balance ${yen(me.balance)}`),
      display,
      h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key)),
      h('label', { for: 'send-msg' }, 'Message'), msg, err, h('p'), go));
  }

  // ================= history =================
  async function historyView() {
    const list = h('ul', { class: 'list' }, h('li', { class: 'empty' }, 'Loading…'));
    show(back(), h('div', { class: 'card' }, h('h2', {}, 'History'), list));
    try {
      const { items } = await api('GET', '/api/user/history?limit=100');
      if (!items.length) return list.replaceChildren(h('li', { class: 'empty' }, 'No transactions yet.'));
      list.replaceChildren(...items.map((t) => {
        const plus = t.type === 'topup' || t.type === 'refund' || (t.type === 'transfer' && t.direction === 'in');
        const title = t.type === 'topup' ? 'Top up'
          : t.type === 'refund' ? `Refund from ${t.shopName}`
            : t.type === 'transfer' ? (t.direction === 'in' ? `From ${t.customerName}` : `To ${t.toName}`)
              : t.shopName;
        return h('li', {},
          h('div', {}, h('div', { class: 'title' }, title,
            t.type === 'refund' ? h('span', { class: 'tag refund' }, 'REFUND') : null,
            t.type === 'transfer' ? h('span', { class: 'tag' + (t.direction === 'in' ? ' in' : '') }, t.direction === 'in' ? 'RECEIVED' : 'SENT') : null,
            t.type === 'payment' && t.refundedAmount ? h('span', { class: 'tag' }, `refunded ${yen(t.refundedAmount)}`) : null),
            h('div', { class: 'sub' }, `${when(t.createdAt)}${t.type === 'transfer' && t.note ? ' · “' + t.note + '”' : ''} · `,
              h('a', { href: `/receipt/?id=${encodeURIComponent(t.id)}`, target: '_blank', rel: 'noopener' }, 'Receipt'))),
          h('div', { class: 'amt ' + (plus ? 'plus' : 'minus') }, (plus ? '+' : '−') + yen(t.amount)));
      }));
    } catch (ex) { if (ex.status === 401) return authView(); list.replaceChildren(h('li', { class: 'empty' }, ex.message)); }
  }

  // ================= live events =================
  function start() {
    if (stopEvents) stopEvents();
    stopEvents = listen('/api/user/events', {
      payment: async ({ tx }) => {
        await inflight;
        await reloadMe();
        if (shownTx.has(tx.id)) return;
        shownTx.add(tx.id);
        chime(true);
        await resultScreen({ title: `Paid to ${tx.shopName}`, amount: tx.amount, lines: [when(tx.createdAt), `Ref ${tx.id}`], receiptId: tx.id });
        home();
      },
      refund: async ({ tx }) => { await reloadMe(); toast(`Refund ${yen(tx.amount)} from ${tx.shopName}`); },
      transfer: async ({ tx }) => {
        await inflight;
        await reloadMe();
        if (tx.direction !== 'in' || shownTx.has(tx.id)) return;
        shownTx.add(tx.id);
        chime(true);
        toast(`Received ${yen(tx.amount)} from ${tx.customerName}${tx.note ? ': “' + tx.note + '”' : ''}`, 5000);
      },
      topup: () => reloadMe(),
    });
    home();
  }

  logoutBtn.addEventListener('click', async () => {
    if (!(await confirmBox({ title: 'Log out?', body: 'You will need your phone number and password to log in again.', ok: 'Log out' }))) return;
    try { await api('POST', '/api/user/logout'); } catch { /* ignore */ }
    if (stopEvents) stopEvents();
    me = null; authView();
  });

  // boot
  api('GET', '/api/user/me').then((u) => { me = u; start(); }).catch(() => authView());
})();
