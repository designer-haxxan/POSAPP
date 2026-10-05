// Application bootstrap: service worker, database, authentication gate, navigation and routing.
import { CONFIG } from './config.js';
import { applyTheme } from './core/settings.js';
import * as UI from './core/ui.js';
import { esc } from './core/utils.js';
import { openDB } from './db/idb.js';
import * as Auth from './services/auth.js';
import * as Catalog from './services/catalog.js';

const $ = window.jQuery;

// Route table: name → [loader, title, permission|null]
const ROUTES = {
  sell: [() => import('./modules/sell.js'), 'Sales', null],
  cart: [() => import('./modules/checkout.js'), 'Checkout', 'sale.create'],
  receipt: [() => import('./modules/checkout.js'), 'Receipt', null],
  summary: [() => import('./modules/summary.js'), 'Reports', null],
  cashflow: [() => import('./modules/cashflow.js'), 'Cashflow', null],
  more: [() => import('./modules/more.js'), 'More', null],
  dashboard: [() => import('./modules/dashboard.js'), 'Business hub', null],
  pos: [() => import('./modules/pos.js'), 'Sell from products', 'sale.create'],
  sales: [() => import('./modules/documents.js'), 'Sales', null],
  purchase: [() => import('./modules/pos.js'), 'New Purchase', 'purchase.manage'],
  purchases: [() => import('./modules/documents.js'), 'Purchases', 'purchase.manage'],
  returns: [() => import('./modules/documents.js'), 'Returns', null],
  products: [() => import('./modules/products.js'), 'Products', null],
  stock: [() => import('./modules/stock.js'), 'Stock', null],
  customers: [() => import('./modules/parties.js'), 'Customers', null],
  suppliers: [() => import('./modules/parties.js'), 'Suppliers', 'purchase.manage'],
  vouchers: [() => import('./modules/vouchers.js'), 'Cash Book & Payments', 'voucher.create'],
  accounts: [() => import('./modules/accounts.js'), 'Payment Settings', 'account.manage'],
  reports: [() => import('./reports/reports.js'), 'Detailed Reports', 'reports.view'],
  backup: [() => import('./modules/backup.js'), 'Backup & Restore', 'backup.export'],
  settings: [() => import('./modules/settings.js'), 'Settings', null],
};
const DEFAULT_ROUTE = 'sell';
// Bottom-nav tabs get the purple tool bar; cart/receipt are full-screen; pos/purchase hide the bottom nav.
const TABS = new Set(['sell', 'summary', 'cashflow', 'more']);
const BARE_ROUTES = new Set(['cart', 'receipt']);
const FOCUS_ROUTES = new Set(['pos', 'purchase']);

let currentModule = null;
let routeToken = 0;
let deferredInstall = null;

function showView(name) {
  $('#splash').addClass('d-none');
  $('#view-login').toggleClass('d-none', name !== 'login');
  $('#view-app').toggleClass('d-none', name !== 'app');
}

function fatal(msg) {
  $('#splash-error').text(msg);
  $('#splash .spinner-border').addClass('d-none');
}

// ---------- Service worker & install ----------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  // New versions install and activate on their own (see service-worker.js); check whenever the app is opened.
  navigator.serviceWorker.register('service-worker.js').then((reg) => {
    const check = () => {
      if (!navigator.onLine) return;
      reg.update().catch(() => {});
      // Other apps on this origin can wipe our offline cache; ask the worker to rebuild it if needed.
      (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'ENSURE_CACHE' });
    };
    check();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 60 * 60 * 1000);
  }).catch((e) => console.warn('Service worker registration failed:', e));
  // Reload when an update replaces an existing worker, so the page never mixes files from two versions.
  // (The very first install only takes control; nothing to reload.)
  let controlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled && !reloading) { reloading = true; location.reload(); }
    controlled = true;
  });
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => { deferredInstall = null; UI.toast('App installed'); });
export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  return true;
}
export const canInstall = () => !!deferredInstall;

