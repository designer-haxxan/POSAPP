// Builds a printer-independent receipt model and renders it to ESC/POS bytes or HTML.
import * as idb from '../db/idb.js';
import { CONFIG } from '../config.js';
import { getSettings } from '../core/settings.js';
import { fmtNum, fmtQty, fmtDateTime, fmtDate, esc, localDate } from '../core/utils.js';
import { EscPos, isPlain } from './escpos.js';
import * as Raster from './raster.js';

// "04 Oct 2026 - 3:37 PM"
export function fmtInvoiceDate(iso, fallbackDate = '') {
  const d = iso ? new Date(iso) : new Date(fallbackDate + 'T00:00:00');
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = iso ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  return time ? `${day} - ${time}` : day;
}
// Invoice figures drop a trailing ".00" (1,200 not 1,200.00); totals keep two decimals.
export const trim0 = (n) => fmtNum(n).replace(/\.00$/, '');
export const fmtTotalQty = (n) => (Number.isInteger(Number(n)) ? Number(n).toFixed(1) : fmtQty(n));

const TITLES = { sale: 'SALES RECEIPT', purchase: 'PURCHASE', saleReturn: 'SALE RETURN', purchaseReturn: 'PURCHASE RETURN', receipt: 'PAYMENT RECEIPT', payment: 'PAYMENT VOUCHER', transfer: 'TRANSFER' };

export async function buildReceipt(kind, doc) {
  const s = getSettings();
  const b = s.business;
  const m = { header: [b.name, b.address, b.phone ? 'Tel: ' + b.phone : '', b.taxNo ? 'Tax No: ' + b.taxNo : ''].filter(Boolean), title: TITLES[kind] || kind.toUpperCase(),
    info: [], items: [], totals: [], footer: b.footer || '', void: doc.status === 'void' };
  const sameDay = doc.createdAt && localDate(new Date(doc.createdAt)) === doc.date;
  m.info.push(['No', doc.number], ['Date', sameDay ? fmtDateTime(doc.createdAt) : fmtDate(doc.date)]);
  if (doc.userName) m.info.push(['User', doc.userName]);

  if (kind === 'sale' || kind === 'purchase') {
    const items = await idb.getAllByIndex(kind === 'sale' ? 'saleItems' : 'purchaseItems', kind === 'sale' ? 'saleId' : 'purchaseId', doc.id);
    const list = items.length ? items : (doc.voidedItems || []);
    list.sort((a, b) => a.line - b.line);
    m.info.push([kind === 'sale' ? 'Customer' : 'Supplier', kind === 'sale' ? doc.customerName : doc.supplierName]);
    if (kind === 'sale' && doc.customerPhone) m.info.push(['Phone', doc.customerPhone]);
    m.items = list.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, discount: i.discount, amount: i.amount }));
    if (kind === 'sale') {
      const who = doc.customerId || doc.customerPhone || (doc.customerName && doc.customerName !== 'Walk-in Customer');
      m.invoice = {
        number: doc.number, when: fmtInvoiceDate(doc.createdAt, doc.date), qtyTotal: doc.qtyTotal, subtotal: doc.subtotal, discount: doc.discount, tax: doc.tax, taxRate: doc.taxRate,
        total: doc.total, paid: doc.paid, balance: doc.balance, prev: doc.customerId && doc.prevBalance !== undefined && (doc.prevBalance !== 0 || doc.balance > 0) ? doc.prevBalance : null, after: doc.balanceAfter, customer: who ? [doc.customerName, doc.customerPhone].filter(Boolean).join(' · ') : '',
        mode: doc.paymentType === 'credit' ? 'Udhar' : (doc.paymentAccountId === 'cash' ? 'Cash' : doc.paymentAccountName) + (doc.paymentType === 'partial' ? ' + Udhar' : ''),
      };
    }
    m.totals.push(['Subtotal', doc.subtotal]);
    if (doc.discount) m.totals.push(['Discount', -doc.discount]);
    if (doc.tax) m.totals.push([`Tax (${doc.taxRate}%)`, doc.tax]);
    m.totals.push(['TOTAL', doc.total, true]);
    if (kind === 'sale' && doc.tendered > doc.paid) m.totals.push(['Cash tendered', doc.tendered]);
    m.totals.push(['Paid', doc.paid]);
    if (doc.change) m.totals.push(['Change', doc.change]);
    if (doc.balance) m.totals.push(['Balance due', doc.balance, true]);
    m.payment = doc.paid ? doc.paymentAccountName : 'Credit';
  } else if (kind === 'saleReturn' || kind === 'purchaseReturn') {
    m.info.push(['Against', doc.docNo], [kind === 'saleReturn' ? 'Customer' : 'Supplier', doc.partyName || '']);
    m.items = doc.items.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, amount: i.amount }));
    m.totals.push(['RETURN TOTAL', doc.total, true]);
    m.totals.push([kind === 'saleReturn' ? 'Refunded' : 'Refund received', doc.refund]);
    m.payment = doc.refund ? doc.refundAccountName : 'Adjusted to account';
  } else {
    const party = { receipt: 'Received from', payment: 'Paid to', transfer: 'To account' }[doc.type];
    m.title = TITLES[doc.type];
    m.info.push([party, doc.counterName], [doc.type === 'transfer' ? 'From account' : 'Account', doc.accountName]);
    if (doc.note) m.info.push(['Note', doc.note]);
    m.totals.push(['AMOUNT', doc.amount, true]);
  }
  if (doc.note && kind !== 'voucher') m.note = doc.note;
  return m;
}

