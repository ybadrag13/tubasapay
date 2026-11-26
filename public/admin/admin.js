// TsubuPay admin dashboard
(function () {
  'use strict';
  const { api, h, $, yen, when, toast, confirmBox } = window.Tsubu;
  const view = $('#view'), nav = $('#nav'), logoutBtn = $('#logout'), emailEl = $('#admin-email');
  let tab = 'overview';

  const show = (...n) => view.replaceChildren(...n.filter(Boolean));
  const onAuthError = (ex) => { if (ex.status === 401) { authView(); return true; } return false; };
  const status = (frozen) => h('span', { class: 'status ' + (frozen ? 'bad' : 'ok') }, frozen ? 'Frozen' : 'Active');
  const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.length ? rows : [h('tr', {}, h('td', { colspan: head.length, class: 'empty' }, 'Nothing found.'))])));
  const num = (v) => h('td', { class: 'num' }, v);
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- auth ----------
  function authView() {
    nav.hidden = true; logoutBtn.hidden = true; emailEl.textContent = '';
    const err = h('div', { class: 'form-error', role: 'alert' });
    const form = h('form', { novalidate: true },
      h('label', { for: 'email' }, 'Admin email'), h('input', { id: 'email', type: 'email', autocomplete: 'username' }),
      h('label', { for: 'password' }, 'Password'), h('input', { id: 'password', type: 'password', autocomplete: 'current-password' }),
      err, h('button', { class: 'btn', type: 'submit' }, 'Log in'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true; err.textContent = '';
      try { start(await api('POST', '/api/admin/login', { email: $('#email').value, password: $('#password').value })); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    show(h('div', { class: 'card', id: 'admin-login' }, h('h2', {}, 'Admin login'),
      h('p', { class: 'muted' }, 'Admin accounts are created on the server with: npm run create-admin'), form));
  }

  // ---------- navigation ----------
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
  function go(t) {
    tab = t;
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === t);
    ({ overview, users, shops, txs, log })[t]();
  }

  // ---------- overview ----------
  async function overview() {
    show(h('div', { class: 'card empty' }, 'Loading…'));
    try {
      const o = await api('GET', '/api/admin/overview');
      const stat = (k, v, cls) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' + (cls ? ' ' + cls : '') }, v));
      show(
        h('div', { class: 'card' }, h('h2', {}, 'Accounts'), h('div', { class: 'stats' },
          stat('Customers', String(o.users)), stat('Frozen customers', String(o.frozenUsers)),
          stat('Shops', String(o.merchants)), stat('Frozen shops', String(o.frozenMerchants)))),
        h('div', { class: 'card' }, h('h2', {}, 'Today (JST)'), h('div', { class: 'stats' },
          stat('Transactions', String(o.today.transactions)), stat('Payment volume', yen(o.today.paymentVolume)),
          stat('Transfer volume', yen(o.today.transferVolume)))),
        h('div', { class: 'card' }, h('h2', {}, 'Money held'), h('div', { class: 'stats' },
          stat('Customer wallets', yen(o.money.customerWallets)), stat('Shop balances', yen(o.money.shopBalances)),
          stat('Fee income', yen(o.money.platformFees)), stat('Total held', yen(o.money.heldTotal))),
          h('p', { class: 'muted' }, 'Total held must equal wallets + shop balances + fees. In production this is matched daily against the bank account.')),
        h('div', { class: 'card' }, h('h2', {}, 'Ledger audit'),
          o.audit.ok ? h('div', { class: 'result ok' }, '✓ Every transaction balances and all money is accounted for.')
            : h('div', { class: 'result err' }, h('div', {}, '✕ Ledger problems found:'), h('ul', {}, o.audit.problems.map((p) => h('li', {}, p))))));
    } catch (ex) { if (!onAuthError(ex)) show(h('div', { class: 'card empty' }, ex.message)); }
  }

  // ---------- freeze ----------
  async function setFrozen(kind, id, name, frozen) {
    const reason = h('input', { id: 'freeze-reason', maxlength: 200, placeholder: frozen ? 'Required, e.g. suspected fraud' : 'Optional' });
    const body = h('div', {},
      h('p', { class: 'muted' }, frozen
        ? `${name} will not be able to ${kind === 'user' ? 'pay, top up, send or receive money' : 'take payments or pay out (refunds still work)'}.`
        : `${name} will be able to use TsubuPay normally again.`),
      h('label', { for: 'freeze-reason' }, 'Reason'), reason);
    if (!(await confirmBox({ title: `${frozen ? 'Freeze' : 'Unfreeze'} ${name}?`, body, ok: frozen ? 'Freeze' : 'Unfreeze', danger: frozen }))) return;
    try {
      await api('POST', '/api/admin/freeze', { kind, id, frozen, reason: reason.value.trim() });
      toast(`${name} ${frozen ? 'frozen' : 'unfrozen'}.`);
      go(tab);
    } catch (ex) { if (!onAuthError(ex)) toast(ex.message, 4000); }
  }

  // ---------- customers ----------
  function users() {
    const box = h('div');
    const search = h('input', { id: 'q', type: 'search', placeholder: 'Search name or phone' });
    const load = async () => {
      try {
        const { items } = await api('GET', '/api/admin/users?limit=200&q=' + encodeURIComponent(search.value));
        box.replaceChildren(table(['ID', 'Name', 'Phone', 'Balance', 'Joined', 'Status', ''], items.map((u) => h('tr', {},
          num(String(u.id)), h('td', {}, u.name), h('td', {}, u.phone), num(yen(u.balance)), h('td', {}, when(u.createdAt)),
          h('td', { title: u.frozenReason || '' }, status(u.frozen), u.frozenReason ? h('div', { class: 'sub muted' }, u.frozenReason) : null),
          h('td', {}, h('button', { class: 'btn ghost small', onclick: () => setFrozen('user', u.id, u.name, !u.frozen) }, u.frozen ? 'Unfreeze' : 'Freeze'))))));
      } catch (ex) { if (!onAuthError(ex)) box.replaceChildren(h('p', { class: 'empty' }, ex.message)); }
    };
    search.addEventListener('input', debounce(load));
    show(h('div', { class: 'card' }, h('h2', {}, 'Customers'), h('div', { class: 'toolbar' }, search), box));
    load();
  }

  // ---------- shops ----------
  function shops() {
    const box = h('div');
    const search = h('input', { id: 'q', type: 'search', placeholder: 'Search shop, email or store code' });
    const load = async () => {
      try {
        const { items } = await api('GET', '/api/admin/merchants?limit=200&q=' + encodeURIComponent(search.value));
        box.replaceChildren(table(['ID', 'Shop', 'Store code', 'Email', 'Staff', 'Balance', 'Status', ''], items.map((m) => h('tr', {},
          num(String(m.id)), h('td', {}, m.shopName), h('td', {}, m.storeCode), h('td', {}, m.email), num(String(m.staff)), num(yen(m.balance)),
          h('td', {}, status(m.frozen), m.frozenReason ? h('div', { class: 'sub muted' }, m.frozenReason) : null),
          h('td', {}, h('button', { class: 'btn ghost small', onclick: () => setFrozen('merchant', m.id, m.shopName, !m.frozen) }, m.frozen ? 'Unfreeze' : 'Freeze'))))));
      } catch (ex) { if (!onAuthError(ex)) box.replaceChildren(h('p', { class: 'empty' }, ex.message)); }
    };
    search.addEventListener('input', debounce(load));
    show(h('div', { class: 'card' }, h('h2', {}, 'Shops'), h('div', { class: 'toolbar' }, search), box));
    load();
  }

  // ---------- transactions ----------
  function txs() {
    const box = h('div');
    const type = h('select', { id: 'type', 'aria-label': 'Type' },
      [['', 'All types'], ['payment', 'Payments'], ['refund', 'Refunds'], ['transfer', 'Transfers'], ['topup', 'Top-ups'], ['payout', 'Payouts']]
        .map(([v, l]) => h('option', { value: v }, l)));
    const search = h('input', { id: 'q', type: 'search', placeholder: 'Transaction ID' });
    const who = (t) => t.type === 'transfer' ? `${t.customerName} → ${t.toName}`
      : t.type === 'payout' ? t.shopName : t.type === 'topup' ? t.customerName
        : `${t.customerName} · ${t.shopName}${t.cashier ? ' (' + t.cashier + ')' : ''}`;
    const load = async () => {
      try {
        const { items } = await api('GET', `/api/admin/transactions?limit=200&type=${encodeURIComponent(type.value)}&q=${encodeURIComponent(search.value)}`);
        box.replaceChildren(table(['Time', 'ID', 'Type', 'Who', 'Amount', 'Fee', ''], items.map((t) => h('tr', {},
          h('td', {}, when(t.createdAt)), h('td', {}, t.id), h('td', {}, t.type + (t.method ? ` (${t.method})` : '')),
          h('td', {}, who(t)), num(yen(t.amount)), num(t.fee ? yen(t.fee) : '—'),
          h('td', {}, t.type === 'payout' ? null : h('a', { href: `/receipt/?id=${encodeURIComponent(t.id)}`, target: '_blank', rel: 'noopener' }, 'Receipt'))))));
      } catch (ex) { if (!onAuthError(ex)) box.replaceChildren(h('p', { class: 'empty' }, ex.message)); }
    };
    type.addEventListener('change', load);
    search.addEventListener('input', debounce(load));
    show(h('div', { class: 'card' }, h('h2', {}, 'Transactions'), h('div', { class: 'toolbar' }, type, search), box));
    load();
  }

  // ---------- admin log ----------
  async function log() {
    try {
      const { items } = await api('GET', '/api/admin/log?limit=200');
      show(h('div', { class: 'card' }, h('h2', {}, 'Admin log'),
        h('p', { class: 'muted' }, 'Every freeze and unfreeze is recorded here permanently.'),
        table(['Time', 'Admin', 'Action', 'Target', 'Reason'], items.map((l) => h('tr', {},
          h('td', {}, when(l.createdAt)), h('td', {}, l.admin), h('td', {}, l.action),
          h('td', {}, `${l.targetType === 'user' ? 'Customer' : 'Shop'} #${l.targetId}`), h('td', {}, l.reason || '—'))))));
    } catch (ex) { if (!onAuthError(ex)) show(h('div', { class: 'card empty' }, ex.message)); }
  }

  // ---------- start ----------
  function start(me) {
    emailEl.textContent = me.email;
    nav.hidden = false; logoutBtn.hidden = false;
    go('overview');
  }
  logoutBtn.addEventListener('click', async () => {
    try { await api('POST', '/api/admin/logout'); } catch { /* ignore */ }
    authView();
  });
  api('GET', '/api/admin/me').then(start).catch(authView);
})();
