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
    ({ overview, kyc, users, shops, txs, log })[t]();
    refreshKycCount();
  }

  async function refreshKycCount() {
    try {
      const o = await api('GET', '/api/admin/kyc?status=pending&limit=200');
      const el = $('#kyc-count'); if (el) el.textContent = o.items.length ? String(o.items.length) : '';
    } catch { /* ignore */ }
  }
  const kycStatus = (st) => h('span', { class: 'status ' + (st === 'approved' ? 'ok' : st === 'pending' ? 'wait' : 'bad') },
    { approved: 'Verified', pending: 'Pending', rejected: 'Rejected', none: 'Not verified' }[st] || st);
  const DOC = { drivers_license: "Driver's licence", residence_card: 'Residence card', passport: 'Passport' };
  const age = (d) => { const b = new Date(d + 'T00:00:00Z'), n = new Date(); let a = n.getUTCFullYear() - b.getUTCFullYear();
    if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--; return a; };

  // ---------- identity verification queue ----------
  function kyc() {
    const status = h('select', { id: 'kyc-status', 'aria-label': 'Status' },
      [['pending', 'Waiting for review'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([v, l]) => h('option', { value: v }, l)));
    const listBox = h('ul', { class: 'list' });
    const detail = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Choose a submission on the left.'));
    const open = (k) => {
      const img = (which, label) => h('figure', {}, h('figcaption', {}, label),
        h('img', { src: `/api/admin/kyc/image?id=${k.id}&which=${which}`, alt: label, loading: 'lazy' }));
      const reason = h('input', { id: 'kyc-reason', maxlength: 200, placeholder: 'Reason (required to reject), e.g. selfie gesture missing' });
      const decide = async (decision) => {
        if (decision === 'approve' && !(await confirmBox({ title: `Approve ${k.legalName}?`, body: 'Only approve if the selfie clearly shows the same person as the ID photo, doing the requested gesture, and the details match the document.', ok: 'Approve' }))) return;
        try {
          await api('POST', '/api/admin/kyc/review', { id: k.id, decision, reason: reason.value.trim() });
          toast(decision === 'approve' ? `${k.legalName} verified.` : 'Rejected. The person sees your reason and can try again.');
          kyc();
        } catch (ex) { if (!onAuthError(ex)) toast(ex.message, 5000); }
      };
      detail.replaceChildren(...[
        h('div', { class: 'row between' }, h('h2', {}, k.legalName), kycStatus(k.status)),
        k.otherAccounts ? h('div', { class: 'warn' }, `⚠ This ID number was also submitted by ${k.otherAccounts} other account(s). Check carefully.`) : null,
        h('dl', { class: 'kv' },
          h('dt', {}, 'Account'), h('dd', {}, `${k.subjectType === 'user' ? 'Customer' : 'Shop owner'} · ${k.account}`),
          h('dt', {}, 'Document'), h('dd', {}, `${DOC[k.docType]} · ends ${k.docLast4}`),
          h('dt', {}, 'Date of birth'), h('dd', {}, `${k.birthDate} (age ${age(k.birthDate)})`),
          h('dt', {}, 'Address'), h('dd', {}, k.address),
          h('dt', {}, 'Selfie must show'), h('dd', {}, h('b', {}, k.gesture)),
          h('dt', {}, 'Submitted'), h('dd', {}, when(k.createdAt))),
        h('p'),
        h('div', { class: 'kyc-imgs' }, img('selfie', 'Live selfie'), img('front', 'ID front'), k.hasBack ? img('back', 'ID back') : null),
        h('p', { class: 'muted' }, 'Check: same face on selfie and ID · gesture is correct · name, date of birth and address match the document · ID looks genuine and unexpired.'),
        k.status === 'pending' ? h('div', {}, h('label', { for: 'kyc-reason' }, 'Reason'), reason, h('p'),
          h('div', { class: 'grid2' }, h('button', { class: 'btn danger', onclick: () => decide('reject') }, 'Reject'),
            h('button', { class: 'btn', onclick: () => decide('approve') }, 'Approve'))) : h('p', { class: 'muted' }, k.reason ? `Note: ${k.reason}` : ''),
      ].filter(Boolean));
    };
    const load = async () => {
      try {
        const { items } = await api('GET', '/api/admin/kyc?limit=200&status=' + status.value);
        listBox.replaceChildren(...(items.length ? items.map((k) => h('li', { class: 'clickable', onclick: () => open(k) },
          h('div', {}, h('div', { class: 'title' }, k.legalName, k.otherAccounts ? h('span', { class: 'tag refund' }, 'DUPLICATE ID') : null),
            h('div', { class: 'sub' }, `${k.subjectType === 'user' ? 'Customer' : 'Shop'} · ${DOC[k.docType]} · ${when(k.createdAt)}`)),
          kycStatus(k.status))) : [h('li', { class: 'empty' }, status.value === 'pending' ? 'Nothing waiting. All caught up.' : 'Nothing here.')]));
        if (items.length) open(items[0]);
        else detail.replaceChildren(h('p', { class: 'muted' }, 'Nothing selected.'));
      } catch (ex) { if (!onAuthError(ex)) listBox.replaceChildren(h('li', { class: 'empty' }, ex.message)); }
    };
    status.addEventListener('change', load);
    show(h('div', { class: 'kyc-admin' }, h('div', { class: 'card' }, h('h2', {}, 'Identity checks'), h('div', { class: 'toolbar' }, status), listBox), detail));
    load();
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
          stat('Shops', String(o.merchants)), stat('Frozen shops', String(o.frozenMerchants)),
          stat('Verified (KYC)', String(o.kycApproved)), stat('Waiting for review', String(o.kycPending)))),
        h('div', { class: 'card' }, h('h2', {}, 'Today (JST)'), h('div', { class: 'stats' },
          stat('Transactions', String(o.today.transactions)), stat('Payment volume', yen(o.today.paymentVolume)),
          stat('Transfer volume', yen(o.today.transferVolume)))),
        h('div', { class: 'card' }, h('h2', {}, 'Money held'), h('div', { class: 'stats' },
          stat('Customer wallets', yen(o.money.customerWallets)), stat('Shop balances', yen(o.money.shopBalances)),
          stat('Fee income', yen(o.money.platformFees)), stat('Total held', yen(o.money.heldTotal))),
          h('p', { class: 'muted' }, 'Total held must equal wallets + shop balances + fees. In production this is matched daily against the bank account.')),
        h('div', { class: 'card' }, h('h2', {}, 'Storage'),
          o.storage.mode === 'turso'
            ? h('div', { class: 'result ' + (o.storage.synced && !o.storage.lastError ? 'ok' : 'err') },
              o.storage.synced && !o.storage.lastError ? '✓ Saved permanently in Turso. Everything is synced.'
                : `Syncing to Turso: ${o.storage.pending} change(s) waiting${o.storage.lastError ? ' (' + o.storage.lastError + ')' : ''}. It keeps retrying.`)
            : h('div', { class: 'result err' }, 'Local storage only. On free hosting, data resets when the server sleeps. Set TURSO_DATABASE_URL to keep it.')),
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
        box.replaceChildren(table(['ID', 'Name', 'Phone', 'Identity', 'Balance', 'Joined', 'Status', ''], items.map((u) => h('tr', {},
          num(String(u.id)), h('td', {}, u.name), h('td', {}, u.phone), h('td', {}, kycStatus(u.kycStatus)), num(yen(u.balance)), h('td', {}, when(u.createdAt)),
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
        box.replaceChildren(table(['ID', 'Shop', 'Store code', 'Email', 'Owner ID', 'Staff', 'Balance', 'Status', ''], items.map((m) => h('tr', {},
          num(String(m.id)), h('td', {}, m.shopName), h('td', {}, m.storeCode), h('td', {}, m.email), h('td', {}, kycStatus(m.kycStatus)), num(String(m.staff)), num(yen(m.balance)),
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
        h('p', { class: 'muted' }, 'Every freeze, unfreeze and identity decision is recorded here permanently.'),
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
