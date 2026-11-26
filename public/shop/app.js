// TsubuPay shop (merchant) app
(function () {
  'use strict';
  const { api, newKey, h, $, setSvg, yen, when, toast, confirmBox, chime, listen, Scanner } = window.Tsubu;
  const view = $('#view'), nav = $('#nav'), logoutBtn = $('#logout'), nameEl = $('#shop-name');

  let shop = null, tab = 'register', stopEvents = null, scanner = null;
  const seenTx = new Set();
  // The live event can arrive before our own request's response. Events wait
  // for in-flight requests so we never alert twice for the same payment.
  let inflight = Promise.resolve();
  const track = (p) => { inflight = p.catch(() => {}); return p; };
  const feed = []; // live incoming payments this session

  function show(...nodes) {
    if (scanner) { scanner.stop(); scanner = null; }
    view.replaceChildren(...nodes.filter(Boolean)); // empty slots are skipped, never drawn as text
  }
  const errorLine = () => h('div', { class: 'form-error', role: 'alert' });
  const onAuthError = (ex) => { if (ex.status === 401) { authView(); return true; } return false; };

  // ================= auth =================
  function authView(mode = 'login') {
    nav.hidden = true; logoutBtn.hidden = true; nameEl.textContent = '';
    if (stopEvents) { stopEvents(); stopEvents = null; }
    document.onkeydown = null;
    const err = errorLine();
    const field = (lab, attrs) => [h('label', { for: attrs.id }, lab), h('input', attrs)];
    let fields;
    if (mode === 'staff') {
      fields = [
        field('Store code', { id: 'storeCode', autocapitalize: 'characters', maxlength: 8, placeholder: 'e.g. DTGFX7VS', autocomplete: 'off' }),
        field('Username', { id: 'username', autocapitalize: 'none', autocomplete: 'username', maxlength: 20 }),
        field('Password', { id: 'password', type: 'password', autocomplete: 'current-password' }),
        h('p', { class: 'muted' }, 'Cashier accounts are created by the shop owner in the Staff tab.')];
    } else {
      fields = [
        mode === 'signup' ? field('Shop name', { id: 'shopName', maxlength: 60 }) : null,
        field('Owner email', { id: 'email', type: 'email', autocomplete: 'email' }),
        field('Password', { id: 'password', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' }),
        mode === 'signup' ? h('p', { class: 'muted' }, 'Password: 8+ characters. Fee: 1.98% per payment, taken automatically.') : null];
    }
    const label = { login: 'Log in as owner', staff: 'Log in as staff', signup: 'Register shop' }[mode];
    const form = h('form', { novalidate: true }, ...fields, err, h('button', { class: 'btn', type: 'submit' }, label));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
      const v = (id) => form.querySelector('#' + id)?.value ?? '';
      try {
        if (mode === 'signup') await api('POST', '/api/shop/register', { shopName: v('shopName'), email: v('email'), password: v('password') });
        else if (mode === 'staff') await api('POST', '/api/shop/staff-login', { storeCode: v('storeCode').trim().toUpperCase(), username: v('username'), password: v('password') });
        else await api('POST', '/api/shop/login', { email: v('email'), password: v('password') });
        shop = await api('GET', '/api/shop/me');
        start();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    const tabBtn = (m, text) => h('button', { class: mode === m ? 'active' : '', onclick: () => authView(m) }, text);
    show(h('div', { class: 'card' },
      h('div', { class: 'tabs' }, tabBtn('login', 'Owner'), tabBtn('staff', 'Staff'), tabBtn('signup', 'New shop')),
      form));
  }

  const isOwner = () => shop && shop.role === 'owner';
  const frozenBanner = () => (shop && shop.frozen ? h('div', { class: 'banner', role: 'alert' },
    'This shop is frozen by TsubuPay, so it cannot take payments or pay out. Refunds still work. Please contact support.') : null);
  const receiptLink = (id) => h('a', { href: `/receipt/?id=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, 'Receipt');

  async function reloadShop() {
    try { shop = await api('GET', '/api/shop/me'); return shop; }
    catch (ex) { onAuthError(ex); return null; }
  }

  // ================= navigation =================
  function buildNav() {
    const tabs = [['register', 'Register'], ['qr', 'Store QR'], ['sales', 'Sales']];
    if (isOwner()) tabs.push(['payout', 'Balance'], ['staff', 'Staff']);
    nav.replaceChildren(...tabs.map(([t, label]) => h('button', { 'data-tab': t }, label)));
  }
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) go(b.dataset.tab);
  });
  function go(t) {
    tab = t;
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === t);
    ({ register: registerView, qr: qrView, sales: salesView, payout: payoutView, staff: staffView })[t]();
  }

  // ================= register (CPM: scan the customer's code) =================
  function registerView() {
    let amount = '';
    let busy = false;
    const display = h('div', { class: 'amount-display', id: 'amount' }, '¥0');
    const setAmount = (v) => { amount = v.replace(/\D/g, '').replace(/^0+/, '').slice(0, 6); display.textContent = yen(amount || 0); };
    const key = (k) => h('button', { type: 'button', class: k === '⌫' ? 'fn' : '', onclick: () => {
      if (k === '⌫') setAmount(amount.slice(0, -1)); else setAmount(amount + k);
    } }, k);

    const codeInput = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Scan or type the 18-digit code', maxlength: 30 });
    const result = h('div', { id: 'result', 'aria-live': 'assertive' });
    const video = h('video', { 'aria-label': 'Camera' });
    const camBox = h('div', { class: 'scanner' }, video, h('div', { class: 'frame' }), h('div', { class: 'hint' }, 'Point at the customer\'s barcode or QR'));
    camBox.hidden = true;
    const camBtn = h('button', { class: 'btn secondary' }, '📷 Scan with camera');

    const showResult = (ok, nodes) => result.replaceChildren(h('div', { class: 'result ' + (ok ? 'ok' : 'err') }, ...nodes));

    async function charge(rawCode) {
      if (busy) return;
      const code = String(rawCode).replace(/\D/g, '');
      const n = Number(amount);
      if (!n) { showResult(false, ['Enter the amount first.']); chime(false); return; }
      if (!code) return;
      busy = true;
      showResult(true, ['Charging…']);
      try {
        const tx = await track(api('POST', '/api/shop/charge', { code, amount: n }, { idempotencyKey: newKey() }));
        seenTx.add(tx.id);
        chime(true);
        showResult(true, [h('div', { class: 'big' }, '✓ ' + yen(tx.amount)), h('div', {}, `Paid by ${tx.customerName}`),
          h('div', { class: 'muted' }, `${when(tx.createdAt)} · ${tx.id} · served by ${tx.cashier}`, tx.net != null ? ` · you receive ${yen(tx.net)}` : ''),
          h('div', { class: 'row', id: 'result-actions' }, h('button', { class: 'btn small', onclick: () => registerView() }, 'Next customer'), receiptLink(tx.id))]);
        codeInput.value = '';
        setAmount('');
      } catch (ex) {
        if (onAuthError(ex)) return;
        chime(false);
        showResult(false, [h('div', { class: 'big' }, '✕'), ex.message]);
        codeInput.value = '';
        codeInput.focus();
      } finally { busy = false; }
    }

    // USB / Bluetooth barcode scanners type the digits then press Enter.
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); charge(codeInput.value); } });

    camBtn.addEventListener('click', async () => {
      if (scanner) { scanner.stop(); scanner = null; camBox.hidden = true; camBtn.textContent = '📷 Scan with camera'; return; }
      if (!(await Scanner.available(['code_128', 'qr_code']))) {
        toast('This browser cannot scan with the camera. Use a USB scanner or type the code.');
        return;
      }
      if (!Number(amount)) { showResult(false, ['Enter the amount first.']); return; }
      scanner = new Scanner(video, ['code_128', 'qr_code']);
      camBox.hidden = false; camBtn.textContent = 'Stop camera';
      try {
        await scanner.start((v) => { camBox.hidden = true; camBtn.textContent = '📷 Scan with camera'; scanner = null; charge(v); });
      } catch {
        camBox.hidden = true; camBtn.textContent = '📷 Scan with camera'; scanner = null;
        toast('Camera not available. Check permission, or use a scanner / type the code.');
      }
    });

    // Typing digits anywhere (outside inputs) edits the amount.
    const onKey = (e) => {
      if (tab !== 'register' || e.target.tagName === 'INPUT' || document.querySelector('.overlay')) return;
      if (/^\d$/.test(e.key)) setAmount(amount + e.key);
      else if (e.key === 'Backspace') setAmount(amount.slice(0, -1));
      else if (e.key === 'Enter' && Number(amount)) codeInput.focus();
    };
    document.onkeydown = onKey;

    show(frozenBanner(), h('div', { class: 'register' },
      h('div', { class: 'card' },
        h('h2', {}, '1. Amount'), display,
        h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map(key)),
        h('p'), h('button', { class: 'btn ghost', onclick: () => setAmount('') }, 'Clear')),
      h('div', { class: 'card' },
        h('h2', {}, '2. Customer code'),
        h('label', { for: 'code' }, 'Barcode / QR (scanner or keyboard)'), codeInput,
        h('div', { class: 'row', id: 'charge-row' },
          h('button', { class: 'btn', id: 'charge', onclick: () => charge(codeInput.value) }, 'Charge')),
        h('p', {}), camBtn, h('p', {}), camBox, result)));
  }

  // ================= store QR (MPM: customer scans the shop) =================
  function qrView() {
    document.onkeydown = null;
    const qr = h('div', { class: 'bigqr' });
    setSvg(qr, TsubuCodes.qrSvg(shop.storeQr));
    const list = h('ul', { class: 'list feed', id: 'feed' });
    const paintFeed = () => list.replaceChildren(...(feed.length ? feed.map(feedItem) : [h('li', { class: 'empty' }, 'Waiting for payments… new ones appear here with a chime.')]));
    paintFeed();
    show(frozenBanner(),
      h('div', { class: 'card center printable' },
        h('div', { class: 'logo center' }, 'TsubuPay'),
        h('h2', {}, shop.shopName), qr,
        h('div', { class: 'muted' }, 'Store code'), h('div', { class: 'store-code' }, shop.storeCode),
        h('p', { class: 'muted' }, 'Scan with the TsubuPay app, enter the amount, show staff the paid screen.')),
      h('div', { class: 'row no-print' }, h('button', { class: 'btn secondary', onclick: () => window.print() }, '🖨 Print this QR')),
      h('div', { class: 'card no-print' }, h('h2', {}, 'Live payments'), list));
  }
  const feedItem = (t) => h('li', {},
    h('div', {}, h('div', { class: 'title' }, t.customerName, h('span', { class: 'tag' }, t.method === 'mpm' ? 'Store QR' : 'Register')),
      h('div', { class: 'sub' }, `${when(t.createdAt)} · ${t.id}`)),
    h('div', { class: 'amt plus' }, '+' + yen(t.amount)));

  // ================= sales & refunds =================
  async function salesView() {
    document.onkeydown = null;
    const stats = h('div', { class: 'stats' });
    const list = h('ul', { class: 'list' }, h('li', { class: 'empty' }, 'Loading…'));
    show(frozenBanner(), isOwner() ? h('div', { class: 'card' }, h('h2', {}, 'Today'), stats) : null,
      h('div', { class: 'card' }, h('h2', {}, 'Transactions'),
        isOwner() ? null : h('p', { class: 'muted' }, 'Ask the owner to make refunds.'), list));
    const s = await reloadShop();
    if (!s) return;
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    if (s.today) stats.replaceChildren(stat('Payments', String(s.today.payments)), stat('Sales', yen(s.today.gross)),
      stat('Refunds', yen(s.today.refunds)), stat('Fees', yen(s.today.fees)), stat('Net', yen(s.today.net)));
    try {
      const { items } = await api('GET', '/api/shop/history?limit=200');
      if (!items.length) return list.replaceChildren(h('li', { class: 'empty' }, 'No transactions yet.'));
      list.replaceChildren(...items.map((t) => {
        let title, amt, cls, extra = null;
        if (t.type === 'payment') {
          title = [t.customerName, h('span', { class: 'tag' }, t.method === 'mpm' ? 'Store QR' : 'Register')];
          if (t.refundedAmount) title.push(h('span', { class: 'tag refund' }, `refunded ${yen(t.refundedAmount)}`));
          amt = '+' + yen(t.amount); cls = 'plus';
          if (t.cashier) title.push(h('span', { class: 'tag staff' }, t.cashier));
          if (isOwner() && t.refundedAmount < t.amount) extra = h('button', { class: 'btn ghost small', onclick: () => refundFlow(t) }, 'Refund');
        } else if (t.type === 'refund') {
          title = [`Refund to ${t.customerName}`, h('span', { class: 'tag refund' }, 'REFUND')];
          amt = '−' + yen(t.amount); cls = 'minus';
        } else {
          title = ['Payout to bank']; amt = '−' + yen(t.amount); cls = 'minus';
        }
        return h('li', {},
          h('div', {}, h('div', { class: 'title' }, ...title),
            h('div', { class: 'sub' }, `${when(t.createdAt)} · ${t.id}${t.type === 'payment' && t.fee != null ? ` · fee ${yen(t.fee)}` : ''}${t.note ? ' · ' + t.note : ''} · `,
              t.type === 'payout' ? null : receiptLink(t.id))),
          h('div', { class: 'row' }, extra, h('div', { class: 'amt ' + cls }, amt)));
      }));
    } catch (ex) { if (!onAuthError(ex)) list.replaceChildren(h('li', { class: 'empty' }, ex.message)); }
  }

  async function refundFlow(t) {
    const left = t.amount - t.refundedAmount;
    const amt = h('input', { id: 'refund-amount', inputmode: 'numeric', value: String(left) });
    const reason = h('input', { id: 'refund-reason', maxlength: 200, placeholder: 'Optional, e.g. item returned' });
    const body = h('div', {},
      h('p', { class: 'muted' }, `${t.customerName} paid ${yen(t.amount)} · refundable ${yen(left)}`),
      h('label', { for: 'refund-amount' }, 'Refund amount'), amt,
      h('label', { for: 'refund-reason' }, 'Reason'), reason, h('p'));
    if (!(await confirmBox({ title: 'Refund payment', body, ok: 'Refund', danger: true }))) return;
    const n = Number(amt.value.replace(/\D/g, ''));
    if (!n || n > left) { toast(`Enter an amount between ¥1 and ${yen(left)}.`); return; }
    try {
      const r = await track(api('POST', '/api/shop/refund', { txId: t.id, amount: n, reason: reason.value.trim() }, { idempotencyKey: newKey() }));
      seenTx.add(r.id);
      toast(`Refunded ${yen(r.amount)} to ${r.customerName}.`);
      salesView();
    } catch (ex) { if (!onAuthError(ex)) toast(ex.message, 4000); }
  }

  // ================= balance & payout =================
  async function payoutView() {
    document.onkeydown = null;
    const s = await reloadShop();
    if (!s) return;
    const amt = h('input', { id: 'payout-amount', inputmode: 'numeric', placeholder: `All (${yen(s.balance)})` });
    const err = errorLine();
    const btn = h('button', { class: 'btn', disabled: s.balance <= 0 }, 'Pay out to bank');
    btn.addEventListener('click', async () => {
      err.textContent = '';
      const raw = amt.value.replace(/\D/g, '');
      const n = raw ? Number(raw) : s.balance;
      if (!n || n > s.balance) { err.textContent = `Enter up to ${yen(s.balance)}.`; return; }
      if (!(await confirmBox({ title: `Pay out ${yen(n)}?`, body: 'The money moves to your registered bank account. (Simulated in this prototype.)', ok: 'Pay out' }))) return;
      btn.disabled = true;
      try {
        await api('POST', '/api/shop/payout', raw ? { amount: n } : {}, { idempotencyKey: newKey() });
        toast(`Paid out ${yen(n)}.`);
        payoutView();
      } catch (ex) { if (!onAuthError(ex)) { err.textContent = ex.message; btn.disabled = false; } }
    });
    show(frozenBanner(), h('div', { class: 'card' },
      h('div', { class: 'balance-label' }, 'Available balance'), h('div', { class: 'balance' }, yen(s.balance)),
      h('p', { class: 'muted' }, `Fee ${(s.feeBps / 100).toFixed(2)}% per payment, already deducted. Refunds return the fee in proportion.`),
      h('label', { for: 'payout-amount' }, 'Amount (leave empty for all)'), amt, err, btn),
      h('div', { class: 'card' }, h('h2', {}, 'Shop details'),
        h('ul', { class: 'list' },
          h('li', {}, h('span', { class: 'muted' }, 'Shop'), h('span', {}, s.shopName)),
          h('li', {}, h('span', { class: 'muted' }, 'Email'), h('span', {}, s.email)),
          h('li', {}, h('span', { class: 'muted' }, 'Store code'), h('span', { class: 'store-code' }, s.storeCode)))));
  }

  // ================= staff management (owner) =================
  async function staffView() {
    document.onkeydown = null;
    const list = h('ul', { class: 'list' }, h('li', { class: 'empty' }, 'Loading…'));
    const err = errorLine();
    const name = h('input', { id: 'staff-name', maxlength: 40, placeholder: 'e.g. Aki Tanaka' });
    const user = h('input', { id: 'staff-user', maxlength: 20, autocapitalize: 'none', placeholder: 'e.g. aki (letters, numbers, _)' });
    const pass = h('input', { id: 'staff-pass', type: 'password', autocomplete: 'new-password', placeholder: '8+ characters' });
    const add = h('button', { class: 'btn' }, 'Add cashier');
    add.addEventListener('click', async () => {
      err.textContent = ''; add.disabled = true;
      try {
        const s = await api('POST', '/api/shop/staff', { name: name.value, username: user.value, password: pass.value });
        toast(`${s.name} can now log in with store code ${shop.storeCode} and username “${s.username}”.`, 6000);
        staffView();
      } catch (ex) { if (!onAuthError(ex)) { err.textContent = ex.message; add.disabled = false; } }
    });

    async function setActive(s, active) {
      if (!active && !(await confirmBox({ title: `Deactivate ${s.name}?`, body: 'They are logged out right away and can no longer take payments.', ok: 'Deactivate', danger: true }))) return;
      try { await api('POST', '/api/shop/staff/active', { staffId: s.id, active }); staffView(); }
      catch (ex) { if (!onAuthError(ex)) toast(ex.message); }
    }
    async function resetPw(s) {
      const pw = h('input', { id: 'new-pw', type: 'password', autocomplete: 'new-password', placeholder: '8+ characters' });
      if (!(await confirmBox({ title: `New password for ${s.name}`, body: h('div', {}, h('label', { for: 'new-pw' }, 'New password'), pw, h('p', { class: 'muted' }, 'They will be logged out and must use the new password.')), ok: 'Save' }))) return;
      try { await api('POST', '/api/shop/staff/password', { staffId: s.id, password: pw.value }); toast('Password changed.'); }
      catch (ex) { if (!onAuthError(ex)) toast(ex.message, 4000); }
    }

    show(h('div', { class: 'register' },
      h('div', { class: 'card' }, h('h2', {}, 'Your staff'),
        h('p', { class: 'muted' }, `Cashiers log in on the Staff tab with store code `, h('b', {}, shop.storeCode),
          '. They can take payments but cannot refund, pay out, or see the balance.'), list),
      h('div', { class: 'card' }, h('h2', {}, 'Add a cashier'),
        h('label', { for: 'staff-name' }, 'Name'), name,
        h('label', { for: 'staff-user' }, 'Username'), user,
        h('label', { for: 'staff-pass' }, 'Password'), pass, err, h('p'), add)));
    try {
      const { items } = await api('GET', '/api/shop/staff');
      if (!items.length) return list.replaceChildren(h('li', { class: 'empty' }, 'No staff yet. Add your first cashier.'));
      list.replaceChildren(...items.map((s) => h('li', {},
        h('div', {}, h('div', { class: 'title' }, s.name, h('span', { class: 'status ' + (s.active ? 'ok' : 'bad') }, s.active ? 'Active' : 'Off')),
          h('div', { class: 'sub' }, `username: ${s.username}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost small', onclick: () => resetPw(s) }, 'Password'),
          h('button', { class: 'btn ghost small', onclick: () => setActive(s, !s.active) }, s.active ? 'Deactivate' : 'Activate')))));
    } catch (ex) { if (!onAuthError(ex)) list.replaceChildren(h('li', { class: 'empty' }, ex.message)); }
  }

  // ================= live events =================
  function start() {
    buildNav();
    nav.hidden = false; logoutBtn.hidden = false;
    nameEl.textContent = shop.role === 'cashier' ? `${shop.shopName} · ${shop.staffName}` : shop.shopName;
    if (stopEvents) stopEvents();
    stopEvents = listen('/api/shop/events', {
      payment: async ({ tx }) => {
        feed.unshift(tx); if (feed.length > 30) feed.pop();
        if ($('#feed')) $('#feed').replaceChildren(...feed.map(feedItem));
        await inflight;
        if (seenTx.has(tx.id)) return;
        seenTx.add(tx.id);
        chime(true);
        toast(`Received ${yen(tx.amount)} from ${tx.customerName}`, 4000);
        if (tab === 'sales') salesView();
      },
      refund: () => { if (tab === 'sales') salesView(); },
    });
    go('register');
  }

  logoutBtn.addEventListener('click', async () => {
    if (!(await confirmBox({ title: 'Log out?', body: 'The register will stop taking payments on this device.', ok: 'Log out' }))) return;
    try { await api('POST', '/api/shop/logout'); } catch { /* ignore */ }
    shop = null; document.onkeydown = null; authView();
  });

  api('GET', '/api/shop/me').then((s) => { shop = s; start(); }).catch(() => authView());
})();
