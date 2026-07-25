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
import { paymentPage } from './pages/payment';
import { statusPage } from './pages/status';
import { welcomePage } from './pages/welcome';
import { adminPage } from './pages/admin';
import { debounce, formatPrice } from './utils/helpers';
import { marketingService } from './services/marketing-service';
import { applyLanguage } from './services/i18n';
import { otaService } from './services/ota-service';
import type { Product } from './types/menu';
import brand from './config/brand.json';

const root = document.querySelector<HTMLDivElement>('#app')!;
let inactivityTimer = 0;
let inactivityCountdown = 0;
let adminTaps = 0;
let lastAdminTap = 0;
let submittingOrder = false;
let promoSwipeStart: { x: number; y: number } | null = null;
let suppressPromoOpenUntil = 0;
let auditLog: Array<{ action: string; entity: string; entity_id: string; created_at: string }> = [];
const updateSearch = debounce((value: string) => {
  appStore.set({ search: value }, false);
  refreshMenuResults();
}, 180);
const updateComment = debounce((value: string) => appStore.set({ comment: value }, false), 180);

function page() {
  const state = appStore.get();
  const route = router.current();
  switch (route) {
    case 'welcome': return welcomePage(menuService.featured(), state.promotions, menuService.all(), state.productDisplay, state.terminal);
    case 'menu': return menuPage(menuService.categories(), menuService.search(state.search, state.category), state.category, state.search, menuService.recent(state.recentProductIds), state.productDisplay);
    case 'order': return orderPage(orderStore.lines(), orderStore.product, orderStore.subtotal(), orderStore.discount(), orderStore.total(), state.comment, state.promoCode);
    case 'orders': return ordersPage(state.orders);
    case 'payment': return paymentPage(orderStore.lines(), orderStore.product, orderStore.subtotal(), orderStore.discount(), orderStore.total(), state.comment);
    case 'status': {
      const order = state.orders.find((item) => item.id === state.selectedOrderId);
      return statusPage(order, order?.id ?? state.orderNumber, order?.statusStep ?? state.statusStep, orderStore.product);
    }
    case 'admin': return state.adminAuthenticated ? adminPage(menuService.all(), state.promotions, state.productDisplay, state.terminal, state.adminTab, state.adminProductId, auditLog) : welcomePage(menuService.featured(), state.promotions, menuService.all(), state.productDisplay, state.terminal);
  }
}

const adminLogin = (open: boolean) => open ? `<div class="overlay admin-login-overlay"><section class="admin-login"><button class="modal__close" data-action="close-admin-login">${iconMarkup('close')}</button><span class="eyebrow">СЛУЖЕБНЫЙ ВХОД</span><h2>Введите пароль</h2><p>Доступ только для сотрудников.</p><input type="password" inputmode="numeric" data-admin-password placeholder="Пароль" autocomplete="off"><button class="button button--primary button--wide" data-action="login-admin">Войти</button></section></div>` : '';
const inactivityPrompt = (open: boolean, seconds: number) => open ? `<div class="overlay inactivity-overlay"><section class="inactivity-dialog">
  <img class="inactivity-dialog__character" src="/images/inactivity-character.png" alt="" aria-hidden="true">
  <div class="inactivity-dialog__glow"></div><div class="inactivity-dialog__brand"><img src="${brand.logo}" alt="Brooklyn Bowl"></div>
  <div class="inactivity-dialog__timer"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="53"></circle><circle class="inactivity-dialog__progress" cx="60" cy="60" r="53"></circle></svg><strong data-inactivity-countdown>${seconds}</strong><small>СЕК</small></div>
  <span class="eyebrow">ВАШ ЗАКАЗ ПРИОСТАНОВЛЕН</span><h2>Вы ещё здесь?</h2><p>Продолжите оформление или заказ автоматически очистится для следующего гостя.</p>
  <div class="inactivity-dialog__actions"><button class="button button--primary button--wide" data-action="continue-order">Да, продолжить заказ</button><button class="inactivity-dialog__cancel" data-action="cancel-order">Завершить и очистить</button></div>
</section></div>` : '';
const iconMarkup = (name: string) => name === 'close' ? '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg>' : '';

