// Checkout (#/cart) and receipt (#/receipt/:id) screens of the quick-sale flow.
import { CONFIG } from '../config.js';
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtDate, fmtDateTime, today, num, round2, round3, AppError } from '../core/utils.js';
import { cur } from '../core/views.js';
import { getSettings, pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Cart from '../services/cart.js';
import * as Printer from '../printer/printer.js';
import { partyPicker } from './parties.js';

const $ = window.jQuery;
let $root = null; let busy = false;

export const supportLink = () => `https://wa.me/${waNumber(CONFIG.SUPPORT_PHONE)}`;

// Pakistani numbers: 03xx… → 923xx…; anything else is used as typed (digits only).
export function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('0') ? '92' + d.slice(1) : d;
}

// ---------- checkout ----------
function checkoutLayout() {
  const st = Cart.get();
  const canDate = Auth.can('sale.edit');
  return `<div class="co">
    <header class="co-bar">
      <a class="btn-ico" href="#/sell" aria-label="Back"><i class="bi bi-arrow-left"></i></a>
      <a class="btn-ico" href="${supportLink()}" target="_blank" rel="noopener" aria-label="Support"><i class="bi bi-headset"></i></a>
      <label class="co-date ${canDate ? '' : 'static'}"><i class="bi bi-calendar3"></i><span>${esc(new Date(st.date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}</span>${canDate ? '<i class="bi bi-caret-down-fill small"></i><input type="date" class="co-date-in" max="' + today() + '" value="' + esc(st.date) + '">' : ''}</label>
      <div class="co-top-total"></div>
    </header>
    <div class="co-lines"></div>
    <div class="co-sum">
      <div class="row-kv"><span>Subtotal</span><span class="v-sub"></span></div>
      <div class="d-flex gap-2 my-2">
        <button class="btn-outline-brand flex-fill" data-act="tax">Add Tax</button>
        <button class="btn-outline-brand flex-fill" data-act="discount">Add Discount</button>
      </div>
      <div class="row-kv adj d-none v-tax-row"><span class="v-tax-label"></span><span class="v-tax"></span></div>
      <div class="row-kv adj d-none v-disc-row"><span>Discount</span><span class="v-disc"></span></div>
      <hr class="m-0">
      <div class="row-kv grand"><span>Grand Total</span><span class="v-total"></span></div>
      <div class="row-kv light"><span>Total Items</span><span class="v-items"></span></div>
    </div>
    <div class="co-actions">
      <button class="btn-white" data-act="later">Save For Later</button>
      <a class="btn-brand" href="#/sell">+Add New Item</a>
    </div>
    <div class="co-pay-title">Choose Payment Mode</div>
    <div class="co-pay">
      <button data-pay="cash"><i class="bi bi-cash-stack"></i>Cash</button>
      <button data-pay="udhar">Udhar</button>
      <button data-pay="more"><span class="dots">•••</span>More</button>
    </div>
  </div>`;
}

function renderCheckout() {
  const st = Cart.get(); const t = Cart.totals(); const c = esc(cur());
  $root.find('.co-top-total').text(`${cur()}${fmtNum(t.total)}`);
  $root.find('.co-lines').html(st.lines.length ? st.lines.map((l, i) => `
    <div class="co-line" data-i="${i}" role="button" tabindex="0">
      <div class="min-w-0"><div class="n text-truncate">${esc(l.name)}</div><div class="m">${c}${fmtNum(l.rate)} &nbsp;x${esc(fmtQty(l.qty))}${l.discount ? ` · disc ${fmtNum(l.discount)}` : ''}</div></div>
      <div class="a">${c}${fmtNum(round2(l.qty * l.rate - (l.discount || 0)))}</div>
    </div>`).join('') : UI.emptyState('No items. Tap “+Add New Item”.', 'cart'));
  $root.find('.v-sub').text(`${cur()}${fmtNum(t.subtotal)}`);
  $root.find('.v-total').text(`${cur()}${fmtNum(t.total)}`);
  $root.find('.v-items').text(st.lines.length);
  $root.find('.v-tax-row').toggleClass('d-none', !t.tax);
  $root.find('.v-tax-label').text(`Tax (${t.taxRate}%)`);
  $root.find('.v-tax').text(`${cur()}${fmtNum(t.tax)}`);
  $root.find('.v-disc-row').toggleClass('d-none', !t.discount);
  $root.find('.v-disc').text(`-${cur()}${fmtNum(t.discount)}`);
  $root.find('[data-act=tax]').text(t.taxRate ? `Tax ${t.taxRate}%` : 'Add Tax');
  $root.find('[data-act=discount]').text(t.discount ? `Discount ${cur()}${fmtNum(t.discount)}` : 'Add Discount');
  $root.find('.co-pay button, [data-act=later]').prop('disabled', !st.lines.length || t.invalid);
}

