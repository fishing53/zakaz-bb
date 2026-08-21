import './style.css';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { icon } from '../../src/components/icons';

const api = 'https://order.brooklynbowl.ru/api/v1';
const root = document.querySelector<HTMLDivElement>('#app')!;

type WaiterView = 'calls' | 'orders';
type Request = { id: number; table_number: string; request_type: string; status: string; created_at: string };
type OrderModifier = { productId?: string; name?: string; amount?: number; price?: number };
type OrderLine = { productId?: string; customName?: string; customPrice?: number; quantity?: number; modifiers?: OrderModifier[] };
type Order = { order_number: string; table_number: string; items: OrderLine[]; comment?: string; total: number; status_step: number; created_at: string; source: string };
type WaiterProfile = { id: string; name: string };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let token = localStorage.getItem('bb-waiter-token') ?? '';
let initialized = false;
let known = new Set<string>();
let pushInitialized = false;
let activeView: WaiterView = 'calls';
let currentRequests: Request[] = [];
let currentOrders: Order[] = [];
let lastRenderKey = '';
let queueTask: Promise<void> | null = null;
let activeAlertId: number | null = null;
let loginRendered = false;
let waiterProfile: WaiterProfile | null = (() => { try { return JSON.parse(localStorage.getItem('bb-waiter-profile') || 'null') as WaiterProfile | null; } catch { return null; } })();
let pushDeviceToken = localStorage.getItem('bb-waiter-device-token') ?? '';
let webPushEndpoint = localStorage.getItem('bb-waiter-web-push-endpoint') ?? '';
let webPushState: 'idle' | 'enabling' | 'enabled' | 'denied' | 'unsupported' | 'error' = 'idle';
let connectionState: 'connecting' | 'online' | 'offline' = 'connecting';
let lastUpdatedAt: Date | null = null;
let profileOpen = false;
let currentAppVersion = '';
let otaState: { phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'error'; version: string; progress: number } = { phase: 'idle', version: '', progress: 0 };
const bundledVersion = import.meta.env.VITE_BUILD_VERSION || '0.1.0';
const isStandalonePwa = () => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