export function render() {
  const state = appStore.get();
  const route = router.current();
  if (route === 'admin' && !state.adminAuthenticated) { router.go('welcome'); return; }
  if (route === 'payment' && !orderStore.count()) { router.go('menu'); return; }
  if (route === 'status' && !state.selectedOrderId && !state.orderNumber) { router.go('orders'); return; }
  root.innerHTML = appShell(page(), route) + serviceSheet(state.serviceOpen) + productModal(state.productId ? menuService.find(state.productId) : undefined, state.productId ? state.productDisplay[state.productId] : undefined, state.productDisplay) + upsellSheet(state.upsellId ? menuService.find(state.upsellId) : undefined) + adminLogin(state.adminLoginOpen) + inactivityPrompt(state.inactivityWarning, state.inactivitySeconds) + (!state.isOnline ? '<div class="network-banner">Нет сети. Доступны ранее загруженные данные.</div>' : '') + (state.pwaUpdateReady ? '<button class="pwa-update" data-action="refresh-app">Доступно обновление. Обновить</button>' : '') + (state.toast ? `<div class="toast">${state.toast}</div>` : '');
  const product = state.productId ? menuService.find(state.productId) : undefined;
  const related = root.querySelector<HTMLElement>('[data-related-for]');
  if (product && related) related.innerHTML = relatedCards(menuService.related(product), state.productDisplay);
  applyLanguage(root, state.language);
  resetInactivity();
}