// Async because Urdu/non-Latin lines are rendered with the Jameel Noori Nastaleeq web font.
async function invoiceEscPos(m, width) {
  await Raster.ensureFont();
  const p = new EscPos(width, Raster, { imageMode: getSettings().printer.imageMode });
  const cur = getSettings().currency; const v = m.invoice;
  const W = p.cols; const wQty = W > 40 ? 7 : 5; const wPrice = W > 40 ? 9 : 6; const wTot = W > 40 ? 12 : 9; const wName = W - wQty - wPrice - wTot;
  const cell = (s, w, right = true) => { s = String(s); return right ? s.padStart(w).slice(-w) : s.padEnd(w).slice(0, w); };
  const row = (name, q, pr, tot) => cell(name, wName, false) + cell(q, wQty) + cell(pr, wPrice) + cell(tot, wTot);
  p.align('center');
  m.header.forEach((h, i) => { if (i === 0) p.bold(true).size(true).wrap(h, Math.floor(W / 2)).size(false).bold(false); else p.wrap(h); });
  p.feed(1).bold(true).line('Invoice').bold(false).align('left');
  p.lr('Receipt# ' + v.number, '');
  p.line(v.when);
  if (v.customer) p.lr('Customer:', v.customer);
  p.hr().line(row('Name', 'Qty', 'Price', 'Total')).hr();
  m.items.forEach((i) => {
    const long = !isPlain(i.name) || i.name.length > wName - 1;
    if (long) { p.wrap(i.name); p.line(row('', fmtQty(i.qty), trim0(i.rate), trim0(i.amount))); } else p.line(row(i.name, fmtQty(i.qty), trim0(i.rate), trim0(i.amount)));
    if (i.discount) p.lr('  Discount', '-' + trim0(i.discount));
  });
  p.hr();
  p.lr(`Items: ${m.items.length}`, `Subtotal  ${cur}${fmtNum(v.subtotal)}`);
  p.line(`Total Qty: ${fmtTotalQty(v.qtyTotal)}`);
  if (v.discount) p.lr('Discount', `-${cur}${fmtNum(v.discount)}`);
  if (v.tax) p.lr(`Tax (${v.taxRate}%)`, `${cur}${fmtNum(v.tax)}`);
  p.hr().align('center').bold(true).size(true).wrap(`Grand Total ${cur}${fmtNum(v.total)}`, Math.floor(W / 2)).size(false).bold(false).align('left').hr();
  p.align('center').line(`Payment Mode: ${v.mode}`);
  if (v.prev !== null) {
    p.hr().align('left');
    p.lr(v.prev < 0 ? 'Previous Advance' : 'Previous Balance', `${cur}${fmtNum(Math.abs(v.prev))}`);
    p.lr('This Bill', `${cur}${fmtNum(v.total)}`);
    p.lr('Paid', `-${cur}${fmtNum(v.paid)}`);
    p.bold(true).lr(v.after < 0 ? 'Advance Left' : 'Total Credit', `${cur}${fmtNum(Math.abs(v.after))}`).bold(false);
  } else if (v.balance) { p.align('left').lr('Paid', `${cur}${fmtNum(v.paid)}`); p.bold(true).lr('Balance due', `${cur}${fmtNum(v.balance)}`).bold(false); }
  if (m.note) { p.align('left').wrap('Note: ' + m.note); }
  p.align('center').feed(1);
  if (m.footer) p.wrap(m.footer);
  p.line(`Powered by ${CONFIG.APP_NAME}`).feed(3).cut();
  return p.bytes();
}

export async function toEscPos(m, width = 58) {
  if (m.invoice) return invoiceEscPos(m, width);
  await Raster.ensureFont();
  const p = new EscPos(width, Raster, { imageMode: getSettings().printer.imageMode });
  const cur = getSettings().currency;
  p.align('center');
  m.header.forEach((h, i) => { if (i === 0) p.bold(true).size(true).wrap(h, Math.floor(p.cols / 2)).size(false).bold(false); else p.wrap(h); });
  p.hr().bold(true).line(m.title).bold(false);
  if (m.void) p.bold(true).line('*** VOID ***').bold(false);
  p.align('left');
  m.info.forEach(([k, v]) => p.lr(k + ':', String(v ?? '')));
  if (m.items.length) {
    p.hr();
    m.items.forEach((i) => {
      p.wrap(i.name);
      p.lr(`  ${fmtQty(i.qty)} ${i.unit || ''} x ${fmtNum(i.rate)}`, fmtNum(i.amount));
      if (i.discount) p.lr('  Discount', '-' + fmtNum(i.discount));
    });
  }
  p.hr();
  m.totals.forEach(([k, v, strong]) => { if (strong) p.bold(true); p.lr(k, `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`); if (strong) p.bold(false); });
  if (m.payment) p.lr('Payment', m.payment);
  if (m.note) { p.hr(); p.wrap('Note: ' + m.note); }
  p.hr().align('center');
  if (m.footer) p.wrap(m.footer);
  p.feed(3).cut();
  return p.bytes();
}

