// Sales tab: calculator keypad (type an amount or rate@qty, add as item), today's sales, and carts saved for later.
import * as idb from '../db/idb.js';
import * as UI from '../core/ui.js';
import { esc, fmtNum, fmtQty, fmtTime, uuid, today, round2, round3 } from '../core/utils.js';
import { cur } from '../core/views.js';
import { pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import * as Posting from '../services/posting.js';
import * as Cart from '../services/cart.js';
import * as Scanner from '../scanner/scanner.js';

const $ = window.jQuery;
let $root = null; let expr = ''; let tab = 'calc'; let detachWedge = null;

// ---------- expression evaluation (no eval) ----------
const OPS = new Set(['+', '−', '×', '÷', '@', '%']);

function tokenize(s) {
  const out = []; let num = '';
  for (const ch of s) {
    if (/[0-9.]/.test(ch)) num += ch;
    else { if (num) { out.push(num); num = ''; } out.push(ch); }
  }
  if (num) out.push(num);
  return out;
}

// Returns a number, or null when the expression is incomplete/invalid.
export function evaluate(s) {
  const t = tokenize(s); let i = 0;
  const factor = () => {
    let sign = 1;
    while (t[i] === '−' || t[i] === '+') { if (t[i] === '−') sign = -sign; i++; }
    const tok = t[i];
    if (tok === undefined || OPS.has(tok)) return NaN;
    i++;
    let v = Number(tok);
    if (Number.isNaN(v)) return NaN;
    while (t[i] === '%') { v /= 100; i++; }
    return sign * v;
  };
  const term = () => {
    let v = factor();
    while (t[i] === '×' || t[i] === '÷' || t[i] === '@') {
      const op = t[i++]; const r = factor();
      v = op === '÷' ? (r === 0 ? NaN : v / r) : v * r;
    }
    return v;
  };
  const sum = () => {
    let v = term();
    while (t[i] === '+' || t[i] === '−') { const op = t[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  if (!t.length) return null;
  const v = sum();
  return i === t.length && Number.isFinite(v) ? round2(v) : null;
}

// "10@120" or "10×120" → quantity 10 at price 120. Anything else is a single item at that amount.
function parseItem(s) {
  const m = /^(\d*\.?\d+)[@×](\d*\.?\d+)$/.exec(s);
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return { qty: Number(m[1]), rate: Number(m[2]) };
  const v = evaluate(s);
  return v !== null && v > 0 ? { rate: v, qty: 1 } : null;
}

// ---------- rendering ----------
const KEYS = [
  ['@', 'op'], ['÷', 'op'], ['−', 'op'], ['C', 'clear'],
  ['7'], ['8'], ['9'], ['+', 'op'],
  ['4'], ['5'], ['6'], ['×', 'op'],
  ['1'], ['2'], ['3'], ['ADD', 'add'],
  ['.'], ['0'], ['%', 'op'],
];

function keypad() {
  return `<div class="calc-keys">
    ${KEYS.map(([k, kind]) => (kind === 'add'
    ? `<button class="ck ck-add" data-act="add">Add<br>Item</button>`
    : `<button class="ck ${kind ? 'ck-' + kind : ''}" data-key="${k}" ${kind === 'clear' ? 'data-act="clear"' : ''}>${k}</button>`)).join('')}
    <button class="ck ck-items" data-act="items" aria-label="Choose from products"><i class="bi bi-box-seam"></i></button>
    <button class="ck ck-cash" data-act="cash"></button>
  </div>`;
}

function layout() {
  return `<div class="qs">
    <div class="qs-top">
      <button class="btn-ico" data-act="scan" aria-label="Scan barcode"><i class="bi bi-upc-scan"></i></button>
      <div class="qs-display"><div class="qs-hist"></div><div class="qs-expr"></div></div>
      <button class="btn-ico filled" data-act="save" aria-label="Save for later"><i class="bi bi-bookmark-fill"></i></button>
    </div>
    <div class="seg" role="tablist">
      <button data-tab="calc" class="active">Calculator</button><button data-tab="sales">Sales</button><button data-tab="saved">Saved</button>
    </div>
    <div class="qs-panel"></div>
  </div>`;
}

function pending() { return expr ? evaluate(expr) : null; }

// Preview of the item being typed, e.g. "Item 2 : Rs10×120" (quantity × price) or "Item 2 : Rs120".
function previewText() {
  if (!expr) return '';
  const it = parseItem(expr);
  const shown = it && /[@×]/.test(expr) ? `${fmtQty(it.qty)}×${fmtNum(it.rate).replace(/\.00$/, '')}` : (pending() !== null && /[+−×÷%]/.test(expr) ? fmtNum(pending()).replace(/\.00$/, '') : expr.replace(/@/g, '×'));
  return `Item ${Cart.count() + 1} : ${cur()}${shown}`;
}

function renderDisplay() {
  const amounts = Cart.get().lines.map((l) => fmtNum(round2(l.qty * l.rate - (l.discount || 0))).replace(/\.00$/, ''));
  $root.find('.qs-hist').text(amounts.length ? amounts.join(' | ') + ' |' : '');
  $root.find('.qs-expr').text(previewText()).toggleClass('dim', !expr);
  $root.find('.ck-cash').text(`Cash In: ${cur()}${fmtNum(Cart.totals().subtotal)}`);
}

async function renderSales() {
  const [sales] = await idb.read(['sales'], (t) => Promise.all([t.getAllByIndex('sales', 'date', IDBKeyRange.only(today()))]));
  const live = sales.filter((s) => s.status !== 'void').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sum = round2(live.reduce((a, s) => a + s.total, 0));
  $root.find('.qs-panel').html(live.length
    ? `<div class="list-head"><span>${live.length} sale(s) today</span><b>${esc(cur())} ${fmtNum(sum)}</b></div>` + live.map((s) => `
      <a class="doc-row" href="#/receipt/${esc(s.id)}">
        <div class="min-w-0"><div class="t">${esc(s.number)}</div><div class="s">${esc(fmtTime(s.createdAt))} · ${esc(s.customerName)}</div></div>
        <div class="text-end"><div class="t">${esc(cur())} ${fmtNum(s.total)}</div><div class="s">${s.paymentType === 'paid' ? esc(s.paymentAccountName) : s.paymentType === 'credit' ? 'Udhar' : 'Partial'}</div></div>
      </a>`).join('') + `<a class="more-link" href="#/sales">All sales <i class="bi bi-chevron-right"></i></a>`
    : UI.emptyState('No sales yet today', 'receipt'));
}

async function renderSaved() {
  const holds = (await idb.getAll('holds')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $root.find('.qs-panel').html(holds.length ? holds.map((h) => `
    <div class="doc-row" data-hold="${esc(h.id)}" role="button" tabindex="0">
      <div class="min-w-0"><div class="t text-truncate">${esc(h.label)}</div><div class="s">${h.state.lines.length} item(s) · ${esc(fmtTime(h.createdAt))}</div></div>
      <div class="d-flex align-items-center gap-2"><b>${esc(cur())} ${fmtNum(h.total)}</b><button class="btn-ico sm danger" data-del="${esc(h.id)}" aria-label="Delete"><i class="bi bi-trash"></i></button></div>
    </div>`).join('') : UI.emptyState('Nothing saved. Tap the bookmark to save a sale for later.', 'bookmark'));
}

function renderPanel() {
  $root.find('.seg button').removeClass('active').filter(`[data-tab="${tab}"]`).addClass('active');
  $root.find('.qs-top .btn-ico[data-act=save]').toggleClass('d-none', tab !== 'calc');
  if (tab === 'calc') $root.find('.qs-panel').html(keypad()); else if (tab === 'sales') renderSales(); else renderSaved();
  renderDisplay();
}

// ---------- actions ----------
function press(k) {
  if (navigator.vibrate && pref.get('vibrate', true)) navigator.vibrate(12);
  if (k === '.') {
    const last = tokenize(expr).pop();
    if (last && /^[0-9.]+$/.test(last) && last.includes('.')) return;
    expr += last && /^[0-9.]+$/.test(last) ? '.' : '0.';
  } else if (OPS.has(k)) {
    if (!expr) { if (k === '−') expr = '−'; return renderDisplay(); }
    const last = expr.slice(-1);
    if (k === '%') { if (!/[0-9]/.test(last) && last !== '%') return; expr += k; }
    else if (OPS.has(last) && last !== '%') expr = expr.slice(0, -1) + k;
    else expr += k;
  } else expr += k;
  if (expr.length > 40) expr = expr.slice(0, 40);
  renderDisplay();
}

function addPending() {
  if (!expr) return false;
  const it = parseItem(expr);
  if (!it) { UI.toast('Enter a valid amount first', 'warning', 1800); return false; }
  Cart.addCustom(it.rate, it.qty);
  expr = '';
  return true;
}

async function chooseProduct() {
  const p = await UI.pick({
    title: 'Add product', placeholder: 'Search products…',
    search: async (q) => Catalog.searchProducts(q, { limit: 40 }).map((x) => ({ id: x.id, title: x.name, subtitle: [x.sku, x.barcode].filter(Boolean).join(' · '), right: `${cur()} ${fmtNum(x.salePrice)}`, value: x })),
  });
  if (p?.value) { Cart.addProduct(p.value); UI.toast(`${p.value.name} added`, 'success', 1200); renderDisplay(); }
}

function addByCode(code) {
  const p = Catalog.findByCode(code);
  if (!p) { UI.toast(`No product found for "${code}"`, 'warning'); return false; }
  UI.beep(); Cart.addProduct(p); UI.toast(`${p.name} added`, 'success', 1200); renderDisplay();
  return true;
}

async function saveForLater() {
  addPending();
  if (Cart.isEmpty()) return UI.toast('Add an item first', 'warning', 1800);
  const state = Cart.snapshot(); const t = Cart.totals();
  await Posting.saveHold({ id: uuid(), label: state.partyName || `Sale ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, state, total: t.total });
  Cart.reset(); expr = ''; tab = 'saved'; renderPanel();
  UI.toast('Saved for later');
}

export default {
  async render(el) {
    this.destroy();
    $root = $(el);
    tab = 'calc';
    $root.html(layout());
    renderPanel();

    $root.on('click', '.seg [data-tab]', function () { tab = this.dataset.tab; renderPanel(); });
    $root.on('click', '[data-key]', function () { press(this.dataset.key); });
    $root.on('click', '[data-act=clear]', () => { if (expr) expr = ''; else if (Cart.count()) { Cart.reset(); } renderDisplay(); });
    $root.on('click', '.qs-expr', () => { expr = expr.slice(0, -1); renderDisplay(); });
    $root.on('click', '[data-act=add]', () => { if (addPending()) renderDisplay(); });
    $root.on('click', '[data-act=items]', chooseProduct);
    $root.on('click', '[data-act=scan]', async () => { const code = await Scanner.scan(); if (code) addByCode(code); });
    $root.on('click', '[data-act=save]', saveForLater);
    $root.on('click', '[data-act=cash]', () => {
      if (expr && !addPending()) return;
      if (Cart.isEmpty()) return UI.toast('Enter an amount or add an item first', 'warning', 1800);
      if (!Auth.can('sale.create')) return UI.toast('You do not have permission to create sales', 'warning');
      location.hash = '#/cart';
    });
    $root.on('click', '[data-del]', async function (e) {
      e.stopPropagation();
      if (!await UI.confirmDialog('Delete this saved sale?', { okLabel: 'Delete', okClass: 'btn-danger' })) return;
      await Posting.deleteHold(this.dataset.del); renderSaved();
    });
    $root.on('click', '[data-hold]', async function () {
      const h = await idb.get('holds', this.dataset.hold);
      if (!h) return;
      if (!Cart.isEmpty() && !await UI.confirmDialog('Replace the current items with this saved sale?', { okLabel: 'Replace' })) return;
      Cart.load(h.state);
      await Posting.deleteHold(h.id);
      location.hash = '#/cart';
    });
    detachWedge = Scanner.attachWedge(addByCode);
  },
  destroy() {
    detachWedge?.(); detachWedge = null;
    $root?.off(); $root = null; expr = '';
  },
};