// ---------- Connection badge ----------
function renderConn(status) {
  const map = { online: ['wifi', 'Online'], offline: ['wifi-off', 'Offline'] };
  const [icon, label] = map[status] || map.offline;
  $('#conn-badge').attr('class', `badge rounded-pill conn-${status}`).html(`<i class="bi bi-${icon}"></i> <span>${label}</span>`);
  $('#login-conn').html(navigator.onLine ? '<i class="bi bi-wifi text-success"></i> Online' : '<i class="bi bi-wifi-off text-danger"></i> Offline — connect to the internet to sign in');
}
window.addEventListener('online', () => renderConn('online'));
window.addEventListener('offline', () => renderConn('offline'));

// ---------- Navigation ----------
function buildChrome() {
  $('#tb-support').attr('href', `https://wa.me/${String(CONFIG.SUPPORT_PHONE).replace(/\D/g, '').replace(/^0/, '92')}`);
}

function showHelp() {
  const steps = [
    ['calculator', 'Sales tab', 'Type the price (or <b>50@100</b> for price 50 × quantity 100) and tap <b>Add Item</b>. Tap <b>Cash In</b> when you are done.'],
    ['cash-stack', 'Take payment', 'Choose <b>Cash</b>, <b>Udhar</b> (credit to a customer) or <b>More</b> for bank, wallet and part payments.'],
    ['printer', 'Receipt', 'Print on a Bluetooth printer, or share the receipt by WhatsApp or SMS.'],
    ['bookmark', 'Save for later', 'Tap the bookmark or <b>Save For Later</b> to park a sale and continue it from the Saved tab.'],
    ['bar-chart-fill', 'Reports', 'See sales, profit, expenses, payment modes, tax and discounts for any day, week, month or year.'],
    ['arrow-left-right', 'Cashflow', 'Record other income and expenses, and open purchases.'],
  ];
  UI.modal({ title: 'How to use the app', size: 'md', body: steps.map(([i, t, d]) => `<div class="help-step"><i class="bi bi-${i}"></i><div><div class="fw-semibold">${t}</div><div class="small text-body-secondary">${d}</div></div></div>`).join('') });
}

async function route() {
  if (!Auth.user()) return;
  if (checkExpiry()) return;
  const token = ++routeToken;
  const parts = (location.hash.replace(/^#\/?/, '') || DEFAULT_ROUTE).split('/').map(decodeURIComponent);
  const name = ROUTES[parts[0]] ? parts[0] : DEFAULT_ROUTE;
  const [loader, title, perm] = ROUTES[name];
  try { currentModule?.destroy?.(); } catch (e) { console.warn(e); }
  currentModule = null;
  const tab = TABS.has(name);
  const bare = BARE_ROUTES.has(name);
  $('#bottom-nav a').removeClass('active');
  $(`#bottom-nav [data-tab="${tab ? name : 'more'}"]`).addClass('active');
  $('#topbar').toggleClass('d-none', !tab);
  $('#subbar').toggleClass('d-none', tab || bare);
  $('body').toggleClass('focus-mode', FOCUS_ROUTES.has(name) || bare).toggleClass('tab-screen', tab).toggleClass('bare-screen', bare);
  $('#topbar-title').text(title);
  const $c = $('#content').off();
  if (perm && !Auth.can(perm)) { $c.html(UI.emptyState('You do not have permission to open this page.', 'shield-lock')); return; }
  $c.html(UI.spinner());
  try {
    const mod = (await loader()).default;
    if (token !== routeToken) return;
    currentModule = mod;
    window.scrollTo(0, 0);
    $c.removeClass('page-enter');
    await mod.render($c[0], { route: name, params: parts.slice(1), setTitle: (t) => $('#topbar-title').text(t) });
    if (token === routeToken) { void $c[0].offsetWidth; $c.addClass('page-enter'); }
  } catch (e) {
    console.error(e);
    if (token === routeToken) $c.html(UI.errorState(e));
  }
}

// ---------- Auth gate ----------
async function startApp() {
  await Catalog.load();
  buildChrome();
  showView('app');
  renderConn(navigator.onLine ? 'online' : 'offline');
  clearInterval(expiryTimer);
  expiryTimer = setInterval(checkExpiry, 60000);
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist().catch(() => {}); });
  route();
}