// Urdu/RTL text is wrapped so it uses Jameel Noori Nastaleeq and right-to-left layout.
const t = (s) => (isPlain(s) ? esc(s) : `<span class="ur" dir="auto">${esc(s)}</span>`);

function invoiceHTML(m, width) {
  const cur = esc(getSettings().currency); const v = m.invoice;
  const kv = (l, r, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${r}</td></tr>`;
  return `<div class="receipt w${Number(width) === 80 ? 80 : 58}">
    ${m.header.map((h, i) => `<div class="c ${i === 0 ? 'b big' : ''}">${t(h)}</div>`).join('')}
    <div class="c b" style="margin-top:6px">Invoice</div>
    <table><tr><td class="b">Receipt# ${esc(v.number)}</td></tr><tr><td>${esc(v.when)}</td></tr>${v.customer ? `<tr><td>Customer: ${t(v.customer)}</td></tr>` : ''}</table>
    <hr><table class="inv"><tr class="b"><td>Name</td><td class="r">Qty</td><td class="r">Price</td><td class="r">Total</td></tr></table><hr>
    <table class="inv">${m.items.map((i) => `<tr><td>${t(i.name)}</td><td class="r">${fmtQty(i.qty)}</td><td class="r">${trim0(i.rate)}</td><td class="r">${trim0(i.amount)}</td></tr>${i.discount ? `<tr><td colspan="3">&nbsp;&nbsp;Discount</td><td class="r">-${trim0(i.discount)}</td></tr>` : ''}`).join('')}</table>
    <hr><table>${kv(`Items: ${m.items.length}`, `<b>Subtotal ${cur}${fmtNum(v.subtotal)}</b>`)}${kv(`Total Qty: ${fmtTotalQty(v.qtyTotal)}`, '')}
    ${v.discount ? kv('Discount', `-${cur}${fmtNum(v.discount)}`) : ''}${v.tax ? kv(`Tax (${v.taxRate}%)`, `${cur}${fmtNum(v.tax)}`) : ''}</table>
    <hr><div class="c b big">Grand Total ${cur}${fmtNum(v.total)}</div><hr>
    <div class="c">Payment Mode: ${t(v.mode)}</div>
    ${v.prev !== null ? `<hr><table>${kv(v.prev < 0 ? 'Previous Advance' : 'Previous Balance', `${cur}${fmtNum(Math.abs(v.prev))}`)}${kv('This Bill', `${cur}${fmtNum(v.total)}`)}${kv('Paid', `-${cur}${fmtNum(v.paid)}`)}${kv(v.after < 0 ? 'Advance Left' : 'Total Credit', `${cur}${fmtNum(Math.abs(v.after))}`, 'b')}</table>`
      : v.balance ? `<table>${kv('Paid', `${cur}${fmtNum(v.paid)}`)}${kv('Balance due', `${cur}${fmtNum(v.balance)}`, 'b')}</table>` : ''}
    ${m.note ? `<div>Note: ${t(m.note)}</div>` : ''}
    <div class="c" style="margin-top:8px">${m.footer ? t(m.footer) : ''}</div><div class="c">Powered by ${esc(CONFIG.APP_NAME)}</div></div>`;
}

export function toHTML(m, width = 58) {
  if (m.invoice) return invoiceHTML(m, width);
  const cur = esc(getSettings().currency);
  const row = (l, r, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${r}</td></tr>`;
  return `<div class="receipt w${Number(width) === 80 ? 80 : 58}">
    ${m.header.map((h, i) => `<div class="c ${i === 0 ? 'b big' : ''}">${t(h)}</div>`).join('')}
    <hr><div class="c b">${esc(m.title)}</div>${m.void ? '<div class="c b">*** VOID ***</div>' : ''}
    <table>${m.info.map(([k, v]) => row(esc(k) + ':', t(v))).join('')}</table>
    ${m.items.length ? '<hr><table>' + m.items.map((i) => `<tr><td colspan="2">${t(i.name)}</td></tr>${row(`&nbsp;&nbsp;${fmtQty(i.qty)} ${esc(i.unit || '')} x ${fmtNum(i.rate)}`, fmtNum(i.amount))}${i.discount ? row('&nbsp;&nbsp;Discount', '-' + fmtNum(i.discount)) : ''}`).join('') + '</table>' : ''}
    <hr><table>${m.totals.map(([k, v, strong]) => row(esc(k), `${v < 0 ? '-' : ''}${cur} ${fmtNum(Math.abs(v))}`, strong ? 'b' : '')).join('')}
    ${m.payment ? row('Payment', t(m.payment)) : ''}</table>
    ${m.note ? `<hr><div>Note: ${t(m.note)}</div>` : ''}
    <hr>${m.footer ? `<div class="c">${t(m.footer)}</div>` : ''}</div>`;
}
