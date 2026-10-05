// Quick-sale cart shared by the calculator (Sales tab) and the checkout screen. Persisted so it survives refreshes.
import { storageKey } from '../config.js';
import { uuid, today, num, round2, round3 } from '../core/utils.js';
import { getSettings } from '../core/settings.js';
import * as Posting from './posting.js';

const KEY = storageKey('draft.quick');

const fresh = () => ({ id: uuid(), date: today(), lines: [], discountType: 'amt', discountValue: 0, taxRate: null, partyId: null, partyName: '', note: '' });

let st = (() => {
  try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d && Array.isArray(d.lines)) return { ...fresh(), ...d }; } catch { /* ignore */ }
  return fresh();
})();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* storage full or blocked */ }
  document.dispatchEvent(new CustomEvent('cart:changed'));
}

export const get = () => st;
export const count = () => st.lines.length;
export const isEmpty = () => !st.lines.length;

export function reset() { st = fresh(); persist(); }

// Replace the cart with a saved one (e.g. resumed from "Saved"), always under a new document id.
export function load(state) {
  st = { ...fresh(), ...state, id: uuid(), date: today() };
  persist();
}

export function snapshot() { return JSON.parse(JSON.stringify(st)); }

export function addCustom(rate, qty = 1, name = '') {
  const n = st.lines.length + 1;
  st.lines.push({ productId: null, name: name || `Item ${n}`, unit: '', qty: round3(qty), rate: round2(rate), discount: 0 });
  persist();
}

export function addProduct(p, qty = 1) {
  const i = st.lines.findIndex((l) => l.productId === p.id && !l.discount);
  if (i >= 0) st.lines[i].qty = round3(st.lines[i].qty + qty);
  else st.lines.push({ productId: p.id, name: p.name, unit: p.unit || '', qty, rate: p.salePrice || 0, discount: 0 });
  persist();
}

export function updateLine(i, patch) { Object.assign(st.lines[i], patch); persist(); }
export function removeLine(i) { st.lines.splice(i, 1); persist(); }
export function set(patch) { Object.assign(st, patch); persist(); }

export function taxRate() {
  if (st.taxRate !== null && st.taxRate !== undefined) return num(st.taxRate);
  const s = getSettings();
  return s.taxEnabled ? num(s.taxRate) : 0;
}

export function discountAmount(subtotal) {
  const v = num(st.discountValue);
  const d = st.discountType === 'pct' ? round2(subtotal * v / 100) : round2(v);
  return Math.max(0, Math.min(d, subtotal));
}

const EMPTY = { lines: [], subtotal: 0, discount: 0, taxRate: 0, tax: 0, total: 0, qtyTotal: 0 };

export function totals() {
  const base = Posting.previewDoc(st.lines, 0, 0);
  if (!base) return { ...EMPTY, invalid: true };
  return Posting.previewDoc(st.lines, discountAmount(base.subtotal), taxRate()) || { ...EMPTY, invalid: true };
}

// Builds the input for Posting.saveSale from the current cart.
export function saleInput({ tendered, paymentAccountId = 'cash', customerId = st.partyId } = {}) {
  const t = totals();
  return {
    id: st.id, date: st.date, items: st.lines, discount: t.discount, taxRate: t.taxRate,
    tendered, paymentAccountId, customerId: customerId || null, note: st.note || '',
  };
}
