import { appShell } from './components/app-shell';
import { productModal, relatedCards } from './components/product-modal';
import { serviceSheet } from './components/service-sheet';
import { ALL_MENU_CATEGORY, menuService, setCatalog } from './services/menu-service';
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
import { debounce, escapeHtml, formatPrice } from './utils/helpers';
import { applyLanguage } from './services/i18n';
import { otaService } from './services/ota-service';
import { imageCacheService, type ImageCacheState } from './services/image-cache-service';
import { icon } from './components/icons';
import type { AdminDiagnostics, AdminOrder, AdminPromotion, ApplicationDownloadIssue, Banner, IikoConnectionConfig, IikoConnectionDiscovery, IikoConnectionSelection, IikoDiscountOption, IikoRestaurantOptions, Product, SecurityOverview, TableQrCode } from './types/menu';
import type { AdminUserProfile, IikoFrontOverview, WaiterProfile } from './services/api-service';
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
let catalogRefreshTimer = 0;
let auditLog: Array<{ action: string; entity: string; entity_id: string; created_at: string }> = [];
let waiterProfiles: WaiterProfile[] = [];
let adminUserProfiles: AdminUserProfile[] = [];
let adminIikoFront: IikoFrontOverview | null = null;
let adminBanners: Banner[] = [];
let adminPromotions: AdminPromotion[] = [];
let adminIikoDiscounts: IikoDiscountOption[] = [];
let adminOrders: AdminOrder[] = [];
let adminQrCodes: TableQrCode[] = [];
let adminApplicationDownloads: ApplicationDownloadIssue[] = [];
let adminDiagnostics: AdminDiagnostics | null = null;
let adminSecurity: SecurityOverview | null = null;
let iikoConfigAccessToken = '';
let adminIikoConfig: IikoConnectionConfig | null = null;
let iikoConfigTestToken = '';
let iikoConfigLockTimer = 0;
let iikoDiscovery: IikoConnectionDiscovery | null = null;
let iikoRestaurantOptions: IikoRestaurantOptions | null = null;
let iikoSelectedOrganizationId = '';
let adminOrderFilter: 'active' | 'all' = 'active';
let adminOrderRefreshTimer = 0;
let adminApplicationRefreshTimer = 0;
let adminUpdateState: AdminUpdateState = { phase: 'idle', currentVersion: otaService.bundledVersion, latestVersion: null, progress: 0, browser: false };
let adminImageCacheState: ImageCacheState = imageCacheService.state([]);
let lastAutomaticImageSync = 0;
let qrStartupError = '';
let syncServerTask: Promise<void> | null = null;
let auditSyncTask: Promise<void> | null = null;
let catalogSnapshot = '';
let currentCatalogRevision = '';
let bootstrapSnapshot = '';
let consecutiveBootstrapFailures = 0;
let offlineTimer = 0;
let menuCategoryScrollLeft = 0;
let menuSearchOpen = false;
const pendingServiceRequests = new Set<string>();
const updateSearch = debounce((value: string) => {
  const searching = Boolean(value.trim());
  appStore.set({ search: value, ...(searching ? { category: ALL_MENU_CATEGORY } : {}) }, false);
  if (searching) {
    root.querySelectorAll<HTMLElement>('.category-nav button').forEach((button) => button.classList.toggle('is-active', button.dataset.category === ALL_MENU_CATEGORY));
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
    case 'menu': return menuPage(menuService.categories(), menuService.search(state.search, state.category), state.category, state.search, menuService.recent(state.recentProductIds), state.productDisplay, menuService.ready(), menuSearchOpen);
    case 'order': return orderPage(orderStore.lines(), orderStore.product, orderStore.subtotal(), orderStore.discount(), orderStore.total(), state.comment, state.promoCode, state.promoRule);
    case 'orders': return ordersPage(state.orders);
    case 'status': {
      const order = state.orders.find((item) => item.id === state.selectedOrderId);
      return statusPage(order, order?.id ?? state.orderNumber, order?.statusStep ?? state.statusStep, orderStore.product);
    }
    case 'admin': return state.adminAuthenticated ? adminPage(menuService.all(), adminBanners, state.productDisplay, state.terminal, state.adminTab, state.adminProductId, auditLog, state.adminScope, state.adminRole, waiterProfiles, adminUserProfiles, adminOrders, adminOrderFilter, adminDiagnostics, adminIikoConfig, iikoDiscovery, iikoRestaurantOptions, iikoSelectedOrganizationId, adminPromotions, adminIikoDiscounts, adminUpdateState, state.tables, adminImageCacheState, adminQrCodes, adminSecurity, adminIikoFront, adminApplicationDownloads) : '';
  }
}

const adminLogin = (open: boolean, scope: 'terminal' | 'restaurant' = 'terminal') => open ? `<div class="overlay admin-login-overlay"><section class="admin-login"><button class="modal__close" data-action="close-admin-login">${icon('close')}</button><span class="eyebrow">${scope === 'terminal' ? 'СЕРВИСНЫЙ ВХОД' : 'АДМИНИСТРИРОВАНИЕ РЕСТОРАНА'}</span><h2>Вход</h2><p>${scope === 'terminal' ? 'Настройки этого планшета.' : 'Введите персональный логин или используйте главный пароль.'}</p>${scope === 'restaurant' ? '<input data-admin-username placeholder="Логин сотрудника (необязательно)" autocomplete="username">' : ''}<input type="password" data-admin-password placeholder="Пароль" autocomplete="current-password"><button class="button button--primary button--wide" data-action="login-admin" data-admin-scope="${scope}">Войти</button></section></div>` : '';
const inactivityPrompt = (open: boolean, seconds: number) => open ? `<div class="overlay inactivity-overlay"><section class="inactivity-dialog">
  <img class="inactivity-dialog__character" src="/images/inactivity-character.png" alt="" aria-hidden="true">
  <div class="inactivity-dialog__glow"></div><div class="inactivity-dialog__brand"><img src="${brand.logo}" alt="Brooklyn Bowl"></div>
  <div class="inactivity-dialog__timer"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="53"></circle><circle class="inactivity-dialog__progress" cx="60" cy="60" r="53"></circle></svg><strong data-inactivity-countdown>${seconds}</strong><small>СЕК</small></div>
  <h2>Вы ещё выбираете?</h2><p>Нажмите «Продолжить», чтобы сохранить выбранные блюда.</p>
  <div class="inactivity-dialog__actions"><button class="button button--primary button--wide" data-action="continue-order">Продолжить</button><button class="button button--secondary button--wide inactivity-dialog__cancel" data-action="cancel-order">Начать заново</button></div>
</section></div>` : '';
export function render() {
  const state = appStore.get();
  const route = router.current();
  if (qrStartupError) {
    root.innerHTML = `<section class="qr-entry-error"><h1>Не получилось открыть меню</h1><p>${escapeHtml(qrStartupError)}</p><button class="button button--secondary" data-action="retry-qr-entry">Повторить</button></section>`;
    return;
  }
  if (route === 'admin' && !state.adminAuthenticated) { root.innerHTML = adminLogin(true, 'restaurant'); return; }
  if (route === 'status' && !state.selectedOrderId && !state.orderNumber) { router.go('orders'); return; }
  root.innerHTML = appShell(page(), route) + serviceSheet(state.serviceOpen) + productModal(state.productId ? menuService.find(state.productId) : undefined, state.productId ? state.productDisplay[state.productId] : undefined, state.productDisplay) + adminLogin(state.adminLoginOpen, 'terminal') + inactivityPrompt(state.inactivityWarning, state.inactivitySeconds) + (!state.isOnline ? '<div class="network-banner">Нет подключения к интернету. Меню можно смотреть, но оформить заказ пока не получится.</div>' : '');
  const product = state.productId ? menuService.find(state.productId) : undefined;
  const related = root.querySelector<HTMLElement>('[data-related-for]');
  if (product && related) related.innerHTML = relatedCards(menuService.related(product), state.productDisplay);
  applyLanguage(root, state.language);
  if (route === 'menu') requestAnimationFrame(() => {
    const categories = root.querySelector<HTMLElement>('.category-nav');
    if (categories) categories.scrollLeft = menuCategoryScrollLeft;
  });
  if (route === 'admin') {
    const tabs = root.querySelector<HTMLElement>('.admin-tabs');
    const activeTab = tabs?.querySelector<HTMLElement>('.is-active');
    if (tabs && activeTab) requestAnimationFrame(() => {
      const left = activeTab.offsetLeft - (tabs.clientWidth - activeTab.offsetWidth) / 2;
      tabs.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
    });
  }
  if (route === 'welcome') setupWelcomeBanners();
  else {
    if (bannerRotationTimer) { clearInterval(bannerRotationTimer); bannerRotationTimer = 0; }
    currentBannerId = '';
  }
  resetInactivity();
  if (route === 'status' && !statusRefreshTimer) statusRefreshTimer = window.setInterval(() => { void syncServer(); }, state.terminal?.demoMode ? 5_000 : 15_000);
  if (route !== 'status' && statusRefreshTimer) { clearInterval(statusRefreshTimer); statusRefreshTimer = 0; }
  const needsCatalogUpdates = route === 'welcome' || route === 'menu' || route === 'order';
  if (needsCatalogUpdates && !catalogRefreshTimer) catalogRefreshTimer = window.setInterval(() => { void refreshCatalogRevision(); }, 10_000);
  if (!needsCatalogUpdates && catalogRefreshTimer) { clearInterval(catalogRefreshTimer); catalogRefreshTimer = 0; }
  if (route === 'admin' && state.adminTab === 'orders' && !adminOrderRefreshTimer) adminOrderRefreshTimer = window.setInterval(() => { void loadAdminOrders(); }, 15_000);
  if ((route !== 'admin' || state.adminTab !== 'orders') && adminOrderRefreshTimer) { clearInterval(adminOrderRefreshTimer); adminOrderRefreshTimer = 0; }
  if (route === 'admin' && state.adminTab === 'applications' && !adminApplicationRefreshTimer) adminApplicationRefreshTimer = window.setInterval(() => {
    if (!root.querySelector('[data-application-download]:focus')) void loadAdminApplicationDownloads();
  }, 8_000);
  if ((route !== 'admin' || state.adminTab !== 'applications') && adminApplicationRefreshTimer) { clearInterval(adminApplicationRefreshTimer); adminApplicationRefreshTimer = 0; }
}

async function loadAdminOrders(notify = true) {
  try {
    const next = await apiService.adminOrders(adminOrderFilter);
    const changed = JSON.stringify(next) !== JSON.stringify(adminOrders);
    adminOrders = next;
    if (notify && changed) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить заказы'); }
}

async function loadAdminQrCodes(notify = true) {
  try {
    adminQrCodes = await apiService.qrCodes();
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить QR-коды'); }
}

async function loadAdminApplicationDownloads(notify = true) {
  try {
    const next = await apiService.applicationDownloads();
    const changed = JSON.stringify(next) !== JSON.stringify(adminApplicationDownloads);
    adminApplicationDownloads = next;
    if (notify && changed) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить приложения'); }
}

async function loadTerminalTables() {
  try {
    const tables = await apiService.tables();
    appStore.set({ tables });
  } catch (error) {
    flash(error instanceof Error ? error.message : 'Не удалось получить столы из iiko');
  }
}

async function loadTerminalOptions() {
  try {
    const [tables, waiters] = await Promise.all([apiService.tables(), apiService.waiters()]);
    waiterProfiles = waiters;
    appStore.set({ tables });
  } catch (error) {
    flash(error instanceof Error ? error.message : 'Не удалось получить настройки планшета');
  }
}

async function loadAdminDiagnostics(notify = true) {
  try {
    adminDiagnostics = await apiService.diagnostics();
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось проверить систему'); }
}

async function loadAdminSecurity(notify = true) {
  try {
    adminSecurity = await apiService.security();
    if (notify) render();
  } catch (error) { if (notify) flash(error instanceof Error ? error.message : 'Не удалось загрузить раздел безопасности'); }
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
  return { discoveryToken: iikoDiscovery?.discoveryToken ?? '', organizationId: iikoSelectedOrganizationId, terminalGroupId: value('terminalGroupId'), externalMenuId: value('externalMenuId'), orderTypeId: value('orderTypeId') };
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
    allergenLabel.textContent = uniqueAllergens.length ? uniqueAllergens.join(', ') : 'Информацию об аллергенах уточните у официанта.';
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
  // Notifications are transient UI, not application state. Rebuilding the
  // entire page for a toast caused visible flashes and reset scroll positions.
  root.querySelector('.toast')?.remove();
  transientToast(message);
}

type GuestErrorContext = 'general' | 'order' | 'promo' | 'qr' | 'table' | 'service';

function guestErrorMessage(error: unknown, context: GuestErrorContext = 'general') {
  const raw = error instanceof Error ? error.message.trim() : '';
  const normalized = raw.toLocaleLowerCase('ru-RU');
  const offline = normalized.includes('нет соединения') || normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('сеть');
  if (offline) return 'Нет связи с рестораном. Проверьте интернет и попробуйте ещё раз.';
  if (context === 'promo') return 'Промокод не найден или больше не действует.';
  if (context === 'qr') {
    if (normalized.includes('не активен') || normalized.includes('стол') || normalized.includes('iiko')) return 'Этот QR-код больше не работает. Пожалуйста, позовите официанта.';
    return 'Не удалось распознать QR-код. Отсканируйте его ещё раз.';
  }
  if (context === 'table') return 'Этот стол сейчас недоступен. Выберите другой или позовите официанта.';
  if (context === 'service') return 'Не получилось отправить вызов. Попробуйте ещё раз или обратитесь к сотруднику ресторана.';
  if (context === 'order') {
    if (normalized.includes('уже отправля')) return 'Заказ уже передаётся на кухню. Пожалуйста, подождите.';
    if (normalized.includes('измен') || normalized.includes('состав') || normalized.includes('идентификатор')) return 'Заказ изменился. Проверьте его и попробуйте оформить ещё раз.';
    return 'Не получилось оформить заказ. Попробуйте ещё раз или позовите официанта.';
  }
  return 'Что-то пошло не так. Попробуйте ещё раз или позовите официанта.';
}

function selectBanner(index: number) {
  const banners = [...root.querySelectorAll<HTMLElement>('.welcome-banner')];
  if (!banners.length) return;
  const next = ((index % banners.length) + banners.length) % banners.length;
  banners.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === next));
  root.querySelectorAll<HTMLElement>('.welcome-banner-dots button').forEach((dot, itemIndex) => dot.classList.toggle('is-active', itemIndex === next));
  const id = banners[next].dataset.bannerId ?? '';
  if (/^\d+$/.test(id) && id !== currentBannerId) {
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
    if (apiService.isQrMode()) { router.go('menu'); return; }
    const terminal = appStore.get().terminal;
    if (terminal?.tableNumber) { router.go('menu'); return; }
    try {
      const tables = await apiService.tables();
      appStore.set({ tables });
      router.go('table');
    } catch (error) { flash(guestErrorMessage(error, 'table')); }
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
    } catch (error) { element.removeAttribute('disabled'); flash(guestErrorMessage(error, 'table')); }
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
      if (authenticated.scope === 'terminal') void loadTerminalOptions();
    } catch (error) { flash(error instanceof Error ? error.message : 'Неверный пароль'); }
    return;
  }
  if (type === 'logout-admin') { apiService.logout(); clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; appStore.set({ adminAuthenticated: false, adminScope: null, adminRole: null, adminTab: 'terminal' }); router.go('welcome'); return; }
  if (type === 'select-admin-tab') {
    const adminTab = element.dataset.adminTab as 'terminal' | 'orders' | 'menu' | 'banners' | 'qr' | 'applications' | 'promotions' | 'staff' | 'quality' | 'security' | 'audit';
    appStore.set({ adminTab });
    if (adminTab === 'audit') apiService.audit().then((items) => { auditLog = items; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'staff') Promise.all([apiService.waiters(), apiService.adminUsers(), apiService.iikoFront()]).then(([waiters, users, iikoFront]) => { waiterProfiles = waiters; adminUserProfiles = users; adminIikoFront = iikoFront; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'banners') apiService.banners().then((items) => { adminBanners = items; render(); }).catch((error) => flash(error.message));
    if (adminTab === 'qr') Promise.all([loadTerminalTables(), loadAdminQrCodes(false)]).then(render).catch((error) => flash(error.message));
    if (adminTab === 'applications') void loadAdminApplicationDownloads();
    if (adminTab === 'promotions') void loadAdminPromotions();
    if (adminTab === 'orders') void loadAdminOrders();
    if (adminTab === 'quality') void loadAdminDiagnostics();
    if (adminTab === 'security') void loadAdminSecurity();
    if (adminTab === 'terminal') void loadTerminalOptions();
    else { clearTimeout(iikoConfigLockTimer); iikoConfigLockTimer = 0; iikoConfigAccessToken = ''; iikoConfigTestToken = ''; adminIikoConfig = null; iikoDiscovery = null; iikoRestaurantOptions = null; iikoSelectedOrganizationId = ''; }
    return;
  }
  if (type === 'set-admin-order-filter') { adminOrderFilter = element.dataset.orderFilter === 'all' ? 'all' : 'active'; await loadAdminOrders(false); render(); return; }
  if (type === 'refresh-qr-codes') { await Promise.all([loadTerminalTables(), loadAdminQrCodes(false)]); render(); flash('QR-коды обновлены'); return; }
  if (type === 'create-qr-code') {
    const tableId = root.querySelector<HTMLSelectElement>('[data-qr-table]')?.value ?? '';
    if (!tableId) { flash('Выберите стол'); return; }
    try { await apiService.createQrCode(tableId); await loadAdminQrCodes(); flash('QR-код создан'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось создать QR-код'); }
    return;
  }
  if (type === 'generate-all-qr-codes') {
    try { adminQrCodes = await apiService.generateAllQrCodes(); render(); flash('QR-коды для столов готовы'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось создать QR-коды'); }
    return;
  }
  if (type === 'copy-qr-link') {
    const code = adminQrCodes.find((item) => item.id === element.dataset.qrId); if (!code) return;
    try { await navigator.clipboard.writeText(code.publicUrl); flash('Ссылка скопирована'); }
    catch { flash('Не удалось скопировать ссылку'); }
    return;
  }
  if (type === 'download-qr-code') {
    const code = adminQrCodes.find((item) => item.id === element.dataset.qrId); if (!code) return;
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([code.svg], { type: 'image/svg+xml;charset=utf-8' }));
    link.download = `BrooklynBowl-table-${code.tableNumber || code.tableName}.svg`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return;
  }
  if (type === 'print-qr-code') {
    const code = adminQrCodes.find((item) => item.id === element.dataset.qrId); if (!code) return;
    const printWindow = window.open('', '_blank', 'width=720,height=840');
    if (!printWindow) { flash('Разрешите всплывающие окна для печати'); return; }
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Стол №${code.tableNumber}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Arial,sans-serif;color:#111}.card{width:150mm;text-align:center}.qr{width:110mm;margin:auto}.qr svg{width:100%;height:auto}h1{margin:8mm 0 2mm;font-size:18mm}p{margin:0;font-size:5mm;color:#555}@media print{.card{break-inside:avoid}}</style></head><body><main class="card"><div class="qr">${code.svg}</div><h1>СТОЛ №${code.tableNumber || code.tableName}</h1><p>Отсканируйте, чтобы открыть меню и сделать заказ</p></main><script>addEventListener('load',()=>{print();close()})<\/script></body></html>`);
    printWindow.document.close();
    return;
  }
  if (type === 'regenerate-qr-code') {
    const id = element.dataset.qrId ?? ''; if (!id || !confirm('Старый QR-код перестанет работать. Перевыпустить?')) return;
    try { await apiService.regenerateQrCode(id); await loadAdminQrCodes(); flash('QR-код перевыпущен'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось перевыпустить QR-код'); }
    return;
  }
  if (type === 'toggle-qr-code') {
    const id = element.dataset.qrId ?? ''; const active = element.dataset.qrActive === 'true';
    try { await apiService.setQrCodeActive(id, active); await loadAdminQrCodes(); flash(active ? 'QR-код включён' : 'QR-код отключён'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось изменить QR-код'); }
    return;
  }
  if (type === 'retry-qr-entry') { location.reload(); return; }
  if (type === 'refresh-application-downloads') { await loadAdminApplicationDownloads(); flash('Список приложений обновлён'); return; }
  if (type === 'create-application-download') {
    const appKind = root.querySelector<HTMLSelectElement>('[data-application-download="kind"]')?.value === 'waiter' ? 'waiter' : 'kiosk';
    const label = root.querySelector<HTMLInputElement>('[data-application-download="label"]')?.value.trim() ?? '';
    const expiresInHours = Number(root.querySelector<HTMLSelectElement>('[data-application-download="expires"]')?.value ?? 24);
    if (!label) { flash('Укажите устройство или получателя'); return; }
    try { await apiService.createApplicationDownload({ appKind, label, expiresInHours }); await loadAdminApplicationDownloads(); flash('Одноразовый QR-код готов'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось выпустить QR-код'); }
    return;
  }
  if (type === 'copy-application-download') {
    const item = adminApplicationDownloads.find((entry) => entry.id === element.dataset.applicationId); if (!item?.publicUrl) return;
    try { await navigator.clipboard.writeText(item.publicUrl); flash('Ссылка скопирована'); }
    catch { flash('Не удалось скопировать ссылку'); }
    return;
  }
  if (type === 'download-application-qr') {
    const item = adminApplicationDownloads.find((entry) => entry.id === element.dataset.applicationId); if (!item?.svg) return;
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([item.svg], { type: 'image/svg+xml;charset=utf-8' }));
    link.download = `${item.appName.replace(/\s+/g, '-')}-${item.id.slice(0, 8)}.svg`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return;
  }
  if (type === 'revoke-application-download') {
    const id = element.dataset.applicationId ?? ''; if (!id || !confirm('Этот QR-код сразу перестанет работать. Отозвать?')) return;
    try { await apiService.updateApplicationDownload(id, 'revoked'); await loadAdminApplicationDownloads(); flash('QR-код отозван'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось отозвать QR-код'); }
    return;
  }
  if (type === 'confirm-application-install') {
    const id = element.dataset.applicationId ?? ''; if (!id) return;
    try { await apiService.updateApplicationDownload(id, 'installed'); await loadAdminApplicationDownloads(); flash('Установка подтверждена'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось подтвердить установку'); }
    return;
  }
  if (type === 'refresh-admin-orders') { await loadAdminOrders(); flash('Заказы обновлены'); return; }
  if (type === 'refresh-admin-diagnostics') { await loadAdminDiagnostics(); flash('Проверка обновлена'); return; }
  if (type === 'run-security-checks') {
    const button = element as HTMLButtonElement;
    try { button.disabled = true; button.textContent = 'Проверяем…'; await apiService.runSecurityChecks(); await loadAdminSecurity(); flash('Проверка завершена'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось выполнить проверку'); }
    finally { button.disabled = false; }
    return;
  }
  if (type === 'save-telegram-settings') {
    const value = (name: string) => root.querySelector<HTMLInputElement>(`[data-telegram-setting="${name}"]`);
    try {
      await apiService.saveTelegram({ token: value('token')?.value.trim() ?? '', chatId: value('chatId')?.value.trim() ?? '', password: value('password')?.value ?? '', enabled: value('enabled')?.checked === true });
      await loadAdminSecurity(); flash('Настройки Telegram сохранены');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить Telegram'); }
    return;
  }
  if (type === 'test-telegram') {
    try { await apiService.testTelegram(); await loadAdminSecurity(); flash('Тестовое сообщение отправлено'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Не удалось отправить сообщение'); }
    return;
  }
  if (type === 'run-load-test') {
    const button = element as HTMLButtonElement;
    try { button.disabled = true; button.textContent = 'Проверяем…'; await apiService.runLoadTest(); await loadAdminSecurity(); flash('Нагрузочная проверка завершена'); }
    catch (error) { flash(error instanceof Error ? error.message : 'Нагрузочная проверка не выполнена'); }
    finally { button.disabled = false; }
    return;
  }
  if (type === 'run-iiko-smoke') {
    const tableId = root.querySelector<HTMLSelectElement>('[data-security-smoke="tableId"]')?.value ?? '';
    const productId = root.querySelector<HTMLSelectElement>('[data-security-smoke="productId"]')?.value ?? '';
    if (!tableId || !productId) { flash('Выберите тестовый стол и блюдо'); return; }
    if (!confirm('В iiko будет создан помеченный тестовый заказ. Печать кухни отключена. Продолжить?')) return;
    const button = element as HTMLButtonElement;
    try { button.disabled = true; button.textContent = 'Создаём тест…'; await apiService.runIikoSmokeTest(tableId, productId); await loadAdminSecurity(); flash('Smoke-тест iiko пройден'); }
    catch (error) { await loadAdminSecurity(false); render(); flash(error instanceof Error ? error.message : 'Smoke-тест iiko не пройден'); }
    finally { button.disabled = false; }
    return;
  }
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
  if (type === 'create-iiko-front-pairing') { try { const pairing = await apiService.createIikoFrontPairingCode(); adminIikoFront = { ...(adminIikoFront ?? { bridges: [], employees: [] }), pairing }; render(); flash('Код подключения создан на 15 минут'); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось создать код подключения'); } return; }
  if (type === 'revoke-iiko-front-bridge') { try { await apiService.revokeIikoFrontBridge(element.dataset.bridgeId ?? ''); adminIikoFront = await apiService.iikoFront(); waiterProfiles = await apiService.waiters(); render(); flash('Bridge отключён'); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось отключить Bridge'); } return; }
  if (type === 'toggle-iiko-employee') { try { const id = element.dataset.employeeId ?? ''; await apiService.setIikoEmployeeAccess(id, element.dataset.employeeEnabled === 'true'); adminIikoFront = await apiService.iikoFront(); render(); flash('Доступ официанта обновлён'); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось обновить доступ официанта'); } return; }
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
    appStore.set({ productId: id, recentProductIds, ...(fromWelcome ? { category: ALL_MENU_CATEGORY, search: '' } : {}) });
    if (fromWelcome) router.go('menu');
    return;
  }
  if (type === 'close-product') { appStore.set({ productId: null }); return; }
  if (type === 'select-category') {
    menuCategoryScrollLeft = root.querySelector<HTMLElement>('.category-nav')?.scrollLeft ?? menuCategoryScrollLeft;
    appStore.set({ category: element.dataset.category ?? ALL_MENU_CATEGORY, search: '' });
    return;
  }
  if (type === 'open-search') {
    menuSearchOpen = true;
    const searchBox = element.closest<HTMLElement>('.search-box');
    const searchInput = searchBox?.querySelector<HTMLInputElement>('[data-action="search"]');
    searchBox?.classList.add('is-open');
    requestAnimationFrame(() => {
      searchInput?.focus();
      searchInput?.setSelectionRange(searchInput.value.length, searchInput.value.length);
    });
    return;
  }
  if (type === 'close-search') {
    menuSearchOpen = false;
    updateSearch.cancel();
    appStore.set({ search: '' });
    const searchBox = element.closest<HTMLElement>('.search-box');
    const searchInput = searchBox?.querySelector<HTMLInputElement>('[data-action="search"]');
    if (searchInput) searchInput.value = '';
    searchInput?.blur();
    searchBox?.classList.remove('is-open');
    refreshMenuResults();
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
    group?.querySelectorAll<HTMLElement>('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.classList.contains('is-selected')));
    });
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
    transientToast('Добавили всё выбранное в заказ.');
    return;
  }
  if (type === 'select-terminal-settings-section') {
    const section = element.dataset.terminalSettingsTarget ?? 'general';
    sessionStorage.setItem('bb-terminal-settings-section', section);
    root.querySelectorAll<HTMLElement>('[data-terminal-settings-target]').forEach((button) => {
      const active = button.dataset.terminalSettingsTarget === section;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    root.querySelectorAll<HTMLElement>('[data-terminal-settings-section]').forEach((panel) => {
      panel.hidden = panel.dataset.terminalSettingsSection !== section;
    });
    root.querySelector<HTMLElement>('.terminal-settings-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (type === 'save-terminal') {
    const input = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => root.querySelector<T>(`[data-admin-terminal="${name}"]`);
    try {
      const previousDemoMode = appStore.get().terminal?.demoMode ?? false;
      const terminal = await apiService.saveTerminal({ id: apiService.terminalId, label: input<HTMLInputElement>('label')?.value.trim() ?? '', tableId: input<HTMLInputElement>('tableId')?.value.trim() || null, tableNumber: input<HTMLInputElement>('tableNumber')?.value.trim() ?? '', waiterId: input<HTMLSelectElement>('waiterId')?.value.trim() || null, isActive: input<HTMLInputElement>('isActive')?.checked ?? true, demoMode: input<HTMLInputElement>('demoMode')?.checked ?? false, idleSeconds: Number(input<HTMLSelectElement>('idleSeconds')?.value ?? 45) });
      if (terminal.demoMode !== previousDemoMode) appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null, orders: [], selectedOrderId: null, orderNumber: null, statusStep: 0 }, false);
      appStore.set({ terminal }, false);
      await syncServer();
      flash(terminal.demoMode ? 'Демо-киоск включён' : 'Демо-киоск выключен');
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
      flash(guestErrorMessage(error, 'promo'));
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
    if (!changed && Number(element.dataset.delta) > 0) flash('Больше добавить нельзя.');
    return;
  }
  if (type === 'remove-modifier') { orderStore.removeModifier(element.dataset.key!, element.dataset.modifierId!); return; }
  if (type === 'open-service') { appStore.set({ serviceOpen: true }); return; }
  if (type === 'close-service') { appStore.set({ serviceOpen: false }); return; }
  if (type === 'request-service') {
    const serviceType = element.dataset.service ?? '';
    if (!serviceType || pendingServiceRequests.has(serviceType)) return;
    pendingServiceRequests.add(serviceType);
    const button = element.closest<HTMLButtonElement>('button');
    if (button) button.disabled = true;
    waiterService.request(serviceType)
      .then((result) => {
        appStore.set({ serviceOpen: false }, false);
        root.querySelector('.service-overlay')?.remove();
        flash(result.message);
      })
      .catch((error) => {
        if (button) button.disabled = false;
        flash(guestErrorMessage(error, 'service'));
      })
      .finally(() => pendingServiceRequests.delete(serviceType));
    return;
  }
  if (type === 'open-order-status') {
    const orderId = element.dataset.orderId ?? null;
    appStore.set({ selectedOrderId: orderId, orderNumber: orderId });
    router.go('status');
    return;
  }
  if (type === 'new-order') {
    appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null });
    router.go('menu');
    return;
  }
  if (type === 'submit-order') {
    if (!orderStore.count()) { router.go('menu'); flash('Сначала выберите блюда в меню.'); return; }
    if (submittingOrder) return;
    submittingOrder = true;
    const button = element as HTMLButtonElement;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'ПЕРЕДАЁМ ЗАКАЗ НА КУХНЮ…';
    try {
      await orderService.submit();
      // Keep the submitted order state intact while clearing the cart before
      // opening the live status screen.
      appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null }, false);
      router.go('status');
    } catch (error) {
      button.disabled = false;
      button.textContent = originalLabel;
      flash(guestErrorMessage(error, 'order'));
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
    } catch (error) { flash(guestErrorMessage(error)); }
    return;
  }
  if (type === 'continue-order') { appStore.set({ inactivityWarning: false, inactivitySeconds: 15 }); resetInactivity(); return; }
  if (type === 'cancel-order') { finishInactiveSession(); return; }
  if (type === 'toggle-language') { const language = appStore.get().language === 'en' ? 'ru' : 'en'; appStore.set({ language }); flash(language === 'en' ? 'English selected' : 'Выбран русский язык'); }
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
      inactivityWarning: false,
      inactivitySeconds: 15,
    });
  } else {
    appStore.resetOrder();
  }
  router.go(apiService.isQrMode() ? 'menu' : 'welcome');
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

async function performServerSync() {
  try {
    const previous = appStore.get();
    const data = await apiService.bootstrap();
    currentCatalogRevision = data.catalogRevision;
    consecutiveBootstrapFailures = 0;
    const nextCatalogSnapshot = JSON.stringify({ products: data.products, categories: data.categories });
    const catalogChanged = nextCatalogSnapshot !== catalogSnapshot;
    if (catalogChanged) {
      setCatalog(data.products, data.categories);
      catalogSnapshot = nextCatalogSnapshot;
    }
    if (!imageCacheService.isRunning()) adminImageCacheState = imageCacheService.state(imageSources(data.products, data.banners));
    const selectedOrderStillActive = previous.selectedOrderId
      ? data.orders.some((order) => order.id === previous.selectedOrderId)
      : false;
    const selectedOrderWasClosed = Boolean(previous.selectedOrderId) && !selectedOrderStillActive;
    const selectedOrderId = selectedOrderStillActive ? previous.selectedOrderId : data.orders[0]?.id ?? null;
    const category = menuService.hasCategory(previous.category) ? previous.category : ALL_MENU_CATEGORY;
    const nextBootstrapSnapshot = JSON.stringify({ banners: data.banners, display: data.display, terminal: data.terminal, orders: data.orders, selectedOrderId, category });
    const stateChanged = nextBootstrapSnapshot !== bootstrapSnapshot;
    const connectionRestored = !previous.isOnline;
    if (stateChanged || connectionRestored || catalogChanged) {
      bootstrapSnapshot = nextBootstrapSnapshot;
      appStore.set({ banners: data.banners, productDisplay: data.display, terminal: data.terminal, inactivitySeconds: data.terminal.idleSeconds, orders: data.orders, selectedOrderId, orderNumber: selectedOrderId, category, isOnline: true });
    }
    if (selectedOrderWasClosed && !data.orders.length) {
      appStore.set({ cart: [], comment: '', promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null, serviceOpen: false, orderNumber: null, selectedOrderId: null, statusStep: 0 });
      if (router.current() === 'status' || router.current() === 'orders') router.go(apiService.isQrMode() ? 'menu' : 'welcome');
    }
    if (imageCacheService.autoUpdate() && !imageCacheService.isRunning() && Date.now() - lastAutomaticImageSync > 5 * 60_000) {
      lastAutomaticImageSync = Date.now();
      void runImageCacheSync(false, false);
    }
  } catch (error) {
    console.warn('Server bootstrap unavailable', error);
    consecutiveBootstrapFailures += 1;
    if (consecutiveBootstrapFailures >= 2 && appStore.get().isOnline) appStore.set({ isOnline: false });
  }
}

async function refreshCatalogRevision() {
  try {
    const { revision } = await apiService.catalogRevision();
    if (!currentCatalogRevision) { currentCatalogRevision = revision; return; }
    if (revision !== currentCatalogRevision) await syncServer();
  } catch {
    // The normal bootstrap retry owns the offline banner. A failed lightweight
    // check is retried silently and must never redraw the guest interface.
  }
}

async function syncServer(includeAudit = false) {
  if (!syncServerTask) {
    syncServerTask = performServerSync().finally(() => { syncServerTask = null; });
  }
  await syncServerTask;
  if (includeAudit) {
    if (!auditSyncTask) auditSyncTask = apiService.audit().then((items) => { auditLog = items; }).finally(() => { auditSyncTask = null; });
    await auditSyncTask;
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
  inactivityTimer = window.setTimeout(() => {
    const currentRoute = router.current();
    if (currentRoute === 'welcome' || currentRoute === 'status' || currentRoute === 'orders' || currentRoute === 'admin') return;
    // Never return to the welcome screen without an explicit warning. This
    // protects both an empty browse session and a cart that already has items.
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

export async function startApp() {
  root.addEventListener('scroll', (event) => {
    const target = event.target as HTMLElement;
    if (target.classList?.contains('category-nav')) menuCategoryScrollLeft = target.scrollLeft;
  }, true);
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
  addEventListener('online', () => {
    clearTimeout(offlineTimer);
    consecutiveBootstrapFailures = 0;
    if (!appStore.get().isOnline) appStore.set({ isOnline: true });
    flash('Связь восстановлена — можно продолжать.');
  });
  addEventListener('offline', () => {
    clearTimeout(offlineTimer);
    offlineTimer = window.setTimeout(() => {
      if (!navigator.onLine && appStore.get().isOnline) appStore.set({ isOnline: false });
    }, 4_000);
  });
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  appStore.subscribe(render);
  router.start(render);
  void otaService.markReady();
  void loadCurrentAppVersion(false);
  const qrToken = new URLSearchParams(location.search).get('qr');
  if (qrToken) {
    root.innerHTML = '<section class="qr-entry-loading"><i></i><span>ГОТОВИМ МЕНЮ</span><p>Подключаем заказ к вашему столу…</p></section>';
    try {
      const previousQr = sessionStorage.getItem('bb-qr-token');
      if (previousQr !== qrToken) {
        appStore.set({ cart: [], comment: '', orders: [], selectedOrderId: null, orderNumber: null, promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null }, false);
      }
      await apiService.activateQr(qrToken);
      sessionStorage.setItem('bb-qr-token', qrToken);
      await syncServer();
      if (router.current() === 'welcome' || router.current() === 'table' || router.current() === 'admin') router.go('menu');
      else render();
    } catch (error) {
      qrStartupError = guestErrorMessage(error, 'qr');
      render();
    }
  } else {
    render();
    void syncServer();
  }
  resetInactivity();
}