async function editLine(i) {
  const l = Cart.get().lines[i];
  const r = await UI.formModal({
    title: 'Edit item', submitLabel: 'Update',
    body: `<div class="row g-2">
      <div class="col-12"><label class="form-label">Name</label><input name="name" class="form-control form-control-lg" maxlength="120" value="${esc(l.name)}"></div>
      <div class="col-6"><label class="form-label">Price</label><input name="rate" class="form-control form-control-lg" inputmode="decimal" value="${l.rate}"></div>
      <div class="col-6"><label class="form-label">Quantity</label><input name="qty" class="form-control form-control-lg" inputmode="decimal" value="${l.qty}"></div>
      <div class="col-12"><button type="button" class="btn btn-outline-danger w-100 btn-remove"><i class="bi bi-trash me-1"></i>Remove item</button></div></div>`,
    onShown: ($m) => $m.find('.btn-remove').on('click', () => { Cart.removeLine(i); $m.find('[data-bs-dismiss=modal]').first().trigger('click'); }),
    onSubmit: (v) => {
      const rate = round2(num(v.rate)); const qty = round3(num(v.qty));
      if (rate < 0) throw new AppError('Price cannot be negative.');
      if (!(qty > 0)) throw new AppError('Quantity must be greater than zero.');
      return { name: (v.name || '').trim() || l.name, rate, qty, discount: 0 };
    },
  });
  if (r) Cart.updateLine(i, r);
}

async function editTax() {
  const r = await UI.formModal({
    title: 'Add tax', body: `<label class="form-label">Tax percent (%)</label><input name="rate" class="form-control form-control-lg" inputmode="decimal" value="${Cart.taxRate() || ''}" placeholder="0">`,
    onSubmit: (v) => { const n = num(v.rate); if (n < 0 || n > 100) throw new AppError('Enter a percent between 0 and 100.'); return n; },
  });
  if (r !== null && r !== undefined) Cart.set({ taxRate: r });
}

async function editDiscount() {
  const st = Cart.get();
  const r = await UI.formModal({
    title: 'Add discount',
    body: `<div class="btn-group w-100 mb-3"><input type="radio" class="btn-check" name="type" id="dt-amt" value="amt" ${st.discountType === 'amt' ? 'checked' : ''}><label class="btn btn-outline-primary" for="dt-amt">Amount (${esc(cur())})</label>
      <input type="radio" class="btn-check" name="type" id="dt-pct" value="pct" ${st.discountType === 'pct' ? 'checked' : ''}><label class="btn btn-outline-primary" for="dt-pct">Percent (%)</label></div>
      <input name="value" class="form-control form-control-lg" inputmode="decimal" value="${st.discountValue || ''}" placeholder="0">`,
    onSubmit: (v) => {
      const n = num(v.value); const sub = Cart.totals().subtotal;
      if (n < 0) throw new AppError('Discount cannot be negative.');
      if (v.type === 'pct' && n > 100) throw new AppError('Percent cannot exceed 100.');
      if (v.type === 'amt' && n > sub) throw new AppError('Discount cannot exceed the subtotal.');
      return { discountType: v.type, discountValue: n };
    },
  });
  if (r) Cart.set(r);
}

