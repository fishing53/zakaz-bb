import { appShell } from './components/app-shell';
import { productModal, relatedCards } from './components/product-modal';
import { serviceSheet } from './components/service-sheet';
import { upsellSheet } from './components/upsell-sheet';
import { menuService, setCatalog } from './services/menu-service';
import { apiService } from './services/api-service';
import { orderService } from './services/order-service';
import { waiterService } from './services/waiter-service';
import { orderStore } from './store/order-store';
import { appStore } from './store/app-store';
import { router } from './router/router';
import { menuPage, menuResults } from './pages/menu';
import { orderPage } from './pages/order';
import { ordersPage } from './pages/orders';
import { statusPage } from './pages/status';
import { welcomePage } from './pages/welcome';
import { tablePage } from './pages/table';
import { adminPage, type AdminUpdateState } from './pages/admin';
import { debounce, formatPrice } from './utils/helpers';
import { applyLanguage } from './services/i18n';
import { otaService } from './services/ota-service';
import { imageCacheService, type ImageCacheState } from './services/image-cache-service';
import type { AdminDiagnostics, AdminOrder, AdminPromotion, Banner, IikoConnectionConfig, IikoConnectionDiscovery, IikoConnectionSelection, IikoDiscountOption, IikoRestaurantOptions, Product } from './types/menu';
import type { AdminUserProfile, WaiterProfile } from './services/api-service';
import brand from './config/brand.json';

const root = document.querySelector<HTMLDivElement>('#app')!;
let inactivityTimer = 0;
let inactivityCountdown = 0;
let adminTaps = 0;
let lastAdminTap = 0;
let submittingOrder = false;
let bannerSwipeStart: { x: number; y: number } | null = null;
let bannerRotationTimer = 0;
let currentBannerId = '';
let suppressBannerOpenUntil = 0;
let statusRefreshTimer = 0;
let auditLog: Array<{ action: string; entity: string; entity_id: string; created_at: string }> = [];
let waiterProfiles: WaiterProfile[] = [];
let adminUserProfiles: AdminUserProfile[] = [];
let adminBanners: Banner[] = [];
let adminPromotions: AdminPromotion[] = [];
let adminIikoDiscounts: IikoDiscountOption[] = [];
let adminOrders: AdminOrder[] = [];
let adminDiagnostics: AdminDiagnostics | null = null;
let iikoConfigAccessToken = '';
let adminIikoConfig: IikoConnectionConfig | null = null;
let iikoConfigTestToken = '';
let iikoConfigLockTimer = 0;
let iikoDiscovery: IikoConnectionDiscovery | null = null;
let iikoRestaurantOptions: IikoRestaurantOptions | null = null;
let iikoSelectedOrganizationId = '';
let adminOrderFilter: 'active' | 'all' = 'active';
let adminOrderRefreshTimer = 0;
let adminUpdateState: AdminUpdateState = { phase: 'idle', currentVersion: otaService.bundledVersion, latestVersion: null, progress: 0, browser: false };
let adminImageCacheState: ImageCacheState = imageCacheService.state([]);
let lastAutomaticImageSync = 0;
const updateSearch = debounce((value: string) => {
  const searching = Boolean(value.trim());
  appStore.set({ search: value, ...(searching ? { category: 'Все блюда' } : {}) }, false);
  if (searching) {
    root.querySelectorAll<HTMLElement>('.category-nav button').forEach((button) => button.classList.toggle('is-active', button.dataset.category === 'Все блюда'));
  }
  refreshMenuResults();
}, 180);
const updateComment = debounce((value: string) => appStore.set({ comment: value, pendingOrderRequestId: null }, false), 180);

function page() {
  const state = appStore.get();
  const route = router.current();
  switch (route) {
    case 'welcome': return welcomePage(state.banners, state.terminal);
    case 'table': return tablePage(state.tables);
    case 'menu': return menuPage(menuService.categories(), menuService.search(state.search, state.category), state.category, state.search, menuService.recent(state.recentProductIds), state.productDisplay, menuService.ready());
    case 'order': return orderPage(orderStore.lines(), orderStore.product, orderStore.subtotal(), orderStore.discount(), orderStore.total(), state.comment, state.promoCode, state.promoRule);
    case 'orders': return ordersPage(state.orders);
    case 'status': {
      const order = state.orders.find((item) => item.id === state.selectedOrderId);
      return statusPage(order, order?.id ?? state.orderNumber, order?.statusStep ?? state.statusStep, orderStore.product);
    }
    case 'admin': return state.adminAuthenticated ? adminPage(menuService.all(), adminBanners, state.productDisplay, state.terminal, state.adminTab, state.adminProductId, auditLog, state.adminScope, state.adminRole, waiterProfiles, adminUserProfiles, adminOrders, adminOrderFilter, adminDiagnostics, adminIikoConfig, iikoDiscovery, iikoRestaurantOptions, iikoSelectedOrganizationId, adminPromotions, adminIikoDiscounts, adminUpdateState, state.tables, adminImageCacheState) : '';
  }
}

const adminLogin = (open: boolean, scope: 'terminal' | 'restaurant' = 'terminal') => open ? `<div class="overlay admin-login-overlay"><section class="admin-login"><button class="modal__close" data-action="close-admin-login">${iconMarkup('close')}</button><span class="eyebrow">${scope === 'terminal' ? 'СЕРВИСНЫЙ ВХОД' : 'АДМИНИСТРИРОВАНИЕ РЕСТОРАНА'}</span><h2>Вход</h2><p>${scope === 'terminal' ? 'Настройки этого планшета.' : 'Введите персональный логин или используйте главный пароль.'}</p>${scope === 'restaurant' ? '<input data-admin-username placeholder="Логин сотрудника (необязательно)" autocomplete="username">' : ''}<input type="password" data-admin-password placeholder="Пароль" autocomplete="current-password"><button class="button button--primary button--wide" data-action="login-admin" data-admin-scope="${scope}">Войти</button></section></div>` : '';
const inactivityPrompt = (open: boolean, seconds: number) => open ? `<div class="overlay inactivity-overlay"><section class="inactivity-dialog">
  <img class="inactivity-dialog__character" src="/images/inactivity-character.png" alt="" aria-hidden="true">
  <div class="inactivity-dialog__glow"></div><div class="inactivity-dialog__brand"><img src="${brand.logo}" alt="Brooklyn Bowl"></div>
  <div class="inactivity-dialog__timer"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="53"></circle><circle class="inactivity-dialog__progress" cx="60" cy="60" r="53"></circle></svg><strong data-inactivity-countdown>${seconds}</strong><small>СЕК</small></div>
  <span class="eyebrow">ВАШ ЗАКАЗ ПРИОСТАНОВЛЕН</span><h2>Вы ещё здесь?</h2><p>Продолжите оформление или заказ автоматически очистится для следующего гостя.</p>
  <div class="inactivity-dialog__actions"><button class="button button--primary button--wide" data-action="continue-order">Да, продолжить заказ</button><button class="button button--secondary button--wide inactivity-dialog__cancel" data-action="cancel-order">Завершить и очистить</button></div>
</section></div>` : '';
const iconMarkup = (name: string) => name === 'close' ? '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>' : '';

