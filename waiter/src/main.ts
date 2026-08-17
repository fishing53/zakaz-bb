import './style.css';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { icon } from '../../src/components/icons';

const api = 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1';
const root = document.querySelector<HTMLDivElement>('#app')!;

type WaiterView = 'calls' | 'orders';
type Request = { id: number; table_number: string; request_type: string; status: string; created_at: string };
type Order = { order_number: string; table_number: string; total: number; status_step: number; created_at: string; source: string };

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
  if (pushInitialized || !token || !Capacitor.isNativePlatform()) return;
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

function login() {
  if (loginRendered) return;
  loginRendered = true;
  root.innerHTML = `<section class="login"><div class="login__mark">BB</div><span>ПРИЛОЖЕНИЕ ДЛЯ КОМАНДЫ</span><h1>Официант</h1><p>Введите персональный PIN-код</p><input inputmode="numeric" type="password" maxlength="8" placeholder="PIN" autocomplete="current-password" autofocus><button>Войти</button></section>`;
  const input = root.querySelector<HTMLInputElement>('input')!;
  const submit = async () => {
    try {
      const response = await request<{ token: string }>('/waiter/login', {
        method: 'POST',
        body: JSON.stringify({ pin: input.value }),
      });
      token = response.token;
      loginRendered = false;
      localStorage.setItem('bb-waiter-token', token);
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
  root.querySelector<HTMLButtonElement>('button')!.onclick = submit;
  input.onkeydown = (event) => { if (event.key === 'Enter') void submit(); };
}

function callCard(item: Request) {
  const action = item.status === 'new'
    ? `<button data-accept-id="${item.id}">Принять</button>`
    : item.status === 'accepted'
      ? `<button data-start-id="${item.id}">В путь</button>`
      : `<button class="button-secondary" data-complete-id="${item.id}">Выполнено</button>`;
  return `<article class="task ${item.status === 'new' ? 'is-new' : ''}"><header class="task__meta"><span>СТОЛ №${escapeHtml(item.table_number)}</span><time>${time(item.created_at)}</time></header><h2>${escapeHtml(requestTitles[item.request_type] ?? item.request_type)}</h2>${action}</article>`;
}

function orderCard(item: Order) {
  const step = Math.max(0, Math.min(orderStatuses.length - 1, Number(item.status_step) || 0));
  const progress = ((step + 1) / orderStatuses.length) * 100;
  return `<article class="order"><header><span>СТОЛ №${escapeHtml(item.table_number)}</span><time>${time(item.created_at)}</time></header><div class="order__main"><h2>${escapeHtml(item.order_number)}</h2><strong>${money(item.total)}</strong></div><footer><span>${orderStatuses[step]}</span><div class="order__progress"><i style="width:${progress}%"></i></div></footer></article>`;
}

function emptyState(kind: WaiterView) {
  return `<div class="empty"><span>${icon('check')}</span><h2>${kind === 'calls' ? 'Новых вызовов нет' : 'Активных заказов нет'}</h2><p>${kind === 'calls' ? 'Здесь появятся просьбы гостей.' : 'Новые заказы появятся автоматически.'}</p></div>`;
}

function incoming(item: Request) {
  return `<div class="incoming"><div class="incoming__top"><span>НОВЫЙ ВЫЗОВ</span><time>${time(item.created_at)}</time></div><div class="incoming__body"><small>СТОЛ</small><h1>№${escapeHtml(item.table_number)}</h1><p>${escapeHtml(requestTitles[item.request_type] ?? item.request_type)}</p></div><button data-accept-id="${item.id}">Принять вызов</button></div>`;
}

function render(requests: Request[], orders: Order[], alertItem?: Request, force = false) {
  currentRequests = requests;
  currentOrders = orders;
  const renderKey = JSON.stringify({ activeView, requests, orders, alert: alertItem?.id });
  if (!force && renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  const list = activeView === 'calls'
    ? (requests.length ? requests.map(callCard).join('') : emptyState('calls'))
    : (orders.length ? orders.map(orderCard).join('') : emptyState('orders'));

  root.innerHTML = `<section class="waiter-shell"><nav class="waiter-tabs" aria-label="Рабочие разделы"><button class="${activeView === 'calls' ? 'is-active' : ''}" data-view="calls"><span>Вызовы</span><b>${requests.length}</b></button><button class="${activeView === 'orders' ? 'is-active' : ''}" data-view="orders"><span>Активные заказы</span><b>${orders.length}</b></button></nav><main class="waiter-content"><div class="task-list">${list}</div></main></section>${alertItem ? incoming(alertItem) : ''}`;

  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.onclick = () => {
      activeView = button.dataset.view as WaiterView;
      render(currentRequests, currentOrders, undefined, true);
    };
  });
  root.querySelectorAll<HTMLButtonElement>('[data-accept-id]').forEach((button) => { button.onclick = () => void accept(Number(button.dataset.acceptId)); });
  root.querySelectorAll<HTMLButtonElement>('[data-start-id]').forEach((button) => { button.onclick = () => void changeRequest(Number(button.dataset.startId), 'start'); });
  root.querySelectorAll<HTMLButtonElement>('[data-complete-id]').forEach((button) => { button.onclick = () => void changeRequest(Number(button.dataset.completeId), 'complete'); });
}

async function accept(id: number) {
  try {
    await request(`/waiter/requests/${id}/accept`, { method: 'POST' });
    if (activeAlertId === id) activeAlertId = null;
    lastRenderKey = '';
    await queue();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Не удалось принять вызов');
  }
}

async function changeRequest(id: number, action: 'start' | 'complete') {
  try {
    await request(`/waiter/requests/${id}/${action}`, { method: 'POST' });
    lastRenderKey = '';
    await queue();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Не удалось обновить вызов');
  }
}

async function performQueue() {
  if (!token) return login();
  try {
    await enablePush();
    const data = await request<{ requests: Request[]; orders: Order[] }>('/waiter/queue');
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
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      localStorage.removeItem('bb-waiter-token');
      token = '';
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
setInterval(() => { if (!document.hidden) void queue(); }, 5000);
