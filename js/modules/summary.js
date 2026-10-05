// Reports tab: business summary for a day / week / month / year / custom range, built from transaction records.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, localDate, today, round2, AppError } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';

const $ = window.jQuery;
const live = (x) => x.filter((d) => d.status !== 'void');
const sum = (arr, f) => round2(arr.reduce((s, x) => s + (f(x) || 0), 0));

let $root = null;
let range = { key: 'day', from: today(), to: today() };
let pm = ''; // payment-mode filter: '' = all, 'udhar', or a payment account id

const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const dmy = (s, o = { day: 'numeric', month: 'long', year: 'numeric' }) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, o);

function span(key, anchor) {
  const d = new Date(anchor + 'T00:00:00');
  if (key === 'day') return [anchor, anchor];
  if (key === 'week') { const wd = (d.getDay() + 6) % 7; const from = addDays(anchor, -wd); return [from, addDays(from, 6)]; }
  if (key === 'month') return [localDate(new Date(d.getFullYear(), d.getMonth(), 1)), localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  return [localDate(new Date(d.getFullYear(), 0, 1)), localDate(new Date(d.getFullYear(), 11, 31))];
}

function shift(dir) {
  if (range.key === 'custom') {
    const n = Math.round((new Date(range.to) - new Date(range.from)) / 86400000) + 1;
    range = { key: 'custom', from: addDays(range.from, dir * n), to: addDays(range.to, dir * n) };
  } else if (range.key === 'day') range = { key: 'day', from: addDays(range.from, dir), to: addDays(range.from, dir) };
  else if (range.key === 'week') { const f = addDays(range.from, dir * 7); range = { key: 'week', from: f, to: addDays(f, 6) }; }
  else {
    const d = new Date(range.from + 'T00:00:00');
    const anchor = range.key === 'month' ? localDate(new Date(d.getFullYear(), d.getMonth() + dir, 1)) : localDate(new Date(d.getFullYear() + dir, 0, 1));
    const [from, to] = span(range.key, anchor); range = { key: range.key, from, to };
  }
}

function label() {
  if (range.key === 'day') return dmy(range.from);
  if (range.key === 'month') return dmy(range.from, { month: 'long', year: 'numeric' });
  if (range.key === 'year') return String(new Date(range.from + 'T00:00:00').getFullYear());
  return `${dmy(range.from, { day: 'numeric', month: 'short' })} – ${dmy(range.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

async function figures() {
  const r = IDBKeyRange.bound(range.from, range.to);
  const [salesAll, itemsAll, rets, vouchers] = await idb.read(['sales', 'saleItems', 'saleReturns', 'vouchers'], (t) => Promise.all([
    t.getAllByIndex('sales', 'date', r), t.getAllByIndex('saleItems', 'date', r), t.getAllByIndex('saleReturns', 'date', r), t.getAllByIndex('vouchers', 'date', r),
  ]));
  let sales = live(salesAll);
  if (pm === 'udhar') sales = sales.filter((s) => s.balance > 0);
  else if (pm) sales = sales.filter((s) => s.paymentAccountId === pm && s.paid > 0);
  const ids = new Set(sales.map((s) => s.id));
  const items = itemsAll.filter((i) => ids.has(i.saleId));
  const v = live(vouchers);
  const retLive = pm ? [] : live(rets);

  const modes = new Map(); let udhar = 0;
  for (const s of sales) { if (s.paid > 0) { const n = s.paymentAccountId === 'cash' ? 'Cash' : s.paymentAccountName; modes.set(n, round2((modes.get(n) || 0) + s.paid)); } udhar = round2(udhar + s.balance); }

  const prod = new Map();
  for (const i of items) { const x = prod.get(i.productId || i.name) || { name: i.name, qty: 0 }; x.qty += i.qty; prod.set(i.productId || i.name, x); }

  const revenue = sum(items, (i) => i.amount) - sum(sales, (s) => s.discount)
    - sum(retLive, (x) => sum(x.items, (i) => i.lineAmount ?? i.amount));
  const cost = sum(items, (i) => i.qty * i.cost) - sum(retLive, (x) => sum(x.items, (i) => i.qty * (i.cost || 0)));
  return {
    count: sales.length,
    sales: sum(sales, (s) => s.total),
    profit: round2(revenue - cost),
    expenses: sum(v.filter((x) => x.type === 'payment' && x.counterType === 'expense'), (x) => x.amount),
    income: sum(v.filter((x) => x.type === 'receipt' && x.counterType === 'income'), (x) => x.amount),
    tax: sum(sales, (s) => s.tax),
    discount: round2(sum(sales, (s) => s.discount) + sum(items, (i) => i.discount)),
    top: [...prod.values()].sort((a, b) => b.qty - a.qty).slice(0, 3),
    modes: [...modes.entries()], udhar,
  };
}

const card = (icon, tint, title, body, href = '') => `<${href ? `a href="${href}"` : 'div'} class="stat-row ${href ? 'tap' : ''}">
  <div class="icon-chip tint-${tint}"><i class="bi bi-${icon}"></i></div>
  <div class="min-w-0"><div class="l">${title}</div>${body}</div></${href ? 'a' : 'div'}>`;

async function paint() {
  const f = await figures();
  const c = esc(cur()); const money = (n) => `<div class="v">${c}${fmtNum(n)}</div>`;
  $root.find('.sum-label').text(label());
  $root.find('.sum-cards').html([
    card('receipt-cutoff', 'indigo', 'Total Sales', money(f.sales) + `<div class="sub">${f.count} sale${f.count === 1 ? '' : 's'}</div>`, '#/sales'),
    Auth.can('reports.profit') ? card('graph-up-arrow', 'green', 'Total Profit', money(f.profit)) : '',
    card('wallet2', 'rose', 'Total Expenses', money(f.expenses), '#/cashflow'),
    card('trophy', 'amber', 'Top Stocks', f.top.length ? f.top.map((t) => `<div class="v sm">${esc(t.name)} <span class="sub">× ${esc(fmtQty(t.qty))}</span></div>`).join('') : '<div class="v">-</div>'),
    card('piggy-bank', 'teal', 'Total Other Income', money(f.income), '#/cashflow'),
    card('credit-card-2-front', 'violet', 'Payment Modes', f.modes.length || f.udhar
      ? [...f.modes.map(([n, a]) => `<div class="v sm">${esc(n)} : ${c}${fmtNum(a)}</div>`), f.udhar ? `<div class="v sm">Udhar : ${c}${fmtNum(f.udhar)}</div>` : ''].join('') : '<div class="v">-</div>'),
    card('percent', 'sky', 'Total Tax', money(f.tax)),
    card('tag', 'orange', 'Total Discount', money(f.discount)),
  ].join('') + `<a class="more-link" href="#/reports">Detailed reports <i class="bi bi-chevron-right"></i></a>`);
  $root.find('.sum-fab').toggleClass('on', !!pm);
}

async function pickRange() {
  const m = UI.modal({
    title: 'Select period', size: 'sm', fullscreenMobile: false, scrollable: false,
    body: `<div class="d-grid gap-2">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom range']]
      .map(([k, l]) => `<button class="btn ${range.key === k ? 'btn-primary' : 'btn-light'} text-start" data-k="${k}">${l}</button>`).join('')}</div>`,
  });
  m.$el.on('click', '[data-k]', async function () {
    const k = this.dataset.k; m.close(); await m.closed;
    if (k === 'custom') {
      const r = await UI.formModal({
        title: 'Custom range', submitLabel: 'Apply',
        body: `<div class="row g-2"><div class="col-6"><label class="form-label">From</label><input type="date" name="from" class="form-control" value="${esc(range.from)}"></div>
          <div class="col-6"><label class="form-label">To</label><input type="date" name="to" class="form-control" value="${esc(range.to)}"></div></div>`,
        onSubmit: (v) => { if (!v.from || !v.to || v.from > v.to) throw new AppError('Choose a valid date range.'); return v; },
      });
      if (r) range = { key: 'custom', from: r.from, to: r.to };
    } else { const [from, to] = span(k, range.to > today() ? today() : range.from); range = { key: k, from, to }; }
    pref.set('sumRange', range.key); paint();
  });
}

async function pickMode() {
  const accounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active);
  const opts = [['', 'All payment modes'], ...accounts.map((a) => [a.id, a.name]), ['udhar', 'Udhar (credit sales)']];
  const m = UI.modal({
    title: 'Filter', size: 'sm', fullscreenMobile: false, scrollable: false,
    body: `<div class="small text-body-secondary mb-2">Sales figures only</div><div class="d-grid gap-2">${opts.map(([k, l]) => `<button class="btn ${pm === k ? 'btn-primary' : 'btn-light'} text-start" data-k="${esc(k)}">${esc(l)}</button>`).join('')}</div>`,
  });
  m.$el.on('click', '[data-k]', function () { pm = this.dataset.k; m.close(); paint(); });
}

export default {
  async render(el) {
    this.destroy();
    $root = $(el);
    const key = pref.get('sumRange', 'day');
    const [from, to] = span(key === 'custom' ? 'day' : key, today());
    range = { key: key === 'custom' ? 'day' : key, from, to }; pm = '';
    $root.html(`<div class="sum">
      <div class="range-bar">
        <button class="btn-ico" data-shift="-1" aria-label="Previous"><i class="bi bi-arrow-left"></i></button>
        <button class="range-pick" data-act="range"><i class="bi bi-calendar3"></i><span class="sum-label"></span><i class="bi bi-caret-down-fill small"></i></button>
        <button class="btn-ico" data-shift="1" aria-label="Next"><i class="bi bi-arrow-right"></i></button>
      </div>
      <div class="sum-cards"></div>
      <button class="fab sum-fab" data-act="filter" aria-label="Filter"><i class="bi bi-funnel-fill"></i></button>
    </div>`);
    $root.on('click', '[data-shift]', function () { shift(+this.dataset.shift); paint(); });
    $root.on('click', '[data-act=range]', pickRange);
    $root.on('click', '[data-act=filter]', pickMode);
    this._refresh = () => $root && paint();
    document.addEventListener('data:changed', this._refresh);
    await paint();
  },
  destroy() {
    if (this._refresh) document.removeEventListener('data:changed', this._refresh);
    $root?.off(); $root = null;
  },
};