export function render() {
  const state = appStore.get();
  const route = router.current();
  if (route === 'admin' && !state.adminAuthenticated) { root.innerHTML = adminLogin(true, 'restaurant'); return; }
  if (route === 'status' && !state.selectedOrderId && !state.orderNumber) { router.go('orders'); return; }
  root.innerHTML = appShell(page(), route) + serviceSheet(state.serviceOpen) + productModal(state.productId ? menuService.find(state.productId) : undefined, state.productId ? state.productDisplay[state.productId] : undefined, state.productDisplay) + upsellSheet(state.upsellId ? menuService.find(state.upsellId) : undefined) + adminLogin(state.adminLoginOpen, 'terminal') + inactivityPrompt(state.inactivityWarning, state.inactivitySeconds) + (!state.isOnline ? '<div class="network-banner">Нет сети. Доступны ранее загруженные данные.</div>' : '') + (state.pwaUpdateReady ? '<button class="pwa-update" data-action="refresh-app">Доступно обновление. Обновить</button>' : '') + (state.toast ? `<div class="toast">${state.toast}</div>` : '');
  const product = state.productId ? menuService.find(state.productId) : undefined;
  const related = root.querySelector<HTMLElement>('[data-related-for]');
  if (product && related) related.innerHTML = relatedCards(menuService.related(product), state.productDisplay);
  applyLanguage(root, state.language);
  if (route === 'welcome') setupWelcomeBanners();
  else {
    if (bannerRotationTimer) { clearInterval(bannerRotationTimer); bannerRotationTimer = 0; }
    currentBannerId = '';
  }
  resetInactivity();
  if (route === 'status' && !statusRefreshTimer) statusRefreshTimer = window.setInterval(() => { void syncServer(); }, 15_000);
  if (route !== 'status' && statusRefreshTimer) { clearInterval(statusRefreshTimer); statusRefreshTimer = 0; }
  if (route === 'admin' && state.adminTab === 'orders' && !adminOrderRefreshTimer) adminOrderRefreshTimer = window.setInterval(() => { void loadAdminOrders(); }, 15_000);
  if ((route !== 'admin' || state.adminTab !== 'orders') && adminOrderRefreshTimer) { clearInterval(adminOrderRefreshTimer); adminOrderRefreshTimer = 0; }
}

async function loadAdminOrders(notify = true) {
  try {
    adminOrders = await apiService.adminOrders(adminOrderFilter);
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить заказы'); }
}

async function loadTerminalTables() {
  try {
    const tables = await apiService.tables();
    appStore.set({ tables });
  } catch (error) {
    flash(error instanceof Error ? error.message : 'Не удалось получить столы из iiko');
  }
}

async function loadAdminDiagnostics(notify = true) {
  try {
    adminDiagnostics = await apiService.diagnostics();
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось проверить систему'); }
}

async function loadAdminPromotions(notify = true, refresh = false) {
  try {
    const data = await apiService.promotions(refresh);
    adminPromotions = data.promotions;
    adminIikoDiscounts = data.iikoDiscounts;
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить промокоды'); }
}

function readIikoConnectionSelection(): IikoConnectionSelection {
  const value = (name: string) => root.querySelector<HTMLSelectElement>(`[data-iiko-selection="${name}"]`)?.value ?? '';
  return { discoveryToken: iikoDiscovery?.discoveryToken ?? '', organizationId: iikoSelectedOrganizationId, terminalGroupId: value('terminalGroupId'), externalMenuId: value('externalMenuId') };
}

async function loadIikoRestaurantOptions(organizationId: string) {
  if (!iikoDiscovery) return;
  if (!organizationId) { iikoSelectedOrganizationId = ''; iikoRestaurantOptions = null; iikoConfigTestToken = ''; render(); return; }
  iikoSelectedOrganizationId = organizationId; iikoRestaurantOptions = null; iikoConfigTestToken = ''; render();
  try { iikoRestaurantOptions = await apiService.iikoRestaurantOptions(iikoConfigAccessToken, iikoDiscovery.discoveryToken, organizationId); render(); }
  catch (error) { flash(error instanceof Error ? error.message : 'Не удалось получить параметры ресторана'); }
}

function updateModalTotal() {
  const product = menuService.find(appStore.get().productId ?? '');
  if (!product) return;
  const saucePrice = Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0;
  const sauceItems = [...root.querySelectorAll<HTMLElement>('.option-group[data-option-group="Соусы"] button.is-selected')];
  const iikoItems = [...root.querySelectorAll<HTMLElement>('[data-iiko-modifier="true"].is-selected')];
  const sauceCount = sauceItems.length;
  const relatedItems = [...root.querySelectorAll<HTMLElement>('.related-choice.is-selected')];
  const selectedOptions = [...root.querySelectorAll<HTMLElement>('.option-group[data-multiple="false"] button.is-selected')]
    .map((item) => `${item.dataset.option}: ${item.dataset.value}`);
  const relatedTotal = relatedItems.reduce((sum, item) => sum + Number(item.dataset.price ?? 0), 0);
  const quantity = Number(root.querySelector<HTMLElement>('[data-modal-quantity]')?.textContent ?? 1);
  const sauceTotal = sauceCount * saucePrice;
  const iikoTotal = iikoItems.reduce((sum, item) => sum + Number(item.dataset.price ?? 0), 0);
  const allergenLabel = root.querySelector<HTMLElement>('[data-product-allergens]');
  if (allergenLabel) {
    const allergens = [allergenLabel.dataset.baseAllergens ?? '', ...iikoItems.map((item) => item.dataset.allergens ?? '')]
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    const uniqueAllergens = [...new Map(allergens.map((value) => [value.toLocaleLowerCase('ru-RU'), value])).values()];
    allergenLabel.textContent = uniqueAllergens.length ? uniqueAllergens.join(', ') : 'Уточняйте у официанта.';
  }
  const total = root.querySelector<HTMLElement>('[data-modal-total]');
  if (total) total.textContent = formatPrice((product.price_rub + sauceTotal + iikoTotal) * quantity + relatedTotal);
  const setText = (selector: string, value: string | number) => {
    const target = root.querySelector<HTMLElement>(selector);
    if (target) target.textContent = String(value);
  };
  setText('[data-sauce-count]', sauceCount);
  setText('[data-modal-quantity-label]', quantity);
  setText('[data-summary-main]', formatPrice(product.price_rub * quantity));
  setText('[data-summary-sauces-count]', sauceCount);
  setText('[data-summary-sauces-label]', sauceItems.map((item) => item.dataset.value).join(', '));
  setText('[data-summary-sauces]', formatPrice(sauceTotal));
  setText('[data-summary-related-count]', relatedItems.length);
  setText('[data-summary-related-label]', relatedItems.map((item) => item.dataset.productName).join(', '));
  setText('[data-summary-related]', formatPrice(relatedTotal));
  setText('[data-summary-options-label]', [...selectedOptions, ...iikoItems.map((item) => item.dataset.value ?? '')].join(' · '));
  root.querySelector<HTMLElement>('[data-summary-options-row]')?.toggleAttribute('hidden', selectedOptions.length + iikoItems.length === 0);
  root.querySelector<HTMLElement>('[data-summary-sauces-row]')?.toggleAttribute('hidden', sauceCount === 0);
  root.querySelector<HTMLElement>('[data-summary-related-row]')?.toggleAttribute('hidden', relatedItems.length === 0);
}

function updateOrderTotals(lineElement: HTMLElement) {
  const line = orderStore.lines().find((item) => item.key === lineElement.dataset.key);
  const product = line ? orderStore.product(line) : undefined;
  if (line && product) {
    const quantity = lineElement.querySelector<HTMLElement>('[data-line-quantity]');
    const lineTotal = lineElement.querySelector<HTMLElement>('[data-line-total]');
    if (quantity) quantity.textContent = String(line.quantity);
    if (lineTotal) lineTotal.textContent = formatPrice((line.customPrice ?? product.price_rub) * line.quantity);
    root.querySelectorAll<HTMLElement>(`[data-parent-key="${CSS.escape(line.key)}"]`).forEach((modifierLine) => {
      const modifier = line.modifiers?.find((item) => item.productId === modifierLine.dataset.modifierId);
      if (!modifier) return;
      const modifierQuantity = modifier.amount * line.quantity;
      const quantityLabel = modifierLine.querySelector<HTMLElement>('[data-modifier-quantity]');
      const modifierTotal = modifierLine.querySelector<HTMLElement>('[data-modifier-total]');
      if (quantityLabel) quantityLabel.textContent = `×${modifierQuantity}`;
      if (modifierTotal) modifierTotal.textContent = formatPrice(modifier.price * modifierQuantity);
    });
  }
  const subtotal = orderStore.subtotal();
  const discount = orderStore.discount();
  const total = orderStore.total();
  const setText = (selector: string, value: string) => root.querySelectorAll<HTMLElement>(selector).forEach((item) => { item.textContent = value; });
  setText('[data-order-subtotal]', formatPrice(subtotal));
  setText('[data-order-discount]', discount ? `−${formatPrice(discount)}` : '0 ₽');
  setText('[data-order-total]', formatPrice(total));
  const count = orderStore.count();
  root.querySelectorAll<HTMLElement>('[data-order-count]').forEach((item) => { item.textContent = String(count); });
}

function flash(message: string) {
  appStore.set({ toast: message });
  window.setTimeout(() => { if (appStore.get().toast === message) appStore.set({ toast: null }); }, 2600);
}

function selectBanner(index: number) {
  const banners = [...root.querySelectorAll<HTMLElement>('.welcome-banner')];
  if (!banners.length) return;
  const next = ((index % banners.length) + banners.length) % banners.length;
  banners.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === next));
  root.querySelectorAll<HTMLElement>('.welcome-banner-dots button').forEach((dot, itemIndex) => dot.classList.toggle('is-active', itemIndex === next));
  const id = banners[next].dataset.bannerId ?? '';
  if (id && id !== currentBannerId) {
    currentBannerId = id;
    void apiService.recordBannerImpression(id).then((result) => { if (result.exhausted) void syncServer(); }).catch(() => undefined);
  }
}

function setupWelcomeBanners() {
  const banners = [...root.querySelectorAll<HTMLElement>('.welcome-banner')];
  if (!banners.length) return;
  const preservedIndex = Math.max(0, banners.findIndex((item) => item.dataset.bannerId === currentBannerId));
  selectBanner(preservedIndex);
  if (bannerRotationTimer) clearInterval(bannerRotationTimer);
  bannerRotationTimer = banners.length > 1 ? window.setInterval(() => {
    const current = [...root.querySelectorAll<HTMLElement>('.welcome-banner')].findIndex((item) => item.classList.contains('is-active'));
    selectBanner((current < 0 ? 0 : current) + 1);
  }, 8_000) : 0;
}

function transientToast(message: string) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  root.append(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

async function loadCurrentAppVersion(notify = true) {
  try {
    const result = await otaService.current();
    adminUpdateState = { ...adminUpdateState, currentVersion: result.currentVersion, browser: result.platform === 'browser' };
    if (notify && router.current() === 'admin') render();
  } catch {
    // The embedded build version remains a safe fallback when the native plugin
    // is unavailable during startup.
  }
}

function updateDownloadProgress(percent: number) {
  adminUpdateState = { ...adminUpdateState, phase: 'downloading', progress: percent };
  const status = root.querySelector<HTMLElement>('[data-ota-status]');
  const bar = root.querySelector<HTMLElement>('[data-ota-progress]');
  const button = root.querySelector<HTMLButtonElement>('[data-ota-button]');
  if (status) status.textContent = `Загружаем обновление — ${percent}%`;
  if (bar) bar.style.width = `${percent}%`;
  if (button) button.textContent = `Загрузка ${percent}%`;
}

function imageSources(products = menuService.all(), banners = appStore.get().banners) {
  const sources = [
    ...products.flatMap((product) => [product.imageSource ?? product.image, ...(product.modifier_groups ?? []).flatMap((group) => group.items.map((item) => item.imageSource ?? item.image ?? ''))]),
    ...banners.map((banner) => banner.imageSource ?? banner.image),
  ];
  return [...new Set(sources.filter((source) => /^https?:\/\//i.test(source)))];
}

function imageCacheMessage(state: ImageCacheState) {
  if (state.phase === 'scanning') return 'Проверяем изображения…';
  if (state.phase === 'downloading') return `Загружаем: ${state.cached} из ${state.total}`;
  if (state.phase === 'clearing') return 'Очищаем хранилище…';
  if (state.phase === 'error') return `Загрузка завершена с ошибками: ${state.failed}`;
  if (state.total && state.cached === state.total) return 'Все изображения доступны на планшете';
  return `Ожидают загрузки: ${Math.max(0, state.total - state.cached)}`;
}

function paintImageCacheState(state: ImageCacheState) {
  const percent = state.total ? Math.round(state.cached / state.total * 100) : 0;
  const status = root.querySelector<HTMLElement>('[data-image-cache-status]');
  const progress = root.querySelector<HTMLElement>('[data-image-cache-progress]');
  const label = root.querySelector<HTMLElement>('[data-image-cache-percent]');
  if (status) status.textContent = imageCacheMessage(state);
  if (progress) progress.style.width = `${percent}%`;
  if (label) label.textContent = `${percent}%`;
}

function applyCachedImageUrls(notify: boolean) {
  const products = menuService.all().map((product) => ({
    ...product,
    image: imageCacheService.resolve(product.imageSource ?? product.image),
    modifier_groups: (product.modifier_groups ?? []).map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, image: imageCacheService.resolve(item.imageSource ?? item.image ?? '/images/sauce-fallback.webp') })) })),
  }));
  setCatalog(products);
  const banners = appStore.get().banners.map((banner) => ({ ...banner, image: imageCacheService.resolve(banner.imageSource ?? banner.image) }));
  appStore.set({ banners }, notify);
}

