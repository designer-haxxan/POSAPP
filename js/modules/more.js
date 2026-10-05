// More tab: business profile, receipt/printer/calculator settings, shortcuts to the full-featured screens.
import { CONFIG } from '../config.js';
import * as UI from '../core/ui.js';
import { esc, fmtDateTime, num, AppError } from '../core/utils.js';
import { getSettings, saveSettings, pref } from '../core/settings.js';
import * as Auth from '../services/auth.js';
import * as Catalog from '../services/catalog.js';
import { supportLink } from './checkout.js';

const $ = window.jQuery;
let $root = null;

const chev = '<i class="bi bi-chevron-right chev"></i>';
const row = (inner, { href = '', act = '', ext = false } = {}) => (href
  ? `<a class="more-row" href="${href}" ${ext ? 'target="_blank" rel="noopener"' : ''}>${inner}</a>`
  : `<button class="more-row" data-act="${act}">${inner}</button>`);
const item = (label, right = chev, sub = '') => `<div class="min-w-0 flex-grow-1"><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right}`;
const val = (v) => `<span class="val">${v}</span>`;

function paint() {
  const s = getSettings(); const u = Auth.user();
  const exp = Auth.expiresAt();
  const manage = Auth.can('settings.manage');
  const products = Catalog.allProducts().filter((p) => p.active).length;
  $root.html(`<div class="more">
    <div class="plan-banner">
      <div class="shop-ic"><i class="bi bi-shop"></i></div>
      <div class="min-w-0"><div class="n text-truncate">${esc(s.business.name)}</div><div class="d">Signed in as ${esc(u.name)}${exp ? ` · valid until ${esc(new Date(exp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</div></div>
      <span class="plan-pill ${navigator.onLine ? '' : 'off'}"><i class="bi bi-${navigator.onLine ? 'wifi' : 'wifi-off'}"></i> ${navigator.onLine ? 'Online' : 'Offline'}</span>
    </div>
    <div class="more-list">
      ${row(item('Customer Help Chat Support 💁', '<i class="bi bi-headset ico"></i>'), { href: supportLink(), ext: true })}
      ${manage ? row(item(`Edit ${esc(s.business.name)}`), { act: 'business' }) : ''}
      ${row(item('Receipts'), { href: '#/sales' })}
      ${manage ? row(item('Receipt Prefix ID', val(esc(s.prefixes.sale))), { act: 'prefix' }) : ''}
      ${row(item('Manage Inventory', val(`${products} Items`)), { href: '#/products' })}
      ${row(item('Customers (Udhar)'), { href: '#/customers' })}
      ${Auth.can('purchase.manage') ? row(item('Suppliers'), { href: '#/suppliers' }) : ''}
      ${row(item('Stock'), { href: '#/stock' })}
      ${Auth.can('account.manage') ? row(item('Payment Settings'), { href: '#/accounts' }) : ''}
      ${Auth.can('voucher.create') ? row(item('Cash Book & Payments'), { href: '#/vouchers' }) : ''}
      ${row(item('Returns'), { href: '#/returns' })}
      ${Auth.can('reports.view') ? row(item('Detailed Reports'), { href: '#/reports' }) : ''}
      ${manage ? row(item('Receipt Settings'), { act: 'receipt' }) : ''}
      ${manage ? row(item('Calculator Settings'), { act: 'calc' }) : ''}
      ${row(item('Printer Setup', '<i class="bi bi-printer-fill ico"></i>'), { href: '#/settings' })}
      ${row(item('Edit User Profile', chev, `${esc(u.name)} | ${esc(u.username || '')}`), { act: 'profile' })}
      ${Auth.can('backup.export') ? row(item('Backup & Restore'), { href: '#/backup' }) : ''}
      ${row(item('Business hub'), { href: '#/dashboard' })}
      ${row(item('Sell from product list'), { href: '#/pos' })}
      ${row(item('All Settings'), { href: '#/settings' })}
      <div class="more-row switch-row"><div class="lbl">Enable App Vibration</div>
        <div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" id="vib" ${pref.get('vibrate', true) ? 'checked' : ''}></div></div>
      <div class="more-row switch-row"><div class="lbl">Sound after each sale</div>
        <div class="form-check form-switch m-0"><input class="form-check-input" type="checkbox" id="snd" ${pref.get('sound', true) ? 'checked' : ''}></div></div>
      <button class="more-row install d-none" data-act="install">${item('Install App', '<i class="bi bi-download ico"></i>')}</button>
      <button class="more-row logout" data-act="logout">${item('Log out', '<i class="bi bi-box-arrow-right ico"></i>')}</button>
    </div>
    <div class="more-foot">${esc(CONFIG.APP_NAME)} · v${esc(CONFIG.APP_VERSION)}</div>
  </div>`);
  if (window.matchMedia('(display-mode: standalone)').matches === false) $root.find('.install').removeClass('d-none');
}

const actions = {
  async business() {
    const s = getSettings();
    const r = await UI.formModal({
      title: 'Business profile',
      body: `<div class="row g-2">
        <div class="col-12"><label class="form-label">Business name</label><input name="name" class="form-control" maxlength="80" value="${esc(s.business.name)}"></div>
        <div class="col-12"><label class="form-label">Address</label><input name="address" class="form-control" maxlength="160" value="${esc(s.business.address)}"></div>
        <div class="col-6"><label class="form-label">Phone</label><input name="phone" type="tel" class="form-control" value="${esc(s.business.phone)}"></div>
        <div class="col-6"><label class="form-label">Tax / NTN no.</label><input name="taxNo" class="form-control" value="${esc(s.business.taxNo)}"></div>
        <div class="col-4"><label class="form-label">Currency</label><input name="currency" class="form-control" maxlength="5" value="${esc(s.currency)}"></div></div>`,
      onSubmit: (v) => { if (!v.name.trim()) throw new AppError('Business name is required.'); return v; },
    });
    if (r) { saveSettings({ business: { name: r.name.trim(), address: r.address.trim(), phone: r.phone.trim(), taxNo: r.taxNo.trim() }, currency: r.currency.trim() || 'Rs' }); paint(); }
  },
  async prefix() {
    const r = await UI.formModal({
      title: 'Receipt prefix ID',
      body: `<label class="form-label">Prefix</label><input name="p" class="form-control form-control-lg" maxlength="12" value="${esc(getSettings().prefixes.sale)}">
        <div class="form-text">Receipts are numbered like <b>PREFIX-000001</b>. Use a different prefix on each device if several devices sell at the same time.</div>`,
      onSubmit: (v) => { if (!/^[A-Za-z0-9]{1,12}$/.test(v.p.trim())) throw new AppError('Use 1–12 letters or digits.'); return v.p.trim(); },
    });
    if (r) { saveSettings({ prefixes: { sale: r } }); paint(); }
  },
  async receipt() {
    const s = getSettings();
    const r = await UI.formModal({
      title: 'Receipt settings',
      body: `<div class="row g-2">
        <div class="col-12"><label class="form-label">Message at the bottom</label><input name="footer" class="form-control" maxlength="120" value="${esc(s.business.footer)}"></div>
        <div class="col-6"><label class="form-label">Paper width</label><select name="width" class="form-select"><option value="58" ${s.printer.width == 58 ? 'selected' : ''}>58 mm</option><option value="80" ${s.printer.width == 80 ? 'selected' : ''}>80 mm</option></select></div>
        <div class="col-6"><label class="form-label">Copies</label><input name="copies" type="number" min="1" max="5" class="form-control" value="${s.printer.copies || 1}"></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="autoPrint" id="rs-ap" ${s.printer.autoPrint ? 'checked' : ''}><label class="form-check-label" for="rs-ap">Print automatically after each sale</label></div></div></div>`,
      onSubmit: (v) => v,
    });
    if (r) { saveSettings({ business: { footer: r.footer.trim() }, printer: { width: Number(r.width), copies: Math.max(1, Math.min(5, Math.round(num(r.copies, 1)))), autoPrint: !!r.autoPrint } }); UI.toast('Receipt settings saved'); }
  },
  async calc() {
    const s = getSettings();
    const r = await UI.formModal({
      title: 'Calculator settings',
      body: `<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="taxEnabled" id="cs-tax" ${s.taxEnabled ? 'checked' : ''}><label class="form-check-label" for="cs-tax">Add tax to every sale automatically</label></div>
        <label class="form-label">Default tax rate (%)</label><input name="taxRate" class="form-control mb-3" inputmode="decimal" value="${s.taxRate}">
        <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="allowNegativeStock" id="cs-neg" ${s.allowNegativeStock ? 'checked' : ''}><label class="form-check-label" for="cs-neg">Allow selling products when stock is short</label></div>
        <div class="form-text">Tip: type <b>10@120</b> on the keypad for quantity 10 at price 120.</div>`,
      onSubmit: (v) => { const n = num(v.taxRate); if (n < 0 || n > 100) throw new AppError('Tax rate must be between 0 and 100.'); return { taxEnabled: !!v.taxEnabled, taxRate: n, allowNegativeStock: !!v.allowNegativeStock }; },
    });
    if (r) { saveSettings(r); UI.toast('Calculator settings saved'); }
  },
  profile() {
    const u = Auth.user(); const exp = Auth.expiresAt();
    const m = UI.modal({
      title: 'User profile', size: 'sm', fullscreenMobile: false, scrollable: false,
      body: `<dl class="row mb-0 small"><dt class="col-5">Name</dt><dd class="col-7">${esc(u.name)}</dd><dt class="col-5">Username</dt><dd class="col-7">${esc(u.username || '')}</dd>
        <dt class="col-5">Role</dt><dd class="col-7">${esc(Auth.ROLES[u.role] || u.role)}</dd>${exp ? `<dt class="col-5">Session until</dt><dd class="col-7">${esc(fmtDateTime(new Date(exp).toISOString()))}</dd>` : ''}
        <dt class="col-5">Device ID</dt><dd class="col-7 text-break">${esc(Auth.deviceId())}</dd></dl>
        <div class="alert alert-secondary small mt-3 mb-0">Password, device changes and account status are managed by support (${esc(CONFIG.SUPPORT_PHONE)}).</div>`,
    });
    void m;
  },
  logout() { document.dispatchEvent(new CustomEvent('app:logout')); },
  install() { document.dispatchEvent(new CustomEvent('app:install')); },
};

export default {
  async render(el) {
    this.destroy();
    $root = $(el);
    paint();
    $root.on('click', '[data-act]', function () { actions[this.dataset.act]?.(); });
    $root.on('change', '#vib', function () { pref.set('vibrate', this.checked); if (this.checked && navigator.vibrate) navigator.vibrate(40); });
    $root.on('change', '#snd', function () { pref.set('sound', this.checked); });
  },
  destroy() { $root?.off(); $root = null; },
};