function updateModalTotal() {
  const product = menuService.find(appStore.get().productId ?? '');
  if (!product) return;
  const saucePrice = Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0;
  const sauceItems = [...root.querySelectorAll<HTMLElement>('.option-group[data-multiple="true"] button.is-selected')];
  const sauceCount = sauceItems.length;
  const relatedItems = [...root.querySelectorAll<HTMLElement>('.related-choice.is-selected')];
  const selectedOptions = [...root.querySelectorAll<HTMLElement>('.option-group[data-multiple="false"] button.is-selected')]
    .map((item) => `${item.dataset.option}: ${item.dataset.value}`);
  const relatedTotal = relatedItems.reduce((sum, item) => sum + Number(item.dataset.price ?? 0), 0);
  const quantity = Number(root.querySelector<HTMLElement>('[data-modal-quantity]')?.textContent ?? 1);
  const sauceTotal = sauceCount * saucePrice;
  const total = root.querySelector<HTMLElement>('[data-modal-total]');
  if (total) total.textContent = formatPrice(product.price_rub * quantity + sauceTotal + relatedTotal);
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
  setText('[data-summary-options-label]', selectedOptions.join(' · '));
  root.querySelector<HTMLElement>('[data-summary-options-row]')?.toggleAttribute('hidden', selectedOptions.length === 0);
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

function selectPromo(index: number) {
  const promos = [...root.querySelectorAll<HTMLElement>('.welcome-promo')];
  if (!promos.length) return;
  const next = ((index % promos.length) + promos.length) % promos.length;
  promos.forEach((promo, itemIndex) => promo.classList.toggle('is-manual-active', itemIndex === next));
  root.querySelectorAll<HTMLElement>('.welcome-promo__dots button').forEach((dot, itemIndex) => dot.classList.toggle('is-active', itemIndex === next));
  root.querySelector<HTMLElement>('.welcome-showcase__promos')?.classList.add('is-manual');
}

function transientToast(message: string) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  root.append(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

async function action(element: HTMLElement) {
  const type = element.dataset.action;
  if (!type) return;
  if (type === 'navigate') { router.go(element.dataset.route as never); return; }
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
    try {
      await apiService.login(password);
      await syncServer(true);
      appStore.set({ adminAuthenticated: true, adminLoginOpen: false });
      router.go('admin');
    } catch (error) { flash(error instanceof Error ? error.message : 'Неверный пароль'); }
    return;
  }
  if (type === 'logout-admin') { apiService.logout(); appStore.set({ adminAuthenticated: false, adminTab: 'terminal' }); router.go('welcome'); return; }
  if (type === 'select-admin-tab') {
    const adminTab = element.dataset.adminTab as 'terminal' | 'menu' | 'stock' | 'promotions' | 'quality' | 'audit';
    appStore.set({ adminTab });
    if (adminTab === 'audit') apiService.audit().then((items) => { auditLog = items; render(); }).catch((error) => flash(error.message));
    return;
  }
  if (type === 'toggle-fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => flash('Полноэкранный режим недоступен в этом браузере'));
    return;
  }
  if (type === 'refresh-app') {
    navigator.serviceWorker?.getRegistration().then((registration) => registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    location.reload();
    return;
  }
  if (type === 'promo-slide') { selectPromo(Number(element.dataset.promoIndex ?? 0)); return; }
  if (type === 'open-product') {
    if (Date.now() < suppressPromoOpenUntil) return;
    const id = element.dataset.productId ?? null;
    const recentProductIds = id ? [id, ...appStore.get().recentProductIds.filter((item) => item !== id)].slice(0, 8) : appStore.get().recentProductIds;
    const fromWelcome = router.current() === 'welcome';
    appStore.set({ productId: id, upsellId: null, recentProductIds, ...(fromWelcome ? { category: 'Все блюда', search: '' } : {}) });
    if (fromWelcome) router.go('menu');
    return;
  }
  if (type === 'close-product') { appStore.set({ productId: null }); return; }
  if (type === 'select-category') { appStore.set({ category: element.dataset.category ?? 'Все блюда', search: '' }); return; }
  if (type === 'set-option') {
    const group = element.closest('.option-group');
    if (group?.getAttribute('data-multiple') === 'true') element.classList.toggle('is-selected');
    else {
      group?.querySelectorAll('button').forEach((button) => button.classList.remove('is-selected'));
      element.classList.add('is-selected');
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
    orderStore.addBundle(product, { addon: valueAt('Добавки'), flavor: valueAt('Вкус') }, sauces, related, quantity);
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
      const terminal = await apiService.saveTerminal({ id: apiService.terminalId, label: input<HTMLInputElement>('label')?.value.trim() ?? '', tableNumber: input<HTMLInputElement>('tableNumber')?.value.trim() ?? '', isActive: input<HTMLInputElement>('isActive')?.checked ?? true, idleSeconds: Number(input<HTMLSelectElement>('idleSeconds')?.value ?? 45) });
      appStore.set({ terminal }); flash('Настройка терминала сохранена');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить терминал'); }
    return;
  }
  if (type === 'save-product') {
    const id = element.dataset.productId!;
    const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string) => root.querySelector<T>(`[data-admin-product="${name}"]`);
    const values = (name: string) => (input<HTMLInputElement>(name)?.value ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    try {
      const pairs = [...(input<HTMLSelectElement>('pairs')?.selectedOptions ?? [])].map((option) => option.value);
      const calories = input<HTMLInputElement>('calories')?.value.trim() ?? '';
      const result = await apiService.saveProduct(id, { name: input<HTMLInputElement>('name')?.value.trim(), category: input<HTMLInputElement>('category')?.value.trim(), price_rub: Number(input<HTMLInputElement>('price_rub')?.value ?? 0), portion: input<HTMLInputElement>('portion')?.value.trim(), unit: input<HTMLSelectElement>('unit')?.value.trim(), description: input<HTMLTextAreaElement>('description')?.value.trim() || null, image: input<HTMLInputElement>('image')?.value.trim(), allergens: input<HTMLInputElement>('allergens')?.value.trim(), spicy: input<HTMLSelectElement>('spicy')?.value as 'none' | 'mild' | 'hot', unavailable: input<HTMLInputElement>('unavailable')?.checked, badge: input<HTMLSelectElement>('badge')?.value.trim(), kbju: calories ? { calories, protein: input<HTMLInputElement>('protein')?.value.trim() ?? '', fat: input<HTMLInputElement>('fat')?.value.trim() ?? '', carbs: input<HTMLInputElement>('carbs')?.value.trim() ?? '' } : null, sauce_options: values('sauces'), sauce_addon_price_rub: input<HTMLInputElement>('saucePrice')?.value.trim() || undefined, addon_options: values('addons'), flavor_options: values('flavors'), pairs_with: pairs });
      applyServerProduct(result.product, result.display); flash('Карточка блюда сохранена');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось сохранить блюдо'); }
    return;
  }
  if (type === 'toggle-product-stock') {
    const product = menuService.find(element.dataset.productId!);
    if (!product) return;
    try {
      const result = await apiService.saveProduct(product.id, { unavailable: !appStore.get().productDisplay[product.id]?.unavailable });
      applyServerProduct(result.product, result.display); flash(result.display.unavailable ? `${product.name}: в стоп-листе` : `${product.name}: возвращено в меню`);
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось изменить стоп-лист'); }
    return;
  }
  if (type === 'create-promotion') {
    const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string) => root.querySelector<T>(`[data-admin-promo="${name}"]`);
    try {
      const productId = input<HTMLSelectElement>('productId')?.value ?? '';
      const product = menuService.find(productId);
      const promotion = await apiService.createPromotion({ productId, title: input<HTMLInputElement>('title')?.value.trim() || product?.name || '', subtitle: input<HTMLTextAreaElement>('subtitle')?.value.trim() || product?.description || '', label: input<HTMLInputElement>('label')?.value.trim() || 'СПЕЦПРЕДЛОЖЕНИЕ', active: true });
      appStore.set({ promotions: [...appStore.get().promotions, promotion] }); flash('Акция добавлена');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось добавить акцию'); }
    return;
  }
  if (type === 'toggle-promotion-server') {
    const promotion = appStore.get().promotions.find((item) => item.id === element.dataset.promotionId);
    if (!promotion) return;
    try { const saved = await apiService.savePromotion({ ...promotion, active: !promotion.active }); appStore.set({ promotions: appStore.get().promotions.map((item) => item.id === saved.id ? saved : item) }); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось изменить акцию'); }
    return;
  }
  if (type === 'delete-promotion-server') {
    const id = element.dataset.promotionId!;
    try { await apiService.deletePromotion(id); appStore.set({ promotions: appStore.get().promotions.filter((item) => item.id !== id) }); flash('Акция удалена'); } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось удалить акцию'); }
    return;
  }
  if (type === 'save-promotion') {
    const value = (name: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-admin-input="${name}"]`)?.value.trim() ?? '';
    const product = menuService.find(value('product'));
    if (!product) return;
    const promotion = { id: `promo-${crypto.randomUUID()}`, productId: product.id, title: value('title') || product.name, subtitle: value('subtitle') || product.description || product.name, label: value('label') || 'СПЕЦПРЕДЛОЖЕНИЕ', active: true };
    appStore.set({ promotions: [promotion, ...appStore.get().promotions] });
    flash('Баннер добавлен на welcome-экран');
    return;
  }
  if (type === 'toggle-promotion') {
    const id = element.dataset.promotionId!;
    appStore.set({ promotions: appStore.get().promotions.map((promotion) => promotion.id === id ? { ...promotion, active: !promotion.active } : promotion) });
    return;
  }
  if (type === 'delete-promotion') {
    appStore.set({ promotions: appStore.get().promotions.filter((promotion) => promotion.id !== element.dataset.promotionId) });
    return;
  }
  if (type === 'apply-promo') {
    const code = root.querySelector<HTMLInputElement>('[data-action="set-promo"]')?.value.trim().toUpperCase() ?? '';
    appStore.set({ promoCode: code });
    flash(code === 'BOWL10' ? 'Промокод применён: скидка 10%' : 'Промокод не найден. Попробуйте BOWL10');
    return;
  }
  if (type === 'reset-promotions') { appStore.set({ promotions: marketingService.defaults() }); flash('Тестовые баннеры восстановлены'); return; }
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
  if (type === 'open-service') { appStore.set({ serviceOpen: true }); return; }
  if (type === 'close-service') { appStore.set({ serviceOpen: false }); return; }
  if (type === 'request-service') { waiterService.request(element.dataset.service ?? '').then((result) => { appStore.set({ serviceOpen: false }); flash(result.message); }); return; }
  if (type === 'open-order-status') {
    const orderId = element.dataset.orderId ?? null;
    appStore.set({ selectedOrderId: orderId, orderNumber: orderId });
    router.go('status');
    return;
  }
  if (type === 'submit-order') {
    if (!orderStore.count()) { router.go('menu'); flash('Добавьте блюда в заказ'); return; }
    if (submittingOrder) return;
    submittingOrder = true;
    try {
      await orderService.submit();
      appStore.set({ cart: [], comment: '', promoCode: '' });
      router.go('status');
    } catch (error) { flash(error instanceof Error ? error.message : 'Не удалось отправить заказ'); }
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
  target.innerHTML = menuResults(menuService.search(state.search, state.category), state.category, state.search, menuService.recent(state.recentProductIds), state.productDisplay);
}

async function syncServer(includeAudit = false) {
  try {
    const data = await apiService.bootstrap();
    setCatalog(data.products);
    appStore.set({ promotions: data.promotions, productDisplay: data.display, terminal: data.terminal, inactivitySeconds: data.terminal.idleSeconds, orders: data.orders, selectedOrderId: appStore.get().selectedOrderId ?? data.orders[0]?.id ?? null, orderNumber: appStore.get().orderNumber ?? data.orders[0]?.id ?? null });
    appStore.set({ isOnline: true }, false);
    if (includeAudit) auditLog = await apiService.audit();
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
    resetInactivity();
  });
  root.addEventListener('change', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target) action(target);
    const productSelect = event.target as HTMLSelectElement;
    if (productSelect.matches('[data-admin-product-select]')) appStore.set({ adminProductId: productSelect.value });
    resetInactivity();
  });
  root.addEventListener('touchstart', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.welcome-showcase__promos')) return;
    const touch = event.touches[0];
    if (touch) promoSwipeStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });
  root.addEventListener('touchend', (event) => {
    if (!promoSwipeStart) return;
    const target = event.target as HTMLElement;
    const touch = event.changedTouches[0];
    const start = promoSwipeStart;
    promoSwipeStart = null;
    if (!touch || !target.closest('.welcome-showcase__promos')) return;
    const distanceX = touch.clientX - start.x;
    const distanceY = touch.clientY - start.y;
    if (Math.abs(distanceX) < 42 || Math.abs(distanceX) < Math.abs(distanceY)) return;
    const current = [...root.querySelectorAll('.welcome-promo')].findIndex((promo) => promo.classList.contains('is-manual-active'));
    selectPromo((current < 0 ? 0 : current) + (distanceX < 0 ? 1 : -1));
    suppressPromoOpenUntil = Date.now() + 450;
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
  void syncServer();
}
