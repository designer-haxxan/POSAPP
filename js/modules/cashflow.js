// Cashflow tab: other income & expenses (cash-book vouchers) and purchases, with search, date range and voice search.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtDate, fmtTime, localDate, today, uuid, num, round2, AppError, debounce } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Posting from '../services/posting.js';
import * as Printer from '../printer/printer.js';

const $ = window.jQuery;
let $root = null; let tab = 'cash'; let from = today(); let to = today(); let q = ''; let rows = [];

const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const short = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

async function load() {
  const r = IDBKeyRange.bound(from, to);
  if (tab === 'cash') {
    const v = await idb.getAllByIndex('vouchers', 'date', r);
    rows = v.filter((x) => x.status !== 'void' && ['income', 'expense'].includes(x.counterType) && x.type !== 'transfer')
      .map((x) => ({ kind: x.type === 'receipt' ? 'in' : 'out', id: x.id, title: x.counterName, sub: x.note || x.method || '', amount: x.amount, date: x.date, at: x.createdAt, number: x.number, doc: x }));
  } else {
    const p = await idb.getAllByIndex('purchases', 'date', r);
    rows = p.filter((x) => x.status !== 'void').map((x) => ({ kind: 'purchase', id: x.id, title: x.supplierName || 'Cash purchase', sub: `${x.number} · ${x.itemCount} item(s)`, amount: x.total, date: x.date, at: x.createdAt, number: x.number, doc: x }));
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  draw();
}

function draw() {
  const ql = q.trim().toLowerCase();
  const list = rows.filter((r) => !ql || `${r.title} ${r.sub} ${r.number}`.toLowerCase().includes(ql));
  const inc = round2(list.filter((r) => r.kind === 'in').reduce((a, r) => a + r.amount, 0));
  const out = round2(list.filter((r) => r.kind === 'out').reduce((a, r) => a + r.amount, 0));
  const c = esc(cur());
  $root.find('.cf-range-label').text(from === to ? short(from) : `${short(from)} - ${short(to)}`);
  $root.find('.cf-summary').html(tab === 'cash' && list.length
    ? `<span class="in">+${c}${fmtNum(inc)}</span><span class="out">-${c}${fmtNum(out)}</span><span class="net">Net ${c}${fmtNum(inc - out)}</span>`
    : tab === 'purchase' && list.length ? `<span class="net">Total ${c}${fmtNum(list.reduce((a, r) => a + r.amount, 0))}</span>` : '');
  $root.find('.cf-list').html(list.length ? list.map((r) => `
    <button class="cf-row" data-id="${esc(r.id)}">
      <div class="ic ${r.kind}"><i class="bi bi-${r.kind === 'in' ? 'arrow-down-left' : r.kind === 'out' ? 'arrow-up-right' : 'bag'}"></i></div>
      <div class="min-w-0 flex-grow-1"><div class="t text-truncate">${esc(r.title)}</div><div class="s text-truncate">${esc(r.sub)}${r.sub ? ' · ' : ''}${r.date === today() ? esc(fmtTime(r.at)) : esc(fmtDate(r.date))}</div></div>
      <div class="a ${r.kind}">${r.kind === 'in' ? '+' : r.kind === 'out' ? '-' : ''}${c}${fmtNum(r.amount)}</div>
    </button>`).join('') : `<div class="cf-empty"><div class="avatar-ill"><i class="bi bi-emoji-smile"></i></div><div>No Items To Show Here</div></div>`);
  $root.find('.fab-in, .fab-out').toggleClass('d-none', tab !== 'cash');
  $root.find('.fab-buy').toggleClass('d-none', tab !== 'purchase' || !Auth.can('purchase.manage'));
}

async function categories(type) {
  const accs = (await idb.getAll('accounts')).filter((a) => a.type === type && a.active && !['sales', 'sales_returns', 'purchases', 'purchase_returns'].includes(a.id));
  return accs.sort((a, b) => (a.system ? -1 : 0) - (b.system ? -1 : 0) || a.name.localeCompare(b.name));
}

// type: 'receipt' (income) or 'payment' (expense)
async function addEntry(type) {
  const isIn = type === 'receipt';
  if (!Auth.can(isIn ? 'voucher.create' : 'account.manage')) return UI.toast('You do not have permission for this', 'warning');
  const [cats, pays] = await Promise.all([categories(isIn ? 'income' : 'expense'), idb.getAll('accounts').then((a) => a.filter((x) => ['cash', 'bank'].includes(x.type) && x.active))]);
  const r = await UI.formModal({
    title: isIn ? 'Add income' : 'Add expense', submitLabel: 'Save', submitClass: isIn ? 'btn-success' : 'btn-danger',
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Amount</label><input name="amount" class="form-control form-control-lg" inputmode="decimal" placeholder="0" required></div>
      <div class="col-12"><label class="form-label">Category</label><div class="input-group"><select name="cat" class="form-select">${UI.options(cats, cats[0]?.id)}</select>
        ${Auth.can('account.manage') ? '<button type="button" class="btn btn-outline-secondary btn-newcat" title="New category"><i class="bi bi-plus-lg"></i></button>' : ''}</div></div>
      <div class="col-6"><label class="form-label">${isIn ? 'Received in' : 'Paid from'}</label><select name="account" class="form-select">${UI.options(pays, pref.get('payAccount', 'cash'))}</select></div>
      <div class="col-6"><label class="form-label">Date</label><input type="date" name="date" class="form-control" value="${today()}" max="${today()}" ${Auth.can('account.manage') ? '' : 'readonly'}></div>
      <div class="col-12"><label class="form-label">Note</label><input name="note" class="form-control" maxlength="200" placeholder="Optional"></div></div>`,
    onShown: ($m) => {
      $m.find('[name=amount]').trigger('focus');
      $m.find('.btn-newcat').on('click', async () => {
        const name = prompt(isIn ? 'New income category' : 'New expense category');
        if (!name || !name.trim()) return;
        try {
          const a = await Posting.saveAccount({ name, type: isIn ? 'income' : 'expense' });
          $m.find('[name=cat]').append(`<option value="${esc(a.id)}">${esc(a.name)}</option>`).val(a.id);
        } catch (e) { UI.toastError(e); }
      });
    },
    onSubmit: async (v) => {
      const amount = round2(num(v.amount));
      if (!(amount > 0)) throw new AppError('Enter an amount greater than zero.');
      if (!v.cat) throw new AppError('Choose a category.');
      return (await Posting.saveVoucher({ id: uuid(), type, date: v.date || today(), amount, accountId: v.account, counterAccountId: v.cat, note: v.note })).doc;
    },
  });
  if (r) { UI.toast(isIn ? 'Income added' : 'Expense added'); load(); }
}

async function openRow(id) {
  const row = rows.find((x) => x.id === id);
  if (!row) return;
  if (row.kind === 'purchase') { location.hash = `#/purchases/${encodeURIComponent(id)}`; return; }
  const d = row.doc; const c = esc(cur());
  const m = UI.modal({
    title: `${d.type === 'receipt' ? 'Income' : 'Expense'} ${d.number}`, size: 'sm', fullscreenMobile: false, scrollable: false,
    body: `<div class="text-center mb-3"><div class="display-6 fw-bold ${row.kind}">${c} ${fmtNum(d.amount)}</div><div class="text-body-secondary">${esc(d.counterName)}</div></div>
      <div class="small">${esc(fmtDate(d.date))} · ${esc(d.accountName)}${d.note ? ` · ${esc(d.note)}` : ''}</div>`,
    footer: `<button class="btn btn-outline-secondary btn-print"><i class="bi bi-printer me-1"></i>Print</button>${Auth.can('voucher.void') ? '<button class="btn btn-outline-danger btn-void"><i class="bi bi-x-circle me-1"></i>Void</button>' : ''}`,
  });
  m.$el.find('.btn-print').on('click', () => Printer.printDocument('voucher', d));
  m.$el.find('.btn-void').on('click', async () => {
    m.close(); await m.closed;
    if (!await UI.confirmDialog(`Void ${d.number}? The entry will be removed from your cash flow.`, { okLabel: 'Void', okClass: 'btn-danger' })) return;
    try { await Posting.voidDocument('voucher', d.id); UI.toast('Entry voided'); load(); } catch (e) { UI.toastError(e); }
  });
}

function shiftRange(dir) {
  const n = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  from = addDays(from, dir * n); to = addDays(to, dir * n); load();
}

async function pickDates() {
  const r = await UI.formModal({
    title: 'Date range', submitLabel: 'Apply',
    body: `<div class="d-flex flex-wrap gap-2 mb-3">${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['month', 'This month']].map(([k, l]) => `<button type="button" class="btn btn-sm btn-outline-primary" data-q="${k}">${l}</button>`).join('')}</div>
      <div class="row g-2"><div class="col-6"><label class="form-label">From</label><input type="date" name="from" class="form-control" value="${esc(from)}"></div>
      <div class="col-6"><label class="form-label">To</label><input type="date" name="to" class="form-control" value="${esc(to)}"></div></div>`,
    onShown: ($m) => $m.on('click', '[data-q]', function () {
      const k = this.dataset.q; const t = today();
      const [f, e] = k === 'today' ? [t, t] : k === 'yesterday' ? [addDays(t, -1), addDays(t, -1)] : k === 'week' ? [addDays(t, -6), t] : [t.slice(0, 8) + '01', t];
      $m.find('[name=from]').val(f); $m.find('[name=to]').val(e);
    }),
    onSubmit: (v) => { if (!v.from || !v.to || v.from > v.to) throw new AppError('Choose a valid date range.'); return v; },
  });
  if (r) { from = r.from; to = r.to; load(); }
}

function listen() {
  if (!SR) return;
  const rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = false;
  rec.onresult = (e) => { q = e.results[0][0].transcript; $root?.find('.cf-q').val(q); draw(); };
  rec.onerror = () => UI.toast('Could not hear anything. Check microphone permission.', 'warning');
  try { rec.start(); UI.toast('Listening…', 'info', 1500); } catch { /* already listening */ }
}

export default {
  async render(el) {
    this.destroy();
    $root = $(el); tab = 'cash'; from = to = today(); q = '';
    $root.html(`<div class="cf">
      <div class="range-bar plain">
        <button class="btn-ico" data-shift="-1" aria-label="Previous"><i class="bi bi-arrow-left"></i></button>
        <button class="range-pick" data-act="dates"><i class="bi bi-calendar3"></i><span class="cf-range-label"></span></button>
        <button class="btn-ico" data-shift="1" aria-label="Next"><i class="bi bi-arrow-right"></i></button>
      </div>
      <div class="cf-search"><i class="bi bi-search"></i><input type="search" class="cf-q" placeholder="" aria-label="Search"><button class="mic ${SR ? '' : 'd-none'}" data-act="mic" aria-label="Voice search"><i class="bi bi-mic-fill"></i></button></div>
      <div class="seg flat"><button data-tab="cash" class="active">INCOME / EXPENSE</button><button data-tab="purchase">PURCHASE</button></div>
      <div class="cf-summary"></div>
      <div class="cf-list"></div>
      <button class="fab-pill fab-in" data-act="in">+ Income</button>
      <button class="fab-pill fab-out" data-act="out">- Expense</button>
      <a class="fab-pill fab-buy d-none" href="#/purchase/new">+ Purchase</a>
    </div>`);
    $root.on('click', '[data-shift]', function () { shiftRange(+this.dataset.shift); });
    $root.on('click', '[data-act=dates]', pickDates);
    $root.on('click', '[data-act=mic]', listen);
    $root.on('click', '[data-act=in]', () => addEntry('receipt'));
    $root.on('click', '[data-act=out]', () => addEntry('payment'));
    $root.on('click', '.seg [data-tab]', function () { tab = this.dataset.tab; $root.find('.seg button').removeClass('active'); $(this).addClass('active'); load(); });
    $root.on('input', '.cf-q', debounce(function () { q = this.value; draw(); }, 120));
    $root.on('click', '.cf-row', function () { openRow(this.dataset.id); });
    await load();
  },
  destroy() { $root?.off(); $root = null; },
};
