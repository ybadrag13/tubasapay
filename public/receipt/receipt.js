// TsubuPay receipt page: /receipt/?id=TX...
(function () {
  'use strict';
  const { api, h, $, yen } = window.Tsubu;
  const view = $('#view');
  const id = new URLSearchParams(location.search).get('id') || '';

  const full = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' JST';
  const TITLES = { payment: 'Payment receipt', refund: 'Refund receipt', transfer: 'Transfer receipt', topup: 'Top-up receipt', payout: 'Payout record' };
  const METHOD = { cpm: 'Barcode / QR at register', mpm: 'Store QR (scanned by customer)' };

  function rows(r) {
    const out = [];
    const add = (k, v) => { if (v != null && v !== '') out.push([k, v]); };
    if (r.type === 'payment' || r.type === 'refund') {
      add('Shop', r.shopName); add('Store code', r.storeCode); add('Customer', r.customerName);
      if (r.type === 'payment') add('Method', METHOD[r.method]);
      add('Served by', r.cashier);
    }
    if (r.type === 'transfer') { add('From', r.customerName); add('To', r.toName); add('Message', r.note); }
    if (r.type === 'refund') add('Reason', r.note);
    if (r.type === 'topup' || r.type === 'payout') add('Note', r.note);
    add('Date', full(r.createdAt));
    add('Transaction ID', r.id);
    if (r.type === 'refund' && r.refTx) add('Original payment', r.refTx);
    if (r.fee != null && r.type === 'payment') { add('Shop fee', yen(r.fee)); add('Shop receives', yen(r.net)); }
    if (r.type === 'payment' && r.refundedAmount) add('Refunded so far', yen(r.refundedAmount));
    return out;
  }

  function asText(r) {
    return [`TsubuPay — ${TITLES[r.type]}`, `Amount: ${yen(r.amount)}`, ...rows(r).map(([k, v]) => `${k}: ${v}`),
      '', 'This receipt was issued by TsubuPay (prototype).'].join('\n');
  }

  function render(r) {
    const amountLabel = r.type === 'transfer' ? (r.direction === 'in' ? 'Received' : 'Sent') : 'Amount';
    const mail = h('a', { class: 'btn secondary', href: `mailto:?subject=${encodeURIComponent(`TsubuPay ${TITLES[r.type]} ${r.id}`)}&body=${encodeURIComponent(asText(r))}` }, '✉ Email');
    const copy = h('button', { class: 'btn ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(asText(r)); copy.textContent = '✓ Copied'; } catch { copy.textContent = 'Copy failed'; }
    } }, '⧉ Copy');
    view.replaceChildren(
      h('div', { class: 'card printable receipt' },
        h('div', { class: 'receipt-head' },
          h('div', { class: 'logo' }, 'TsubuPay'),
          h('div', { class: 'muted' }, TITLES[r.type] || 'Receipt')),
        h('div', { class: 'receipt-amount' }, h('div', { class: 'balance-label' }, amountLabel), h('div', { class: 'balance' }, yen(r.amount))),
        h('dl', { class: 'receipt-rows' }, rows(r).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        r.related.length ? h('div', { class: 'receipt-related' },
          h('div', { class: 'balance-label' }, r.type === 'payment' ? 'Refunds on this payment' : 'Related'),
          h('ul', { class: 'list' }, r.related.map((x) => h('li', {},
            h('a', { href: `/receipt/?id=${encodeURIComponent(x.id)}` }, x.id),
            h('span', { class: 'amt' }, (x.type === 'refund' ? '−' : '') + yen(x.amount)))))) : null,
        h('p', { class: 'muted center' }, 'Thank you for using TsubuPay. Keep this receipt for your records.')),
      h('div', { class: 'grid3 no-print' }, h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print'), mail, copy));
    document.title = `TsubuPay ${TITLES[r.type]} ${r.id}`;
  }

  if (!/^TX[A-Z2-9]{14}$/.test(id)) {
    view.replaceChildren(h('div', { class: 'card empty' }, 'This receipt link is not valid.'));
    return;
  }
  api('GET', '/api/receipt?id=' + encodeURIComponent(id)).then(render).catch((e) => {
    view.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, e.status === 401 ? 'Please log in first' : 'Receipt not available'),
      h('p', { class: 'muted' }, e.status === 401
        ? 'Log in to the TsubuPay app (customer or shop) in this browser, then open this link again.'
        : 'This receipt does not exist, or it belongs to someone else.'),
      h('div', { class: 'grid2' }, h('a', { class: 'btn secondary', href: '/user/' }, 'Customer app'), h('a', { class: 'btn secondary', href: '/shop/' }, 'Shop app'))));
  });
})();