async function runImageCacheSync(force: boolean, notify = true) {
  const sources = imageSources();
  if (!sources.length || imageCacheService.isRunning()) return;
  adminImageCacheState = { ...imageCacheService.state(sources), phase: 'scanning' };
  if (notify && router.current() === 'admin') render();
  const result = await imageCacheService.sync(sources, {
    force,
    onState: (state) => { adminImageCacheState = state; paintImageCacheState(state); },
  });
  adminImageCacheState = result;
  applyCachedImageUrls(notify);
}

async function action(element: HTMLElement) {
  const type = element.dataset.action;
  if (!type) return;
  if (type === 'navigate') { router.go(element.dataset.route as never); return; }
  if (type === 'start-order') {
    const terminal = appStore.get().terminal;
    if (terminal?.tableNumber) { router.go('menu'); return; }
    try {
      const tables = await apiService.tables();
      appStore.set({ tables });
      router.go('table');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось загрузить столы'); }
    return;
  }
  if (type === 'select-table') {
    const tableId = element.dataset.tableId;
    if (!tableId) return;
    element.setAttribute('disabled', '');
    try {
      await apiService.selectTable(tableId);
      await syncServer();
      router.go('menu');
    } catch (error) { element.removeAttribute('disabled'); flash(error instanceof Error ? error.message : 'Не удалось выбрать стол'); }
    return;
  }
  if (type === 'admin-tap') {
    const now = Date.now();
    adminTaps = now - lastAdminTap < 1800 ? adminTaps + 1 : 1;
    lastAdminTap = now;
    if (adminTaps >= 6) { adminTaps = 0; appStore.set({ adminLoginOpen: true }); }
    return;
  }
  if (type === 'close-admin-login') { appStore.set({ adminLoginOpen: false }); return; }
  if (type === 'login-admin') {
    const password = root.querySelector<HTMLInputElement>('[data-admin-password]')?.value ?? '';
    const username = root.querySelector<HTMLInputElement>('[data-admin-username]')?.value.trim() ?? '';
    try {
      const scope = (element.dataset.adminScope as 'terminal' | 'restaurant') ?? 'terminal';
      const authenticated = await apiService.login(password, scope, username);
      await syncServer(authenticated.role === 'administrator');
      appStore.set({ adminAuthenticated: true, adminLoginOpen: false, adminScope: authenticated.scope, adminRole: authenticated.role, adminTab: authenticated.scope === 'terminal' ? 'terminal' : 'orders' });
      router.go('admin');
      if (authenticated.scope === 'restaurant') void loadAdminOrders();
      if (authenticated.scope === 'terminal') void loadTerminalTables();
    } catch (error) { flash(error instanceof Error ? error.message : 'Неверный пароль'); }
    return;
  }
  if (type === 'logout-admin') { apiService.logout(); clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; appStore.set({ adminAuthenticated: false, adminScope: null, adminRole: null, adminTab: 'terminal' }); router.go('welcome'); return; }
  if (type === 'select-admin-tab') {
    const adminTab = element.dataset.adminTab as 'terminal' | 'orders' | 'menu' | 'banners' | 'promotions' | 'staff' | 'quality' | 'audit';
    appStore.set({ adminTab });
    if (adminTab === 'audit') apiService.audit().then((items) => { auditLog = items; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'staff') Promise.all([apiService.waiters(), apiService.adminUsers()]).then(([waiters, users]) => { waiterProfiles = waiters; adminUserProfiles = users; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'banners') apiService.banners().then((items) => { adminBanners = items; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'promotions') void loadAdminPromotions();
    if (adminTab === 'orders') void loadAdminOrders();
    if (adminTab === 'quality') void loadAdminDiagnostics();
    if (adminTab === 'terminal') void loadTerminalTables();
    else { clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; }
    return;
  }
  if (type === 'set-admin-order-filter') { adminOrderFilter = element.dataset.orderFilter === 'all' ? 'all' : 'active'; await loadAdminOrders(); return; }
  if (type === 'refresh-admin-orders') { await loadAdminOrders(); flash('Заказы обновлены'); return; }
  if (type === 'refresh-admin-diagnostics') { await loadAdminDiagnostics(); flash('Проверка обновлена'); return; }
  if (type === 'refresh-promotions') { await loadAdminPromotions(true, true); flash('Скидки iiko обновлены'); return; }
  if (type === 'unlock-iiko-config') {
    const password = root.querySelector<HTMLInputElement>('[data-iiko-config-password]')?.value ?? '';
    try {
      const access = await apiService.unlockIikoConfig(password); iikoConfigAccessToken = access.token;
      adminIikoConfig = await apiService.iikoConfig(access.token); iikoConfigTestToken = ''; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; render();
      clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = window.setTimeout(() => { iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; if (router.current() === 'admin' && appStore.get().adminTab === 'quality') render(); }, access.expiresIn * 1000);
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось открыть настройки iiko'); }
    return;
  }
  if (type === 'discover-iiko-config') {
    const button = element as HTMLButtonElement; const resultBox = root.querySelector<HTMLElement>('[data-iiko-test-result]');
    const value = (name: string) => root.querySelector<HTMLInputElement>(`[data-iiko-credential="${name}"]`)?.value.trim() ?? '';
    try {
      button.disabled = true; if (resultBox) { resultBox.dataset.state = 'loading'; resultBox.textContent = 'Проверяем ключи и получаем доступные рестораны…'; }
      iikoDiscovery = await apiService.discoverIiko(iikoConfigAccessToken, { appId: value('appId'), apiLogin: value('apiLogin'), clientSecret: value('clientSecret') });
      iikoRestaurantOptions = null; iikoSelectedOrganizationId = iikoDiscovery.recommendedOrganizationId; iikoConfigTestToken = '';
      const autoOrganization = iikoSelectedOrganizationId || (iikoDiscovery.organizations.length === 1 ? iikoDiscovery.organizations[0].id : '');
      if (autoOrganization) await loadIikoRestaurantOptions(autoOrganization); else render();
    } catch (error) { iikoDiscovery = null; if (resultBox) { resultBox.dataset.state = 'error'; resultBox.textContent = error instanceof Error ? error.message : 'Не удалось получить рестораны'; } }
    finally { button.disabled = false; }
    return;
  }
  if (type === 'restart-iiko-discovery') { iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; iikoConfigTestToken = ''; render(); return; }
  if (type === 'test-iiko-config') {
    const button = element as HTMLButtonElement; const resultBox = root.querySelector<HTMLElement>('[data-iiko-test-result]');
    try {
      button.disabled = true; if (resultBox) { resultBox.dataset.state = 'loading'; resultBox.textContent = 'Проверяем авторизацию, меню, столы, тип заказа и стоп-лист…'; }
      const checked = await apiService.testIikoConfig(iikoConfigAccessToken, readIikoConnectionSelection()); iikoConfigTestToken = checked.testToken;
      if (resultBox) { resultBox.dataset.state = 'success'; resultBox.textContent = `${checked.result.organizationName}: ${checked.result.menuItems} блюд, ${checked.result.tables} столов, ответ ${checked.result.responseMs} мс. Конфигурацию можно применить.`; }
      const applyButton = root.querySelector<HTMLButtonElement>('[data-action="apply-iiko-config"]'); if (applyButton) applyButton.disabled = false;
    } catch (error) { iikoConfigTestToken = ''; if (resultBox) { resultBox.dataset.state = 'error'; resultBox.textContent = error instanceof Error ? error.message : 'Проверка iiko не пройдена'; } }
    finally { button.disabled = false; }
    return;
  }
  if (type === 'apply-iiko-config') {
    const button = element as HTMLButtonElement; const resultBox = root.querySelector<HTMLElement>('[data-iiko-test-result]');
    try {
      button.disabled = true; if (resultBox) { resultBox.dataset.state = 'loading'; resultBox.textContent = 'Применяем настройки и обновляем меню, столы и стоп-лист…'; }
      const applied = await apiService.applyIikoConfig(iikoConfigAccessToken, readIikoConnectionSelection(), iikoConfigTestToken);
      clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = '';
      await loadAdminDiagnostics(false); await syncServer(true); flash(`iiko подключена: ${applied.sync.menuItems} блюд, ${applied.sync.tables} столов, webhook активен`);
    } catch (error) { button.disabled = false; if (resultBox) { resultBox.dataset.state = 'error'; resultBox.textContent = error instanceof Error ? error.message : 'Не удалось применить настройки'; } }
    return;
  }
  if (type === 'create-waiter') { try { const name = root.querySelector<HTMLInputElement>('[data-admin-waiter="name"]')?.value.trim() ?? ''; const pin = root.querySelector<HTMLInputElement>('[data-admin-waiter="pin"]')?.value ?? ''; await apiService.createWaiter({ name, pin }); waiterProfiles = await apiService.waiters(); flash('Официант добавлен'); render(); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось добавить официанта'); } return; }
  if (type === 'save-waiter' || type === 'toggle-waiter') { try { const id = element.dataset.waiterId ?? ''; const pin = root.querySelector<HTMLInputElement>(`[data-waiter-pin="${CSS.escape(id)}"]`)?.value ?? ''; const isActive = type === 'toggle-waiter' ? element.dataset.waiterActive === 'true' : undefined; await apiService.updateWaiter(id, { pin, isActive }); waiterProfiles = await apiService.waiters(); flash('Доступ обновлён'); render(); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось обновить доступ'); } return; }
  if (type === 'create-admin-user') { try { const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-admin-user="${name}"]`); await apiService.createAdminUser({ name: field('name')?.value.trim() ?? '', username: field('username')?.value.trim() ?? '', password: field('password')?.value ?? '', role: field('role')?.value === 'administrator' ? 'administrator' : 'hostess' }); adminUserProfiles = await apiService.adminUsers(); flash('Сотрудник добавлен'); render(); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось добавить сотрудника'); } return; }
  if (type === 'save-admin-user' || type === 'toggle-admin-user') { try { const id = element.dataset.userId ?? ''; const card = root.querySelector<HTMLElement>(`[data-admin-user-card="${CSS.escape(id)}"]`); const role = card?.querySelector<HTMLSelectElement>('[data-admin-user-role]')?.value === 'administrator' ? 'administrator' : 'hostess'; const password = card?.querySelector<HTMLInputElement>('[data-admin-user-password]')?.value ?? ''; const isActive = type === 'toggle-admin-user' ? element.dataset.userActive === 'true' : element.dataset.userActive !== 'false'; await apiService.updateAdminUser(id, { password, role, isActive }); adminUserProfiles = await apiService.adminUsers(); flash('Доступ сотрудника обновлён'); render(); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось обновить сотрудника'); } return; }
  if (type === 'toggle-fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => flash('Полноэкранный режим недоступен в этом браузере'));
    return;
  }
  if (type === 'refresh-app') {
    navigator.serviceWorker?.getRegistration().then((registration) => registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    location.reload();
    return;
  }
  if (type === 'banner-slide') { selectBanner(Number(element.dataset.bannerIndex ?? 0)); return; }
  if (type === 'open-product') {
    if (router.current() === 'welcome' && Date.now() < suppressBannerOpenUntil) return;
    const id = element.dataset.productId ?? null;
    const recentProductIds = id ? [id, ...appStore.get().recentProductIds.filter((item) => item !== id)].slice(0, 8) : appStore.get().recentProductIds;
    const fromWelcome = router.current() === 'welcome';
    appStore.set({ productId: id, upsellId: null, recentProductIds, ...(fromWelcome ? { category: 'Все блюда', search: '' } : {}) });
    if (fromWelcome) router.go('menu');
    return;
  }
  if (type === 'close-product') { appStore.set({ productId: null }); return; }
  if (type === 'select-category') { appStore.set({ category: element.dataset.category ?? 'Все блюда', search: '' }); return; }
  if (type === 'close-search') {
    updateSearch('');
    appStore.set({ search: '' });
    return;
  }
  if (type === 'set-option') {
    const group = element.closest('.option-group');
    if (group?.getAttribute('data-multiple') === 'true') element.classList.toggle('is-selected');
    else {
      const wasSelected = element.classList.contains('is-selected');
      const isOptional = Number(group?.getAttribute('data-min-quantity') ?? 1) === 0;
      group?.querySelectorAll('button').forEach((button) => button.classList.remove('is-selected'));
      if (!wasSelected || !isOptional) element.classList.add('is-selected');
    }
    updateModalTotal();
    return;
  }
  if (type === 'toggle-related') {
    element.classList.toggle('is-selected');
    updateModalTotal();
    return;
  }
  if (type === 'change-modal-quantity') {
    const counter = root.querySelector<HTMLElement>('[data-modal-quantity]');
    if (!counter) return;
    const next = Math.min(20, Math.max(1, Number(counter.textContent ?? 1) + Number(element.dataset.delta ?? 0)));
    counter.textContent = String(next);
    updateModalTotal();
    return;
  }
  if (type === 'add-product') {
    const product = menuService.find(element.dataset.productId!);
    if (!product) return;
    const groups = [...root.querySelectorAll<HTMLElement>('.option-group')];
    const groupFor = (name: string) => groups.find((group) => group.dataset.optionGroup === name);
    const valueAt = (name: string) => groupFor(name)?.querySelector<HTMLElement>('button.is-selected')?.dataset.value;
    const sauces = [...(groupFor('Соусы')?.querySelectorAll<HTMLElement>('button.is-selected') ?? [])].map((button) => button.dataset.value ?? '');
    const relatedIds = [...root.querySelectorAll<HTMLElement>('.related-choice.is-selected')].map((item) => item.dataset.productId ?? '');
    const quantity = Number(root.querySelector<HTMLElement>('[data-modal-quantity]')?.textContent ?? 1);
    const related = relatedIds.map((id) => menuService.find(id)).filter((item): item is Product => Boolean(item));
    const modifiers = [...root.querySelectorAll<HTMLElement>('[data-iiko-modifier="true"].is-selected')].map((item) => ({ productId: item.dataset.productId ?? '', name: item.dataset.value ?? '', amount: 1, price: Number(item.dataset.price ?? 0), image: item.dataset.image || '/images/sauce-fallback.webp', maxQuantity: Number(item.dataset.maxQuantity ?? 20) || 20 })).filter((item) => item.productId);
    orderStore.addBundle(product, { addon: valueAt('Добавки'), flavor: valueAt('Вкус'), ...(modifiers.length ? { modifiers } : {}) }, sauces, related, quantity);
    transientToast('Выбранные позиции добавлены в заказ');
    return;
  }
  if (type === 'accept-upsell') {
    const product = menuService.find(element.dataset.productId!);
    if (product) { orderStore.add(product); flash(`${product.name} добавлен в заказ`); }
    return;
  }
  if (type === 'dismiss-upsell') { appStore.set({ upsellId: null }); return; }
  if (type === 'save-terminal') {
    const input = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => root.querySelector<T>(`[data-admin-terminal="${name}"]`);
    try {
      const terminal = await apiService.saveTerminal({ id: apiService.terminalId, label: input<HTMLInputElement>('label')?.value.trim() ?? '', tableId: input<HTMLInputElement>('tableId')?.value.trim() || null, tableNumber: input<HTMLInputElement>('tableNumber')?.value.trim() ?? '', isActive: input<HTMLInputElement>('isActive')?.checked ?? true, idleSeconds: Number(input<HTMLSelectElement>('idleSeconds')?.value ?? 45) });
      appStore.set({ terminal }); flash('Настройка терминала сохранена');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить терминал'); }
    return;
  }
  if (type === 'select-admin-terminal-table') {
    const tableId = element.dataset.tableId ?? '';
    const tableNumber = element.dataset.tableNumber ?? '';
    const idInput = root.querySelector<HTMLInputElement>('[data-admin-terminal="tableId"]');
    const numberInput = root.querySelector<HTMLInputElement>('[data-admin-terminal="tableNumber"]');
    if (idInput) idInput.value = tableId;
    if (numberInput) numberInput.value = tableNumber;
    root.querySelectorAll<HTMLElement>('[data-action="select-admin-terminal-table"]').forEach((button) => {
      const selected = (button.dataset.tableId ?? '') === tableId;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const table = appStore.get().tables.find((item) => item.id === tableId);
    const summary = root.querySelector<HTMLElement>('[data-terminal-table-summary]');
    if (summary) summary.textContent = table ? `Стол №${table.number || table.name}` : 'Выбирает гость';
    return;
  }
  if (type === 'refresh-terminal-tables') {
    const button = element as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Обновляем…';
    await loadTerminalTables();
    return;
  }
  if (type === 'toggle-image-cache-auto') {
    const enabled = (element as HTMLInputElement).checked;
    imageCacheService.setAutoUpdate(enabled);
    adminImageCacheState = { ...adminImageCacheState, autoUpdate: enabled };
    if (enabled) void runImageCacheSync(false);
    return;
  }
  if (type === 'sync-image-cache' || type === 'check-image-cache') {
    const force = type === 'sync-image-cache' && element.dataset.cacheForce === 'true';
    await runImageCacheSync(force);
    return;
  }
  if (type === 'clear-image-cache') {
    const sources = imageSources();
    adminImageCacheState = { ...adminImageCacheState, phase: 'clearing' };
    render();
    adminImageCacheState = await imageCacheService.clear(sources, (state) => { adminImageCacheState = state; paintImageCacheState(state); });
    applyCachedImageUrls(true);
    return;
  }
  if (type === 'check-ota-update') {
    adminUpdateState = { ...adminUpdateState, phase: 'checking', latestVersion: null, progress: 0 };
    render();
    try {
      const result = await otaService.check();
      adminUpdateState = {
        phase: result.available ? 'available' : 'current',
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        progress: 0,
        browser: result.platform === 'browser',
      };
    } catch {
      adminUpdateState = { ...adminUpdateState, phase: 'error', latestVersion: null, progress: 0 };
    }
    render();
    return;
  }
  if (type === 'install-ota-update') {
    adminUpdateState = { ...adminUpdateState, phase: 'downloading', progress: 0 };
    render();
    try {
      const result = await otaService.installLatest(updateDownloadProgress);
      if (result.state === 'browser') adminUpdateState = { ...adminUpdateState, phase: 'current', browser: true };
      else if (result.state === 'current') {
        const checked = await otaService.check();
        adminUpdateState = { phase: 'current', currentVersion: checked.currentVersion, latestVersion: checked.latestVersion, progress: 100, browser: false };
      } else adminUpdateState = { ...adminUpdateState, phase: 'applying', progress: 100 };
    } catch {
      adminUpdateState = { ...adminUpdateState, phase: 'error', progress: 0 };
    }
    render();
    return;
  }
  if (type === 'save-product') {
    const id = element.dataset.productId!;
    const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string) => root.querySelector<T>(`[data-admin-product="${name}"]`);
    try {
      const pairs = [...(input<HTMLSelectElement>('pairs')?.selectedOptions ?? [])].map((option) => option.value);
      await apiService.saveIikoPresentation(id, { image: input<HTMLInputElement>('image')?.value.trim() ?? '', imagePosition: input<HTMLSelectElement>('imagePosition')?.value ?? 'center', badge: input<HTMLSelectElement>('badge')?.value ?? '', composition: input<HTMLTextAreaElement>('composition')?.value.trim() ?? '', pairsWith: pairs });
      await syncServer(); flash('Оформление блюда сохранено');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить блюдо'); }
    return;
  }
  if (type === 'upload-product-image') {
    const input = element as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const status = root.querySelector<HTMLElement>('[data-product-upload-status]');
    const setStatus = (message: string, state = '') => { if (status) { status.textContent = message; status.dataset.state = state; } };
    const extension = file.name.split('.').pop()?.toLowerCase();
    const inferredMime = file.type === 'image/png' || file.type === 'image/webp' ? file.type : file.type === 'image/jpeg' || extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : '';
    if (file.size > 8 * 1024 * 1024) { setStatus('Файл больше 8 МБ', 'error'); input.value = ''; return; }
    if (!inferredMime) { setStatus('Нужен PNG, JPEG или WebP', 'error'); input.value = ''; return; }
    input.disabled = true; setStatus(`Загружаем ${file.name}…`, 'loading');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const raw = String(reader.result ?? ''); resolve(`data:${inferredMime};base64,${raw.slice(raw.indexOf(',') + 1)}`); }; reader.onerror = () => reject(new Error('Не удалось прочитать файл')); reader.readAsDataURL(file); });
      const uploaded = await apiService.uploadProductImage(dataUrl);
      const hidden = root.querySelector<HTMLInputElement>('[data-admin-product="image"]');
      const preview = root.querySelector<HTMLElement>('[data-product-image-preview]');
      if (hidden) hidden.value = uploaded.url;
      if (preview) preview.innerHTML = `<img src="${uploaded.url}" alt="">`;
      setStatus(`${file.name} загружен. Сохраните блюдо.`, 'success');
    } catch (error) { const message = error instanceof Error ? error.message : 'Не удалось загрузить фото'; setStatus(message, 'error'); flash(message); }
    finally { input.disabled = false; }
    return;
  }
  if (type === 'upload-banner-image') {
    const input = element as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const target = input.dataset.bannerTarget ?? 'create';
    const status = root.querySelector<HTMLElement>(`[data-banner-upload-status="${CSS.escape(target)}"]`);
    const setStatus = (message: string, state = '') => {
      if (!status) return;
      status.textContent = message;
      status.dataset.state = state;
    };
    const extension = file.name.split('.').pop()?.toLowerCase();
    const inferredMime = file.type === 'image/png' || file.type === 'image/webp'
      ? file.type
      : file.type === 'image/jpeg' || file.type === 'image/jpg' || extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'png'
          ? 'image/png'
          : extension === 'webp'
            ? 'image/webp'
            : '';
    if (file.size > 8 * 1024 * 1024) { setStatus('Файл больше 8 МБ', 'error'); flash('Изображение должно быть не больше 8 МБ'); input.value = ''; return; }
    if (!inferredMime) { setStatus('Нужен PNG, JPEG или WebP', 'error'); flash('Поддерживаются PNG, JPEG и WebP'); input.value = ''; return; }
    input.disabled = true;
    setStatus(`Загружаем ${file.name}…`, 'loading');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result ?? '');
          resolve(`data:${inferredMime};base64,${raw.slice(raw.indexOf(',') + 1)}`);
        };
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        reader.readAsDataURL(file);
      });
      const uploaded = await apiService.uploadBannerImage(dataUrl);
      if (target === 'create') {
        const image = root.querySelector<HTMLInputElement>('[data-banner-create="image"]');
        const preview = root.querySelector<HTMLElement>('[data-banner-preview="create"]');
        if (image) image.value = uploaded.url;
        if (preview) preview.innerHTML = `<img src="${uploaded.url}" alt="">`;
      } else {
        const card = root.querySelector<HTMLElement>(`[data-banner-card="${CSS.escape(target)}"]`);
        const image = card?.querySelector<HTMLInputElement>('[data-banner-field="image"]');
        const preview = card?.querySelector<HTMLImageElement>('.banner-admin-card__image img');
        if (image) image.value = uploaded.url;
        if (preview) preview.src = uploaded.url;
      }
      setStatus(`${file.name} загружен`, 'success');
      transientToast('Изображение загружено');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить изображение';
      setStatus(message, 'error');
      flash(message);
    }
    finally { input.disabled = false; }
    return;
  }
  if (type === 'create-banner') {
    const input = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => root.querySelector<T>(`[data-banner-create="${name}"]`);
    const date = (name: string) => input<HTMLInputElement>(name)?.value ? new Date(input<HTMLInputElement>(name)!.value).toISOString() : null;
    const limit = Number(input<HTMLInputElement>('impressionLimit')?.value || 0) || null;
    try {
      await apiService.createBanner({ name: input<HTMLInputElement>('name')?.value.trim() ?? '', image: input<HTMLInputElement>('image')?.value ?? '', productId: input<HTMLSelectElement>('productId')?.value || null, kind: (input<HTMLSelectElement>('kind')?.value ?? 'restaurant') as Banner['kind'], active: true, startsAt: date('startsAt'), endsAt: date('endsAt'), impressionLimit: limit, sortOrder: Number(input<HTMLInputElement>('sortOrder')?.value ?? 0) });
      adminBanners = await apiService.banners();
      await syncServer();
      flash('Баннер добавлен');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось добавить баннер'); }
    return;
  }
  if (type === 'save-banner') {
    const id = element.dataset.bannerId ?? '';
    const current = adminBanners.find((item) => item.id === id);
    const card = root.querySelector<HTMLElement>(`[data-banner-card="${CSS.escape(id)}"]`);
    if (!current || !card) return;
    const input = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => card.querySelector<T>(`[data-banner-field="${name}"]`);
    const date = (name: string) => input<HTMLInputElement>(name)?.value ? new Date(input<HTMLInputElement>(name)!.value).toISOString() : null;
    try {
      await apiService.saveBanner({ ...current, name: input<HTMLInputElement>('name')?.value.trim() ?? '', image: input<HTMLInputElement>('image')?.value ?? current.image, productId: input<HTMLSelectElement>('productId')?.value || null, kind: (input<HTMLSelectElement>('kind')?.value ?? 'restaurant') as Banner['kind'], startsAt: date('startsAt'), endsAt: date('endsAt'), impressionLimit: Number(input<HTMLInputElement>('impressionLimit')?.value || 0) || null, sortOrder: Number(input<HTMLInputElement>('sortOrder')?.value ?? 0) });
      adminBanners = await apiService.banners();
      await syncServer();
      flash('Баннер сохранён');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить баннер'); }
    return;
  }
  if (type === 'toggle-banner') {
    const current = adminBanners.find((item) => item.id === element.dataset.bannerId);
    if (!current) return;
    try { await apiService.saveBanner({ ...current, active: !current.active }); adminBanners = await apiService.banners(); await syncServer(); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось изменить баннер'); }
    return;
  }
  if (type === 'reset-banner-impressions') {
    try { await apiService.resetBannerImpressions(element.dataset.bannerId ?? ''); adminBanners = await apiService.banners(); await syncServer(); flash('Счётчик показов сброшен'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сбросить показы'); }
    return;
  }
  if (type === 'delete-banner') {
    const id = element.dataset.bannerId ?? '';
    if (!confirm('Удалить этот баннер?')) return;
    try { await apiService.deleteBanner(id); adminBanners = await apiService.banners(); await syncServer(); flash('Баннер удалён'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось удалить баннер'); }
    return;
  }
  if (type === 'create-promotion') {
    const input = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => root.querySelector<T>(`[data-promotion-create="${name}"]`);
    const date = (name: string) => input<HTMLInputElement>(name)?.value ? new Date(input<HTMLInputElement>(name)!.value).toISOString() : null;
    try {
      await apiService.createPromotion({
        code: input<HTMLInputElement>('code')?.value.trim().toUpperCase() ?? '',
        name: input<HTMLInputElement>('name')?.value.trim() ?? '',
        iikoDiscountTypeId: input<HTMLSelectElement>('iikoDiscountTypeId')?.value ?? '',
        active: true,
        startsAt: date('startsAt'),
        endsAt: date('endsAt'),
        usageLimit: Number(input<HTMLInputElement>('usageLimit')?.value || 0) || null,
      });
      await loadAdminPromotions();
      flash('Промокод создан');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось создать промокод'); }
    return;
  }
  if (type === 'toggle-promotion') {
    const id = element.dataset.promotionId ?? '';
    const current = adminPromotions.find((item) => item.id === id);
    if (!current) return;
    try { await apiService.updatePromotion(id, { active: !current.active }); await loadAdminPromotions(); flash(current.active ? 'Промокод отключён' : 'Промокод включён'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось изменить промокод'); }
    return;
  }
  if (type === 'delete-promotion') {
    const id = element.dataset.promotionId ?? '';
    if (!confirm('Удалить этот промокод?')) return;
    try { await apiService.deletePromotion(id); await loadAdminPromotions(); flash('Промокод удалён'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось удалить промокод'); }
    return;
  }
  if (type === 'apply-promo') {
    const code = root.querySelector<HTMLInputElement>('[data-action="set-promo"]')?.value.trim().toUpperCase() ?? '';
    if (!code) { flash('Введите промокод'); return; }
    try {
      const promoRule = await apiService.validatePromotion(code, orderStore.subtotal());
      appStore.set({ promoCode: promoRule.code, promoRule, pendingOrderRequestId: null });
      flash(`Промокод применён: −${formatPrice(promoRule.discount)}`);
    } catch (error) {
      appStore.set({ promoCode: '', promoRule: null, pendingOrderRequestId: null });
      flash(error instanceof Error ? error.message : 'Промокод не найден');
    }
    return;
  }
  if (type === 'remove-promo') {
    appStore.set({ promoCode: '', promoRule: null, pendingOrderRequestId: null });
    return;
  }
  if (type === 'save-display') {
    const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-admin-display="${name}"]`);
    const productId = field('product')?.value;
    if (productId) appStore.set({ productDisplay: { ...appStore.get().productDisplay, [productId]: {
      badge: field('badge')?.value ?? '',
      unavailable: (field('unavailable') as HTMLInputElement | null)?.checked ?? false,
      imagePosition: field('imagePosition')?.value || 'center',
      spicy: (field('spicy')?.value || 'none') as 'none' | 'mild' | 'hot',
      allergens: field('allergens')?.value.trim() ?? '',
    } } });
    flash('Карточка обновлена');
    return;
  }
  if (type === 'load-display') {
    const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-admin-display="${name}"]`);
    const settings = appStore.get().productDisplay[field('product')?.value ?? ''];
    if (field('badge')) field('badge')!.value = settings?.badge ?? '';
    if (field('imagePosition')) field('imagePosition')!.value = settings?.imagePosition ?? 'center';
    if (field('spicy')) field('spicy')!.value = settings?.spicy ?? 'none';
    if (field('allergens')) field('allergens')!.value = settings?.allergens ?? '';
    const unavailable = field('unavailable') as HTMLInputElement | null;
    if (unavailable) unavailable.checked = settings?.unavailable ?? false;
    return;
  }
  if (type === 'change-quantity') {
    const line = element.closest<HTMLElement>('.order-line');
    const current = orderStore.lines().find((item) => item.key === element.dataset.key);
    const next = (current?.quantity ?? 0) + Number(element.dataset.delta);
    if (!line || next <= 0) { orderStore.change(element.dataset.key!, Number(element.dataset.delta)); return; }
    orderStore.change(element.dataset.key!, Number(element.dataset.delta), false);
    updateOrderTotals(line);
    return;
  }
  if (type === 'remove-line') { orderStore.remove(element.dataset.key!); return; }
  if (type === 'change-modifier-quantity') {
    const changed = orderStore.changeModifier(element.dataset.key!, element.dataset.modifierId!, Number(element.dataset.delta));
    if (!changed && Number(element.dataset.delta) > 0) flash('Максимальное количество задано в iiko');
    return;
  }
  if (type === 'remove-modifier') { orderStore.removeModifier(element.dataset.key!, element.dataset.modifierId!); return; }
  if (type === 'open-service') { appStore.set({ serviceOpen: true }); return; }
  if (type === 'close-service') { appStore.set({ serviceOpen: false }); return; }
  if (type === 'request-service') { waiterService.request(element.dataset.service ?? '').then((result) => { appStore.set({ serviceOpen: false }); flash(result.message); }); return; }
  if (type === 'open-order-status') {
    const orderId = element.dataset.orderId ?? null;
    appStore.set({ selectedOrderId: orderId, orderNumber: orderId });
    router.go('status');
    return;
  }
  if (type === 'new-order') {
    appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null, upsellId: null });
    router.go('menu');
    return;
  }
  if (type === 'submit-order') {
    if (!orderStore.count()) { router.go('menu'); flash('Добавьте блюда в заказ'); return; }
    if (submittingOrder) return;
    submittingOrder = true;
    const button = element as HTMLButtonElement;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'ОТПРАВЛЯЕМ ЗАКАЗ…';
    try {
      await orderService.submit();
      // Keep the submitted order state intact while clearing the cart before
      // opening the live status screen.
      appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null }, false);
      router.go('status');
    } catch (error) {
      button.disabled = false;
      button.textContent = originalLabel;
      flash(error instanceof Error ? error.message : 'Не удалось отправить заказ');
    }
    finally { submittingOrder = false; }
    return;
  }
  if (type === 'complete-order') {
    const selectedOrderId = appStore.get().selectedOrderId;
    if (!selectedOrderId) return;
    try {
      await apiService.completeOrder(selectedOrderId);
      appStore.set({
        orders: appStore.get().orders.filter((order) => order.id !== selectedOrderId),
        selectedOrderId: null,
        orderNumber: null,
        statusStep: 0,
      });
      router.go('orders');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось завершить заказ'); }
    return;
  }
  if (type === 'continue-order') { appStore.set({ inactivityWarning: false, inactivitySeconds: 15 }); resetInactivity(); return; }
  if (type === 'cancel-order') { finishInactiveSession(); return; }
  if (type === 'toggle-language') { const language = appStore.get().language === 'en' ? 'ru' : 'en'; appStore.set({ language }); flash(language === 'en' ? 'Language: EN' : 'Язык: RU'); }
}

function finishInactiveSession() {
  clearTimeout(inactivityTimer);
  clearInterval(inactivityCountdown);
  if (appStore.get().orders.length) {
    appStore.set({
      cart: [],
      comment: '',
      orderType: null,
      promoCode: '',
      promoRule: null,
      productId: null,
      serviceOpen: false,
      upsellId: null,
      inactivityWarning: false,
      inactivitySeconds: 15,
    });
  } else {
    appStore.resetOrder();
  }
  router.go('welcome');
}

function applyServerProduct(product: Product, display: import('./types/menu').ProductDisplaySettings) {
  const next = menuService.all().map((item) => item.id === product.id ? product : item);
  setCatalog(next);
  appStore.set({ productDisplay: { ...appStore.get().productDisplay, [product.id]: display } });
}

function refreshMenuResults() {
  const target = root.querySelector<HTMLElement>('[data-menu-results]');
  if (!target || router.current() !== 'menu') return;
  const state = appStore.get();
  target.innerHTML = menuResults(menuService.search(state.search, state.category), state.category, state.search, menuService.recent(state.recentProductIds), state.productDisplay, menuService.ready());
}

async function syncServer(includeAudit = false) {
  try {
    const previous = appStore.get();
    const data = await apiService.bootstrap();
    setCatalog(data.products);
    if (!imageCacheService.isRunning()) adminImageCacheState = imageCacheService.state(imageSources(data.products, data.banners));
    const selectedOrderId = previous.selectedOrderId ?? data.orders[0]?.id ?? null;
    const previousOrder = previous.orders.find((item) => item.id === selectedOrderId);
    const nextOrder = data.orders.find((item) => item.id === selectedOrderId);
    const statusChanged = previousOrder?.statusStep !== nextOrder?.statusStep || Boolean(previousOrder) !== Boolean(nextOrder);
    const shouldRender = router.current() !== 'status' || statusChanged;
    appStore.set({ banners: data.banners, productDisplay: data.display, terminal: data.terminal, inactivitySeconds: data.terminal.idleSeconds, orders: data.orders, selectedOrderId, orderNumber: previous.orderNumber ?? data.orders[0]?.id ?? null }, shouldRender);
    appStore.set({ isOnline: true }, false);
    if (includeAudit) auditLog = await apiService.audit();
    if (imageCacheService.autoUpdate() && !imageCacheService.isRunning() && Date.now() - lastAutomaticImageSync > 5 * 60_000) {
      lastAutomaticImageSync = Date.now();
      void runImageCacheSync(false, false);
    }
  } catch (error) {
    console.warn('Server bootstrap unavailable', error);
    appStore.set({ isOnline: false }, false);
  }
}

function resetInactivity() {
  clearTimeout(inactivityTimer);
  clearInterval(inactivityCountdown);
  const state = appStore.get();
  if (state.inactivityWarning) return;

  const route = router.current();
  // The timeout protects an unfinished guest session only. A placed order is
  // already owned by the table, while the welcome and order-status screens are
  // safe to leave open indefinitely.
  if (route === 'welcome' || route === 'status' || route === 'orders' || route === 'admin') return;
  const hasDraft = orderStore.count() > 0 || Boolean(state.productId || state.upsellId);
  const shouldWarn = hasDraft;
  inactivityTimer = window.setTimeout(() => {
    const currentRoute = router.current();
    const currentState = appStore.get();
    const currentDraft = orderStore.count() > 0 || Boolean(currentState.productId || currentState.upsellId);
    if (currentRoute === 'welcome' || currentRoute === 'status' || currentRoute === 'orders' || currentRoute === 'admin') return;
    // Browsing an empty menu (or an empty checkout) does not warrant a warning:
    // simply return the tablet to the welcome screen for the next guest.
    if (!currentDraft || !shouldWarn) {
      router.go('welcome');
      return;
    }
    appStore.set({ inactivityWarning: true, inactivitySeconds: 15, productId: null, serviceOpen: false });
    let seconds = 15;
    inactivityCountdown = window.setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) finishInactiveSession();
      else {
        const countdown = root.querySelector<HTMLElement>('[data-inactivity-countdown]');
        if (countdown) countdown.textContent = String(seconds);
      }
    }, 1000);
  }, (appStore.get().terminal?.idleSeconds ?? 45) * 1_000);
}

export function startApp() {
  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target && (!(target.classList.contains('overlay')) || event.target === target)) action(target);
    if (!appStore.get().inactivityWarning) resetInactivity();
  });
  root.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.dataset.action === 'search') updateSearch(target.value);
    if (target.dataset.action === 'set-comment') updateComment(target.value);
    if (target.dataset.action === 'filter-admin-tables') {
      const query = target.value.trim().toLocaleLowerCase('ru-RU');
      root.querySelectorAll<HTMLElement>('[data-table-section]').forEach((section) => {
        let visible = 0;
        section.querySelectorAll<HTMLElement>('[data-table-search]').forEach((card) => {
          const matches = !query || (card.dataset.tableSearch ?? '').includes(query);
          card.hidden = !matches;
          if (matches) visible += 1;
        });
        section.hidden = visible === 0;
      });
    }
    resetInactivity();
  });
  root.addEventListener('change', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target) action(target);
    const productSelect = event.target as HTMLSelectElement;
    if (productSelect.matches('[data-admin-product-select]')) appStore.set({ adminProductId: productSelect.value });
    if (productSelect.matches('[data-iiko-organization]')) { void loadIikoRestaurantOptions(productSelect.value); }
    if (productSelect.matches('[data-iiko-selection]')) {
      iikoConfigTestToken = '';
      const applyButton = root.querySelector<HTMLButtonElement>('[data-action="apply-iiko-config"]'); if (applyButton) applyButton.disabled = true;
      const resultBox = root.querySelector<HTMLElement>('[data-iiko-test-result]'); if (resultBox) { resultBox.dataset.state = ''; resultBox.textContent = 'После изменений снова выполните проверку подключения.'; }
    }
    resetInactivity();
  });
  root.addEventListener('touchstart', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.welcome-banners')) return;
    const touch = event.touches[0];
    if (touch) bannerSwipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  root.addEventListener('touchend', (event) => {
    if (!bannerSwipeStart) return;
    const target = event.target as HTMLElement;
    const touch = event.changedTouches[0];
    const start = bannerSwipeStart;
    bannerSwipeStart = null;
    if (!touch || !target.closest('.welcome-banners')) return;
    const distanceX = touch.clientX - start.x;
    const distanceY = touch.clientY - start.y;
    if (Math.abs(distanceX) < 42 || Math.abs(distanceX) < Math.abs(distanceY)) return;
    const current = [...root.querySelectorAll('.welcome-banner')].findIndex((banner) => banner.classList.contains('is-active'));
    selectBanner((current < 0 ? 0 : current) + (distanceX < 0 ? 1 : -1));
    suppressBannerOpenUntil = Date.now() + 450;
  }, { passive: true });
  ['pointerdown', 'touchstart', 'keydown'].forEach((event) => addEventListener(event, resetInactivity, { passive: true }));
  addEventListener('online', () => { appStore.set({ isOnline: true }); flash('Соединение восстановлено'); });
  addEventListener('offline', () => { appStore.set({ isOnline: false }); });
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  appStore.subscribe(render);
  router.start(render);
  render();
  resetInactivity();
  void otaService.markReady();
  void loadCurrentAppVersion(false);
  void syncServer();
}