async function complete({ accountId = 'cash', tendered, customerId }) {
  if (busy) return; busy = true;
  try {
    if (!Auth.can('sale.create')) throw new AppError('You do not have permission to create sales.');
    const t = Cart.totals();
    if (t.invalid || !t.lines.length) throw new AppError('Please fix the items in the cart.');
    const input = Cart.saleInput({ tendered: tendered ?? t.total, paymentAccountId: accountId, customerId });
    const { doc } = await Posting.saveSale(input);
    Cart.reset();
    if (pref.get('sound', true)) UI.beep();
    location.hash = `#/receipt/${doc.id}/new`;
  } catch (e) { UI.toastError(e); } finally { busy = false; }
}

async function payUdhar() {
  const p = await partyPicker('customers', {});
  if (!p) return;
  Cart.set({ partyId: p.id, partyName: p.name });
  await complete({ tendered: 0, customerId: p.id });
}

async function payMore() {
  const accounts = (await idb.getAll('accounts')).filter((a) => ['cash', 'bank'].includes(a.type) && a.active && a.id !== 'cash');
  const m = UI.modal({
    title: 'Payment mode', size: 'sm', fullscreenMobile: false, scrollable: false,
    body: `<div class="d-grid gap-2">
      ${accounts.map((a) => `<button class="btn btn-light text-start py-3" data-acc="${esc(a.id)}"><i class="bi bi-bank me-2"></i>${esc(a.name)}</button>`).join('')}
      <button class="btn btn-light text-start py-3" data-part><i class="bi bi-percent me-2"></i>Part payment (rest on Udhar)</button>
      ${accounts.length ? '' : '<div class="small text-body-secondary">Add a bank or wallet account under More → Payment Settings to take card, bank or wallet payments.</div>'}</div>`,
  });
  m.$el.on('click', '[data-acc]', async function () { const id = this.dataset.acc; m.close(); await m.closed; complete({ accountId: id }); });
  m.$el.on('click', '[data-part]', async () => { m.close(); await m.closed; partPayment(accounts); });
}

async function partPayment(accounts) {
  const t = Cart.totals();
  const p = await partyPicker('customers', {});
  if (!p) return;
  const all = [{ id: 'cash', name: 'Cash' }, ...accounts];
  const r = await UI.formModal({
    title: `Part payment — ${p.name}`, submitLabel: 'Complete sale',
    body: `<div class="mb-2">Total <b>${esc(cur())} ${fmtNum(t.total)}</b></div>
      <label class="form-label">Amount received now</label><input name="amount" class="form-control form-control-lg mb-2" inputmode="decimal" placeholder="0">
      <label class="form-label">Received in</label><select name="account" class="form-select">${UI.options(all, 'cash')}</select>
      <div class="form-text">The remaining amount is added to ${esc(p.name)}'s account (Udhar).</div>`,
    onSubmit: (v) => {
      const a = round2(num(v.amount));
      if (a < 0 || a > t.total) throw new AppError('Amount must be between 0 and the total.');
      return { amount: a, account: v.account };
    },
  });
  if (r) complete({ accountId: r.account, tendered: r.amount, customerId: p.id });
}