async function waiterServiceWorker() {
  if (Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/waiter/service-worker.js', { scope: '/waiter/', updateViaCache: 'none' });
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function paintWebPushState() {
  const status = root.querySelector<HTMLElement>('[data-push-status]');
  const button = root.querySelector<HTMLButtonElement>('[data-action="profile-push"]');
  if (!status || !button) return;
  const labels = {
    idle: isStandalonePwa() ? 'Нажмите, чтобы получать вызовы на iPhone' : 'Сначала установите приложение на экран «Домой»',
    enabling: 'Подключаем уведомления…',
    enabled: 'Уведомления включены',
    denied: 'Уведомления запрещены в настройках iPhone',
    unsupported: 'Уведомления недоступны в этом браузере',
    error: 'Не удалось подключить уведомления',
  } as const;
  status.textContent = labels[webPushState];
  button.textContent = webPushState === 'enabled' ? 'Включены' : webPushState === 'enabling' ? 'Подключаем…' : 'Включить';
  button.disabled = webPushState === 'enabled' || webPushState === 'enabling' || !isStandalonePwa();
}

function paintProfileUpdate() {
  const status = root.querySelector<HTMLElement>('[data-update-status]');
  const button = root.querySelector<HTMLButtonElement>('[data-action="profile-update"]');
  if (!status || !button) return;
  const labels = {
    idle: `Установлена версия ${currentAppVersion || bundledVersion}`,
    checking: 'Проверяем доступную версию…',
    current: `Установлена актуальная версия ${currentAppVersion || bundledVersion}`,
    available: `Доступна версия ${otaState.version}`,
    downloading: `Загружаем обновление — ${otaState.progress}%`,
    error: 'Не удалось проверить или загрузить обновление',
  } as const;
  status.textContent = labels[otaState.phase];
  button.textContent = otaState.phase === 'available' ? 'Установить' : otaState.phase === 'downloading' ? `${otaState.progress}%` : otaState.phase === 'checking' ? 'Проверяем…' : otaState.phase === 'error' ? 'Повторить' : 'Проверить обновление';
  button.disabled = otaState.phase === 'checking' || otaState.phase === 'downloading';
}

async function checkWaiterUpdate() {
  if (!Capacitor.isNativePlatform()) {
    otaState = { phase: 'current', version: bundledVersion, progress: 0 };
    currentAppVersion = bundledVersion;
    paintProfileUpdate();
    return;
  }
  otaState = { phase: 'checking', version: '', progress: 0 };
  paintProfileUpdate();
  try {
    const [current, latest] = await Promise.all([CapacitorUpdater.current(), CapacitorUpdater.getLatest()]);
    currentAppVersion = !current.bundle.version || current.bundle.version === 'builtin' ? bundledVersion : current.bundle.version;
    const available = Boolean(latest.version && latest.version !== 'builtin' && latest.url && latest.error !== 'no_new_version_available' && currentAppVersion !== latest.version);
    otaState = available ? { phase: 'available', version: latest.version, progress: 0 } : { phase: 'current', version: currentAppVersion, progress: 0 };
  } catch {
    otaState = { phase: 'error', version: '', progress: 0 };
  }
  paintProfileUpdate();
}

async function installWaiterUpdate() {
  if (!Capacitor.isNativePlatform() || otaState.phase === 'downloading') return;
  otaState = { ...otaState, phase: 'downloading', progress: 0 };
  paintProfileUpdate();
  const listener = await CapacitorUpdater.addListener('download', ({ percent }) => {
    otaState.progress = Math.max(0, Math.min(100, Math.round(percent)));
    paintProfileUpdate();
  });
  try {
    const latest = await CapacitorUpdater.getLatest();
    if (!latest.version || !latest.url) throw new Error('No update');
    const bundle = await CapacitorUpdater.download({ url: latest.url, version: latest.version, sessionKey: latest.sessionKey, checksum: latest.checksum, manifest: latest.manifest });
    await CapacitorUpdater.set({ id: bundle.id });
  } catch {
    otaState = { ...otaState, phase: 'error' };
    paintProfileUpdate();
  } finally {
    await listener.remove();
  }
}

const request = async <T>(path: string, init: RequestInit = {}) => {
  try {
    const method = String(init.method ?? 'GET').toUpperCase();
    const hasBody = init.body !== undefined && init.body !== null;
    const headers = { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (Capacitor.isNativePlatform()) {
      let data: unknown = init.body;
      if (typeof init.body === 'string') { try { data = JSON.parse(init.body); } catch { data = init.body; } }
      const response = await CapacitorHttp.request({ url: `${api}${path}`, method, headers, ...(hasBody ? { data } : {}), connectTimeout: 10_000, readTimeout: 20_000 });
      const body = typeof response.data === 'string' ? JSON.parse(response.data || '{}') : (response.data ?? {});
      if (response.status < 200 || response.status >= 300) throw new ApiError(body?.error ?? 'Ошибка сервера', response.status);
      return body as T;
    }
    const response = await fetch(`${api}${path}`, { ...init, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body.error ?? 'Ошибка сервера', response.status);
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Нет соединения с сервером', 0);
  }
};

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (symbol) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[symbol]!);

const requestTitles: Record<string, string> = {
  waiter: 'Позвали официанта',
  bill: 'Попросили счёт',
  cutlery: 'Попросили приборы',
  help: 'Нужна помощь',
};
const orderStatuses = ['Принят', 'На кухне', 'Готовится', 'Готов', 'Подан'];
const time = (value: string) => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const money = (value: number) => `${new Intl.NumberFormat('ru-RU').format(Number(value) || 0)} ₽`;

const sound = () => {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.12;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    setTimeout(() => { oscillator.frequency.value = 1175; }, 180);
    setTimeout(() => { oscillator.stop(); void context.close(); }, 520);
  } catch { /* Native notification sound is used when WebAudio is unavailable. */ }
};

async function enablePush() {
  if (pushInitialized || !token) return;
  if (!Capacitor.isNativePlatform()) return enableWebPush(false);
  pushInitialized = true;
  try {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return;
    await PushNotifications.createChannel({
      id: 'bb_waiter_urgent',
      name: 'Срочные вызовы BrooklynBowl',
      description: 'Новые заказы и вызовы гостей',
      importance: 5,
      visibility: 1,
      sound: 'default',
      vibration: true,
      lights: true,
      lightColor: '#f43131',
    });
    await PushNotifications.addListener('registration', async ({ value }) => {
      try {
        pushDeviceToken = value;
        localStorage.setItem('bb-waiter-device-token', value);
        await request('/waiter/devices', { method: 'POST', body: JSON.stringify({ token: value, platform: 'android' }) });
      } catch { /* Queue polling remains available if device registration fails. */ }
    });
    await PushNotifications.addListener('registrationError', () => { pushInitialized = false; });
    await PushNotifications.addListener('pushNotificationReceived', async () => { sound(); await queue(); });
    await PushNotifications.addListener('pushNotificationActionPerformed', async () => { await queue(); });
    await PushNotifications.register();
  } catch {
    pushInitialized = false;
  }
}

async function enableWebPush(interactive: boolean) {
  if (!token || Capacitor.isNativePlatform()) return;
  if (!isStandalonePwa()) {
    webPushState = 'idle';
    paintWebPushState();
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    webPushState = 'unsupported';
    paintWebPushState();
    return;
  }
  if (Notification.permission === 'denied') {
    webPushState = 'denied';
    paintWebPushState();
    return;
  }
  if (Notification.permission === 'default' && !interactive) return;
  webPushState = 'enabling';
  paintWebPushState();
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      webPushState = permission === 'denied' ? 'denied' : 'idle';
      paintWebPushState();
      return;
    }
    const config = await request<{ enabled: boolean; publicKey: string }>('/waiter/push-config');
    if (!config.enabled || !config.publicKey) throw new Error('Web Push is not configured');
    const registration = await waiterServiceWorker();
    if (!registration) throw new Error('Service Worker is unavailable');
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
    await request('/waiter/web-push-subscriptions', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    webPushEndpoint = subscription.endpoint;
    localStorage.setItem('bb-waiter-web-push-endpoint', webPushEndpoint);
    pushInitialized = true;
    webPushState = 'enabled';
  } catch {
    webPushState = 'error';
  }
  paintWebPushState();
}

function login() {
  if (loginRendered) return;
  loginRendered = true;
  const install = !Capacitor.isNativePlatform() && !isStandalonePwa() ? `<aside class="pwa-install"><strong>Установите приложение</strong><p>${isIos() ? 'Откройте эту страницу в Safari, нажмите «Поделиться» и выберите «На экран Домой».' : 'Откройте меню браузера и выберите «Установить приложение».'}</p></aside>` : '';
  root.innerHTML = `<section class="login"><div class="login__mark">BB</div><span>ПРИЛОЖЕНИЕ ДЛЯ КОМАНДЫ</span><h1>Официант</h1><p>Введите персональный PIN-код</p><input inputmode="numeric" type="password" maxlength="8" placeholder="PIN" autocomplete="current-password" autofocus><button data-action="login">Войти</button>${install}</section>`;
  const input = root.querySelector<HTMLInputElement>('input')!;
  const submit = async () => {
    try {
      const response = await request<{ token: string; waiter: WaiterProfile }>('/waiter/login', {
        method: 'POST',
        body: JSON.stringify({ pin: input.value }),
      });
      token = response.token;
      waiterProfile = response.waiter;
      loginRendered = false;
      localStorage.setItem('bb-waiter-token', token);
      localStorage.setItem('bb-waiter-profile', JSON.stringify(response.waiter));
      initialized = false;
      lastRenderKey = '';
      await enablePush();
      await queue();
    } catch (error) {
      input.classList.add('is-invalid');
      input.value = '';
      input.placeholder = error instanceof Error ? error.message : 'Неверный PIN';
      input.focus();
    }
  };
  root.querySelector<HTMLButtonElement>('[data-action="login"]')!.onclick = submit;
  input.onkeydown = (event) => { if (event.key === 'Enter') void submit(); };
}

function callCard(item: Request) {
  const action = item.status === 'new'
    ? `<button data-accept-id="${item.id}">Принять</button>`
    : item.status === 'accepted'
      ? `<button data-start-id="${item.id}">В путь</button>`
      : `<button class="button-secondary" data-complete-id="${item.id}">Выполнено</button>`;
  return `<article class="task ${item.status === 'new' ? 'is-new' : ''}" data-created-at="${escapeHtml(item.created_at)}" data-status="${escapeHtml(item.status)}"><header class="task__meta"><span>СТОЛ №${escapeHtml(item.table_number)}</span><time data-wait-time>Сейчас</time></header><h2>${escapeHtml(requestTitles[item.request_type] ?? item.request_type)}</h2>${action}</article>`;
}

function orderItems(item: Order) {
  const rows = Array.isArray(item.items) ? item.items : [];
  return rows.map((line) => {
    const quantity = Math.max(1, Number(line.quantity) || 1);
    const modifiers = Array.isArray(line.modifiers) ? line.modifiers : [];
    const modifierText = modifiers.map((modifier) => `${escapeHtml(modifier.name ?? modifier.productId ?? 'Дополнение')}${Number(modifier.amount) > 1 ? ` ×${Number(modifier.amount)}` : ''}`).join(' · ');
    return `<li><div><strong>${escapeHtml(line.customName ?? line.productId ?? 'Позиция')}</strong>${modifierText ? `<small>${modifierText}</small>` : ''}</div><b>×${quantity}</b></li>`;
  }).join('');
}

function orderCard(item: Order) {
  const step = Math.max(0, Math.min(orderStatuses.length - 1, Number(item.status_step) || 0));
  const progress = ((step + 1) / orderStatuses.length) * 100;
  const count = (Array.isArray(item.items) ? item.items : []).reduce((sum, line) => sum + Math.max(1, Number(line.quantity) || 1), 0);
  return `<details class="order"><summary><header><span>СТОЛ №${escapeHtml(item.table_number)}</span><time>${time(item.created_at)}</time></header><div class="order__main"><div><h2>${escapeHtml(item.order_number)}</h2><small>${count} ${count === 1 ? 'позиция' : count < 5 ? 'позиции' : 'позиций'}</small></div><strong>${money(item.total)}</strong></div><footer><span>${orderStatuses[step]}</span><div class="order__progress"><i style="width:${progress}%"></i></div></footer></summary><div class="order__details"><ul>${orderItems(item)}</ul>${item.comment ? `<p><span>Пожелание гостя</span>${escapeHtml(item.comment)}</p>` : ''}</div></details>`;
}

function emptyState(kind: WaiterView) {
  return `<div class="empty"><span>${icon('check')}</span><h2>${kind === 'calls' ? 'Новых вызовов нет' : 'Активных заказов нет'}</h2><p>${kind === 'calls' ? 'Здесь появятся просьбы гостей.' : 'Новые заказы появятся автоматически.'}</p></div>`;
}

function incoming(item: Request) {
  return `<div class="incoming"><div class="incoming__top"><span>НОВЫЙ ВЫЗОВ</span><time>${time(item.created_at)}</time></div><div class="incoming__body"><small>СТОЛ</small><h1>№${escapeHtml(item.table_number)}</h1><p>${escapeHtml(requestTitles[item.request_type] ?? item.request_type)}</p></div><button data-accept-id="${item.id}">Принять вызов</button></div>`;
}

function profileSheet() {
  if (!profileOpen) return '';
  const pushSettings = !Capacitor.isNativePlatform() ? `<div class="profile-update"><div><strong>Уведомления</strong><span data-push-status></span></div><button data-action="profile-push">Включить</button></div>` : '';
  return `<div class="profile-overlay" data-action="close-profile"><section class="profile-sheet" role="dialog" aria-modal="true" aria-label="Профиль официанта"><header><div class="profile-avatar">${escapeHtml((waiterProfile?.name || 'О').slice(0, 1).toUpperCase())}</div><div><small>Сейчас работает</small><h2>${escapeHtml(waiterProfile?.name || 'Официант')}</h2></div><button data-action="close-profile" aria-label="Закрыть">×</button></header>${pushSettings}<div class="profile-update"><div><strong>Приложение</strong><span data-update-status>Установлена версия ${escapeHtml(currentAppVersion || bundledVersion)}</span></div><button data-action="profile-update">Проверить обновление</button></div><button class="profile-logout" data-action="logout">Выйти из профиля</button></section></div>`;
}

function paintConnectionState() {
  const badge = root.querySelector<HTMLElement>('[data-connection]');
  if (!badge) return;
  badge.dataset.state = connectionState;
  badge.querySelector('span')!.textContent = connectionState === 'online' ? 'На связи' : connectionState === 'offline' ? 'Нет соединения' : 'Подключаемся';
  badge.querySelector('small')!.textContent = lastUpdatedAt ? `Обновлено ${lastUpdatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '';
}

function paintWaitTimes() {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>('.task[data-created-at]').forEach((card) => {
    const minutes = Math.max(0, Math.floor((now - new Date(card.dataset.createdAt ?? '').getTime()) / 60_000));
    const label = card.querySelector<HTMLElement>('[data-wait-time]');
    const prefix = card.dataset.status === 'in_progress' ? 'В работе' : card.dataset.status === 'accepted' ? 'Принят' : 'Ждёт';
    if (label) label.textContent = minutes < 1 ? (card.dataset.status === 'new' ? 'Только что' : prefix) : `${prefix} ${minutes} мин`;
    card.classList.toggle('is-delayed', minutes >= 3);
    card.classList.toggle('is-critical', minutes >= 7);
  });
}

function bindPullToRefresh() {
  const content = root.querySelector<HTMLElement>('.waiter-content');
  const indicator = root.querySelector<HTMLElement>('.pull-refresh');
  if (!content || !indicator) return;
  let startY = 0;
  let distance = 0;
  content.ontouchstart = (event) => { if (content.scrollTop <= 0) startY = event.touches[0]?.clientY ?? 0; };
  content.ontouchmove = (event) => {
    if (!startY || content.scrollTop > 0) return;
    distance = Math.max(0, Math.min(82, (event.touches[0]?.clientY ?? startY) - startY));
    indicator.style.transform = `translate(-50%, ${distance - 42}px)`;
    indicator.classList.toggle('is-ready', distance >= 64);
  };
  content.ontouchend = () => {
    indicator.style.transform = '';
    indicator.classList.remove('is-ready');
    startY = 0;
    if (distance >= 64) void refreshQueue();
    distance = 0;
  };
}

function render(requests: Request[], orders: Order[], alertItem?: Request, force = false) {
  currentRequests = requests;
  currentOrders = orders;
  const renderKey = JSON.stringify({ activeView, requests, orders, alert: alertItem?.id, profileOpen });
  if (!force && renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  const list = activeView === 'calls'
    ? (requests.length ? requests.map(callCard).join('') : emptyState('calls'))
    : (orders.length ? orders.map(orderCard).join('') : emptyState('orders'));

  root.innerHTML = `<section class="waiter-shell"><main class="waiter-content"><div class="pull-refresh"><i></i><span>Потяните для обновления</span></div><header class="waiter-toolbar"><div data-connection data-state="${connectionState}"><i></i><div><span>Подключаемся</span><small></small></div></div><button data-action="open-profile"><span>${escapeHtml((waiterProfile?.name || 'О').slice(0, 1).toUpperCase())}</span><b>${escapeHtml(waiterProfile?.name || 'Профиль')}</b></button></header><div class="task-list">${list}</div></main><nav class="waiter-tabs" aria-label="Рабочие разделы"><button class="${activeView === 'calls' ? 'is-active' : ''}" data-view="calls"><span>Вызовы</span><b>${requests.length}</b></button><button class="${activeView === 'orders' ? 'is-active' : ''}" data-view="orders"><span>Активные заказы</span><b>${orders.length}</b></button></nav></section>${alertItem ? incoming(alertItem) : ''}${profileSheet()}`;

  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.onclick = () => {
      activeView = button.dataset.view as WaiterView;
      render(currentRequests, currentOrders, undefined, true);
    };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-accept-id]').forEach((button) => { button.onclick = () => void accept(Number(button.dataset.acceptId), button); });
  root.querySelectorAll<HTMLButtonElement>('[data-start-id]').forEach((button) => { button.onclick = () => void changeRequest(Number(button.dataset.startId), 'start', button); });
  root.querySelectorAll<HTMLButtonElement>('[data-complete-id]').forEach((button) => { button.onclick = () => void changeRequest(Number(button.dataset.completeId), 'complete', button); });
  root.querySelectorAll<HTMLElement>('[data-action="open-profile"]').forEach((button) => { button.onclick = () => { profileOpen = true; render(currentRequests, currentOrders, undefined, true); }; });
  root.querySelectorAll<HTMLElement>('[data-action="close-profile"]').forEach((button) => { button.onclick = (event) => { if (event.target !== button && button.classList.contains('profile-overlay')) return; profileOpen = false; render(currentRequests, currentOrders, undefined, true); }; });
  root.querySelector<HTMLButtonElement>('[data-action="profile-update"]')?.addEventListener('click', () => { if (otaState.phase === 'available') void installWaiterUpdate(); else void checkWaiterUpdate(); });
  root.querySelector<HTMLButtonElement>('[data-action="profile-push"]')?.addEventListener('click', () => { void enableWebPush(true); });
  root.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => { void logout(); });
  paintConnectionState();
  paintWaitTimes();
  paintProfileUpdate();
  paintWebPushState();
  bindPullToRefresh();
}

function setActionPending(button: HTMLButtonElement, pending: boolean) {
  if (pending) button.dataset.label = button.textContent ?? '';
  button.disabled = pending;
  button.textContent = pending ? 'Сохраняем…' : button.dataset.label ?? button.textContent;
}

async function accept(id: number, button: HTMLButtonElement) {
  try {
    setActionPending(button, true);
    await request(`/waiter/requests/${id}/accept`, { method: 'POST' });
    if (activeAlertId === id) activeAlertId = null;
    lastRenderKey = '';
    await queue();
  } catch (error) {
    setActionPending(button, false);
    window.alert(error instanceof Error ? error.message : 'Не удалось принять вызов');
  }
}

async function changeRequest(id: number, action: 'start' | 'complete', button: HTMLButtonElement) {
  try {
    setActionPending(button, true);
    await request(`/waiter/requests/${id}/${action}`, { method: 'POST' });
    lastRenderKey = '';
    await queue();
  } catch (error) {
    setActionPending(button, false);
    window.alert(error instanceof Error ? error.message : 'Не удалось обновить вызов');
  }
}

async function refreshQueue() {
  const indicator = root.querySelector<HTMLElement>('.pull-refresh');
  indicator?.classList.add('is-refreshing');
  connectionState = 'connecting';
  paintConnectionState();
  await queue();
  indicator?.classList.remove('is-refreshing');
}

async function logout() {
  const logoutButton = root.querySelector<HTMLButtonElement>('[data-action="logout"]');
  if (logoutButton) { logoutButton.disabled = true; logoutButton.textContent = 'Выходим…'; }
  try {
    if (pushDeviceToken) await request('/waiter/devices', { method: 'DELETE', body: JSON.stringify({ token: pushDeviceToken }) });
    if (webPushEndpoint) await request('/waiter/web-push-subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: webPushEndpoint }) });
  } catch { /* Local sign-out must remain available without a network. */ }
  token = '';
  waiterProfile = null;
  profileOpen = false;
  initialized = false;
  pushInitialized = false;
  lastRenderKey = '';
  localStorage.removeItem('bb-waiter-token');
  localStorage.removeItem('bb-waiter-profile');
  localStorage.removeItem('bb-waiter-web-push-endpoint');
  webPushEndpoint = '';
  webPushState = 'idle';
  login();
}

async function performQueue() {
  if (!token) return login();
  try {
    await enablePush();
    const data = await request<{ requests: Request[]; orders: Order[]; waiter: WaiterProfile }>('/waiter/queue');
    connectionState = 'online';
    lastUpdatedAt = new Date();
    waiterProfile = data.waiter;
    localStorage.setItem('bb-waiter-profile', JSON.stringify(data.waiter));
    const fresh = data.requests.find((item) => item.status === 'new' && !known.has(String(item.id)));
    if (!initialized) {
      data.requests.forEach((item) => known.add(String(item.id)));
      initialized = true;
    } else if (fresh) {
      known.add(String(fresh.id));
      activeAlertId = fresh.id;
      sound();
    }
    const alertItem = data.requests.find((item) => item.id === activeAlertId && item.status === 'new');
    if (!alertItem) activeAlertId = null;
    render(data.requests, data.orders, alertItem);
    paintConnectionState();
  } catch (error) {
    connectionState = 'offline';
    paintConnectionState();
    if (!root.querySelector('.waiter-shell') && token) render(currentRequests, currentOrders, undefined, true);
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      localStorage.removeItem('bb-waiter-token');
      localStorage.removeItem('bb-waiter-profile');
      token = '';
      waiterProfile = null;
      pushInitialized = false;
      login();
    }
  }
}

async function queue() {
  if (queueTask) return queueTask;
  queueTask = performQueue().finally(() => { queueTask = null; });
  return queueTask;
}

void queue();
void waiterServiceWorker().catch(() => undefined);
setInterval(() => { if (!document.hidden) void queue(); }, 5000);
setInterval(paintWaitTimes, 20_000);
if (Capacitor.isNativePlatform()) void CapacitorUpdater.notifyAppReady().catch(() => undefined);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void queue(); });