async function doLogout(forced = false, reason = '') {
  if (!forced && !await UI.confirmDialog('Log out of this device? Your POS data stays on this device, but signing in again requires an internet connection.', { okLabel: 'Log out', okClass: 'btn-danger' })) return;
  clearInterval(expiryTimer);
  try { currentModule?.destroy?.(); } catch { /* ignore */ }
  currentModule = null;
  Auth.logout();
  $('#content').empty();
  showLogin(reason);
}

// Sessions are valid until expiresAt (set by the server); after that an online sign-in is required.
let expiryTimer = null;
function checkExpiry() {
  if (!Auth.sessionExpired()) return false;
  UI.toast('Your session has expired. Please sign in again.', 'warning', 6000);
  doLogout(true, 'Your session has expired. Connect to the internet and sign in again.');
  return true;
}

function showLogin(reason = '') {
  showView('login');
  renderConn(navigator.onLine ? 'online' : 'offline');
  const notices = [];
  if (reason) notices.push(esc(reason));
  $('#login-notice').toggleClass('d-none', !notices.length).html(notices.join('<br>'));
  setTimeout(() => $('#login-username').trigger('focus'), 50);
}

$('#login-form').on('submit', async (e) => {
  e.preventDefault();
  const $btn = $('#login-btn').prop('disabled', true).html('<span class="spinner-border spinner-border-sm"></span><span>Signing in…</span>');
  $('#login-error').addClass('d-none');
  try {
    await Auth.login($('#login-username').val(), $('#login-password').val());
    $('#login-password').val('');
    await startApp();
  } catch (err) {
    $('#login-error').text(err.message || String(err)).removeClass('d-none');
    $('.auth-card').removeClass('shake'); void $('.auth-card')[0].offsetWidth; $('.auth-card').addClass('shake');
  } finally { $btn.prop('disabled', false).html('<span>Sign in</span><i class="bi bi-arrow-right"></i>'); }
});
$('#toggle-pw').on('click', () => {
  const $i = $('#login-password'); const show = $i.attr('type') === 'password';
  $i.attr('type', show ? 'text' : 'password');
  $('#toggle-pw i').attr('class', show ? 'bi bi-eye-slash' : 'bi bi-eye');
});
$('#tb-help').on('click', showHelp);
$('#sub-back').on('click', () => { if (history.length > 1) history.back(); else location.hash = '#/more'; });
$('#topbar').on('click', '[data-go]', function () { location.hash = this.dataset.go; });
$('#tb-share').on('click', async () => {
  const url = location.href.split('#')[0];
  if (navigator.share) { try { await navigator.share({ title: CONFIG.APP_NAME, text: `${CONFIG.APP_NAME}: simple point of sale that works offline`, url }); } catch { /* cancelled */ } }
  else { try { await navigator.clipboard.writeText(url); UI.toast('App link copied'); } catch { UI.toast(url, 'info', 6000); } }
});
window.addEventListener('hashchange', route);
document.addEventListener('settings:changed', applyTheme);
document.addEventListener('app:logout', () => doLogout(false));
document.addEventListener('app:install', async () => { if (!await promptInstall()) UI.toast('Use your browser menu: Install app / Add to Home screen.', 'info', 5000); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ---------- Boot ----------
(async function boot() {
  applyTheme();
  registerSW();
  if (!window.jQuery || !window.bootstrap) return fatal('Required libraries failed to load. Connect to the internet once so the app can be cached for offline use.');
  try { await openDB(); } catch (e) { return fatal('Could not open the local database: ' + (e.message || e)); }
  const { user, reason } = Auth.restoreSession();
  if (user) {
    try { await startApp(); } catch (e) { console.error(e); fatal(e.message || String(e)); }
  } else showLogin(reason);
})();