// ---------- receipt ----------
async function receiptScreen(id, isNew) {
  const doc = await idb.get('sales', id);
  if (!doc) throw new AppError('Receipt not found.');
  const items = (await idb.getAllByIndex('saleItems', 'saleId', id)).sort((a, b) => a.line - b.line);
  const list = items.length ? items : (doc.voidedItems || []);
  const s = getSettings(); const c = esc(cur());
  const acct = doc.paymentAccountId === 'cash' ? 'Cash' : doc.paymentAccountName;
  const mode = doc.paymentType === 'credit' ? 'Udhar' : doc.paymentType === 'partial' ? `${acct} + Udhar` : acct;
  const sound = pref.get('sound', true);
  $root.html(`<div class="rc">
    <div class="rc-top"><a class="rc-reports" href="#/summary"><i class="bi bi-bar-chart-fill"></i><span>Show Reports</span></a>
      <button class="btn-ico" data-act="sound" aria-label="Toggle sound"><i class="bi bi-volume-${sound ? 'up' : 'mute'}-fill"></i></button></div>
    <div class="rc-paper">
      ${doc.status === 'void' ? '<div class="rc-void">VOID</div>' : ''}
      <div class="rc-name">${esc(s.business.name)}</div>
      ${s.business.phone ? `<div class="rc-phone">${esc(s.business.phone)}</div>` : ''}
      <div class="rc-title">Invoice</div>
      <div class="rc-meta"><b>Receipt# ${esc(doc.number)}</b><b>${esc(fmtDateTime(doc.createdAt))}</b></div>
      <div class="dash"></div>
      <div class="rc-grid head"><span>Name</span><span>Qty</span><span>Price</span><span class="r">Total</span></div>
      <div class="dash"></div>
      ${list.map((i) => `<div class="rc-grid"><span class="nm">${esc(i.name)}</span><span>${esc(fmtQty(i.qty))}</span><span>${fmtNum(i.rate)}</span><span class="r">${fmtNum(i.amount)}</span></div>`).join('')}
      <div class="dash"></div>
      <div class="rc-sub"><div><div>Items: ${list.length}</div><div>Total Qty: ${esc(fmtQty(doc.qtyTotal))}</div></div><b>Subtotal</b><b>${c}${fmtNum(doc.subtotal)}</b></div>
      ${doc.discount ? `<div class="rc-kv"><span>Discount</span><span>-${c}${fmtNum(doc.discount)}</span></div>` : ''}
      ${doc.tax ? `<div class="rc-kv"><span>Tax (${doc.taxRate}%)</span><span>${c}${fmtNum(doc.tax)}</span></div>` : ''}
      <div class="dash"></div>
      <div class="rc-grand">Grand Total ${c}${fmtNum(doc.total)}</div>
      <div class="dash"></div>
      <div class="rc-pay">Payment Mode: &nbsp;${esc(mode)}</div>
      ${doc.balance ? `<div class="rc-pay due">Balance due (${esc(doc.customerName)}): ${c}${fmtNum(doc.balance)}</div>` : ''}
      <div class="rc-foot">${esc(s.business.footer || 'Thank You, Visit Again')}</div>
      <div class="rc-powered">Powered by ${esc(CONFIG.APP_NAME)}</div>
    </div>
    <a class="rc-details" href="#/sales/${esc(doc.id)}"><i class="bi bi-three-dots"></i> Details, return or void</a>
    <div class="rc-actions">
      <div class="rc-share">
        <button class="btn-brand flex-grow-1" data-act="print"><i class="bi bi-printer-fill"></i></button>
        <button class="btn-round wa" data-act="wa" aria-label="WhatsApp"><i class="bi bi-whatsapp"></i></button>
        <button class="btn-round sms" data-act="sms" aria-label="SMS"><i class="bi bi-chat-dots-fill"></i></button>
        <button class="btn-round share" data-act="share" aria-label="Share"><i class="bi bi-box-arrow-up"></i></button>
      </div>
      <a class="btn-green" href="#/sell">NEW SALE</a>
    </div></div>`);

  const text = shareText(doc, list);
  const doPrint = async () => {
    if (s.printer.method === 'bluetooth') UI.toast(`Connecting to printer: ${s.printer.deviceName || 'Bluetooth printer'}`, 'info', 2500);
    await Printer.printDocument('sale', doc, { silentFail: false });
  };
  $root.on('click', '[data-act=print]', doPrint);
  $root.on('click', '[data-act=sound]', function () { const v = !pref.get('sound', true); pref.set('sound', v); $(this).find('i').attr('class', `bi bi-volume-${v ? 'up' : 'mute'}-fill`); });
  $root.on('click', '[data-act=share]', async () => {
    if (navigator.share) { try { await navigator.share({ title: `Receipt ${doc.number}`, text }); } catch { /* cancelled */ } }
    else { try { await navigator.clipboard.writeText(text); UI.toast('Receipt copied'); } catch { UI.toast('Sharing is not supported on this device', 'warning'); } }
  });
  const phoneFor = async () => {
    const known = doc.customerId ? Catalog.party('customers', doc.customerId)?.phone : '';
    if (known) return known;
    return UI.formModal({ title: 'Customer phone', submitLabel: 'Send', body: '<input name="phone" type="tel" class="form-control form-control-lg" inputmode="tel" placeholder="03xx xxxxxxx">',
      onSubmit: (v) => { if (String(v.phone || '').replace(/\D/g, '').length < 7) throw new AppError('Enter a valid phone number.'); return v.phone; } });
  };
  $root.on('click', '[data-act=wa]', async () => { const p = await phoneFor(); if (p) window.open(`https://wa.me/${waNumber(p)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); });
  $root.on('click', '[data-act=sms]', async () => { const p = await phoneFor(); if (p) location.href = `sms:${String(p).replace(/[^\d+]/g, '')}?body=${encodeURIComponent(text)}`; });

  if (isNew) {
    history.replaceState(null, '', `#/receipt/${id}`); // a reload must not print again
    if (s.printer.autoPrint) doPrint().catch(() => {});
  }
}

function shareText(doc, list) {
  const s = getSettings(); const c = cur();
  return [
    s.business.name, s.business.phone, `Invoice ${doc.number} · ${fmtDate(doc.date)}`, '',
    ...list.map((i) => `${i.name}  ${fmtQty(i.qty)} x ${fmtNum(i.rate)} = ${fmtNum(i.amount)}`), '',
    doc.discount ? `Discount: -${c} ${fmtNum(doc.discount)}` : '', doc.tax ? `Tax: ${c} ${fmtNum(doc.tax)}` : '',
    `Total: ${c} ${fmtNum(doc.total)}`, doc.balance ? `Balance due: ${c} ${fmtNum(doc.balance)}` : '', '', s.business.footer || 'Thank you, visit again',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n');
}

export default {
  async render(el, { route, params }) {
    this.destroy();
    $root = $(el);
    if (route === 'receipt') return receiptScreen(params[0], params[1] === 'new');
    if (Cart.isEmpty()) { location.hash = '#/sell'; return; }
    $root.html(checkoutLayout());
    renderCheckout();
    $root.on('change', '.co-date-in', function () { if (this.value) { Cart.set({ date: this.value }); $root.html(checkoutLayout()); renderCheckout(); } });
    $root.on('click keydown', '.co-line', function (e) { if (e.type === 'keydown' && e.key !== 'Enter') return; editLine(+this.dataset.i).then(renderCheckout); });
    $root.on('click', '[data-act=tax]', () => editTax().then(renderCheckout));
    $root.on('click', '[data-act=discount]', () => editDiscount().then(renderCheckout));
    $root.on('click', '[data-act=later]', async () => {
      const state = Cart.snapshot(); const t = Cart.totals();
      await Posting.saveHold({ id: state.id, label: state.partyName || `Sale ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, state, total: t.total });
      Cart.reset(); UI.toast('Saved for later'); location.hash = '#/sell';
    });
    $root.on('click', '[data-pay]', function () {
      const k = this.dataset.pay;
      if (k === 'cash') complete({ accountId: 'cash' }); else if (k === 'udhar') payUdhar(); else payMore();
    });
  },
  destroy() { $root?.off(); $root = null; },
};
