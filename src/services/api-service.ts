import type { AdminDiagnostics, AdminOrder, Banner, CartLine, IikoConnectionConfig, IikoConnectionDiscovery, IikoConnectionSelection, IikoConnectionTest, IikoRestaurantOptions, Product, ProductDisplaySettings, RestaurantTable, SubmittedOrder, TerminalSettings } from '../types/menu';
import { Capacitor } from '@capacitor/core';

let token = sessionStorage.getItem('zakaz-admin-token') ?? '';
let adminScope = sessionStorage.getItem('zakaz-admin-scope') as 'terminal' | 'restaurant' | null;
let adminRole = sessionStorage.getItem('zakaz-admin-role') as 'administrator' | 'hostess' | 'terminal_manager' | null;
const terminalKey = 'zakaz-terminal-id';
const rawTerminalId = localStorage.getItem(terminalKey);
export const terminalId = rawTerminalId ?? crypto.randomUUID().replace(/-/g, '');
if (!rawTerminalId) localStorage.setItem(terminalKey, terminalId);
const productionOrigin = 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai';
const isNative = Capacitor.isNativePlatform();
const apiBase = isNative ? `${productionOrigin}/api/v1` : '/api/v1';
const assetUrl = (value: string) => isNative && value.startsWith('/uploads/') ? `${productionOrigin}${value}` : value;

type ServerProduct = Product & { sku?: string; is_available: boolean; badge: string; image_position: string; allergens: string; spicy: 'none' | 'mild' | 'hot'; sort_order: number };
type ServerBanner = { id: number | string; name: string; image_url: string; product_id: string | null; kind: 'restaurant' | 'advertising'; active: boolean; starts_at: string | null; ends_at: string | null; impression_limit: number | null; impressions: number; sort_order: number };
type ServerTerminal = { id: string; label: string; table_number: string; is_active: boolean; idle_seconds: number; table_source?: 'admin' | 'guest' | null; table_id?: string | null };
type ServerOrder = { order_number: string; items: CartLine[]; total: number; status_step: number; table_number: string; created_at: string };
export type WaiterProfile = { id: string; display_name: string; is_active: boolean; created_at: string };
export type AdminUserProfile = { id: string; username: string; display_name: string; role: 'administrator' | 'hostess'; is_active: boolean; created_at: string };

const request = async <T>(path: string, init: RequestInit = {}) => {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body = {} as T & { error?: string };
    try { body = text ? JSON.parse(text) as T & { error?: string } : body; }
    catch {
      if (!response.ok) {
        const fallback = response.status === 413
          ? 'Файл слишком большой для загрузки'
          : `Ошибка сервера (${response.status})`;
        throw new Error(fallback);
      }
      throw new SyntaxError('Invalid JSON response');
    }
    if (!response.ok) throw new Error(body.error ?? (response.status === 413 ? 'Файл слишком большой для загрузки' : 'Ошибка сервера'));
    return body;
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('Нет соединения с сервером');
    throw error;
  }
};

const product = (item: ServerProduct): Product => ({
  id: item.id, sku: item.sku, name: item.name, category: item.category, price_rub: Number(item.price_rub), portion: item.portion, unit: item.unit, description: item.description,
  kbju: item.kbju, image: assetUrl(item.image), source_url: item.source_url, sauce_options: item.sauce_options ?? [], sauce_addon_price_rub: item.sauce_addon_price_rub ?? undefined,
  addon_options: item.addon_options ?? [], flavor_options: item.flavor_options ?? [], size_option: item.size_option ?? undefined, pairs_with: item.pairs_with ?? [], recommendations_note: item.recommendations_note ?? undefined,
  modifier_groups: (item.modifier_groups ?? []).map((group) => ({ ...group, items: group.items.map((modifier) => ({ ...modifier, image: assetUrl(modifier.image || '/images/sauce-fallback.webp') })) })),
});
const display = (item: ServerProduct): ProductDisplaySettings => ({ badge: item.badge ?? '', unavailable: !item.is_available, imagePosition: item.image_position ?? 'center', allergens: item.allergens ?? '', spicy: item.spicy ?? 'none' });
const banner = (item: ServerBanner): Banner => ({ id: String(item.id), name: item.name, image: assetUrl(item.image_url), productId: item.product_id ?? null, kind: item.kind, active: item.active, startsAt: item.starts_at, endsAt: item.ends_at, impressionLimit: item.impression_limit === null ? null : Number(item.impression_limit), impressions: Number(item.impressions), sortOrder: Number(item.sort_order) });
const terminal = (item: ServerTerminal): TerminalSettings => ({ id: item.id, label: item.label, tableNumber: item.table_number, isActive: item.is_active, idleSeconds: item.idle_seconds, tableSource: item.table_source ?? null, tableId: item.table_id ?? null });
const order = (item: ServerOrder): SubmittedOrder => ({ id: item.order_number, items: item.items, total: Number(item.total), statusStep: item.status_step, createdAt: item.created_at, orderType: null, tableNumber: item.table_number });

export const apiService = {
  terminalId,
  async bootstrap() {
    const data = await request<{ products: ServerProduct[]; banners: ServerBanner[]; terminal: ServerTerminal; orders: ServerOrder[]; settings: Record<string, unknown> }>(`/bootstrap?terminalId=${terminalId}&fresh=${Date.now()}`);
    return { products: data.products.map(product), display: Object.fromEntries(data.products.map((item) => [item.id, display(item)])), banners: data.banners.map(banner), terminal: terminal(data.terminal), orders: data.orders.map(order), settings: data.settings };
  },
  async login(password: string, scope: 'terminal' | 'restaurant', username = '') {
    const data = await request<{ token: string; scope: 'terminal' | 'restaurant'; role: 'administrator' | 'hostess' | 'terminal_manager' }>('/admin/login', { method: 'POST', body: JSON.stringify({ password, scope, username }) });
    token = data.token;
    sessionStorage.setItem('zakaz-admin-token', token);
    adminScope = data.scope; sessionStorage.setItem('zakaz-admin-scope', data.scope);
    adminRole = data.role; sessionStorage.setItem('zakaz-admin-role', data.role);
    return { scope: data.scope, role: data.role };
  },
  scope: () => adminScope,
  role: () => adminRole,
  logout() { token = ''; adminScope = null; adminRole = null; sessionStorage.removeItem('zakaz-admin-token'); sessionStorage.removeItem('zakaz-admin-scope'); sessionStorage.removeItem('zakaz-admin-role'); },
  async saveTerminal(value: TerminalSettings) {
    const data = await request<ServerTerminal>(`/admin/terminals/${encodeURIComponent(value.id)}`, { method: 'PUT', body: JSON.stringify({ label: value.label, table_number: value.tableNumber, is_active: value.isActive, idle_seconds: value.idleSeconds }) });
    return terminal(data);
  },
  async submitOrder(value: { items: CartLine[]; total: number; comment: string; promoCode: string; requestId: string }) {
    const data = await request<ServerOrder>('/orders', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, items: value.items, total: value.total, comment: value.comment, promo_code: value.promoCode, client_request_id: value.requestId }) });
    return order(data);
  },
  async tables() {
    const data = await request<{ tables: Array<{ table_id: string; section_name: string; table_number: string; table_name: string }> }>(`/tables?terminalId=${terminalId}`);
    return data.tables.map((item): RestaurantTable => ({ id: item.table_id, section: item.section_name, number: item.table_number, name: item.table_name }));
  },
  async selectTable(tableId: string) {
    return request<{ table_number: string; table_id: string; source: 'guest' }>('/tables/select', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, table_id: tableId }) });
  },
  async requestService(type: string) {
    await request<{ ok: true }>('/service-requests', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, type }) });
  },
  async completeOrder(orderNumber: string) {
    await request<void>(`/orders/${encodeURIComponent(orderNumber)}/complete`, { method: 'POST', body: JSON.stringify({ terminal_id: terminalId }) });
  },
  async saveProduct(id: string, value: Partial<Product> & Partial<ProductDisplaySettings>) {
    const body = { ...value, is_available: value.unavailable === undefined ? undefined : !value.unavailable, image_position: value.imagePosition, ...('imagePosition' in value ? { imagePosition: undefined } : {}) };
    const data = await request<ServerProduct>(`/admin/products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    return { product: product(data), display: display(data) };
  },
  async saveIikoPresentation(id: string, value: { image: string; imagePosition: string; badge: string; pairsWith: string[] }) {
    const data = await request<{ image: string; image_position: string; badge: string; pairs_with: string[] }>(`/admin/iiko-products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ image: value.image, image_position: value.imagePosition, badge: value.badge, pairs_with: value.pairsWith }) });
    return { image: data.image, imagePosition: data.image_position, badge: data.badge, pairsWith: data.pairs_with };
  },
  async adminOrders(filter: 'active' | 'all' = 'active') {
    const data = await request<Array<{ order_number: string; iiko_order_id: string | null; iiko_pos_id: string | null; table_number: string; terminal_label: string; items: CartLine[]; total: number; status_step: number; status: string; creation_status: string | null; source: 'tablet' | 'qr' | 'waiter'; created_at: string; updated_at: string; completed_at: string | null; history: Array<{ event_type: string; payload: Record<string, unknown>; created_at: string }> }>>(`/admin/orders?filter=${filter}`);
    return data.map((item): AdminOrder => ({ id: item.order_number, iikoOrderId: item.iiko_order_id, iikoPosId: item.iiko_pos_id, tableNumber: item.table_number, terminalLabel: item.terminal_label, items: item.items, total: Number(item.total), statusStep: Number(item.status_step), status: item.status, creationStatus: item.creation_status, source: item.source, createdAt: item.created_at, updatedAt: item.updated_at, completedAt: item.completed_at, history: item.history.map((event) => ({ eventType: event.event_type, payload: event.payload, createdAt: event.created_at })) }));
  },
  async diagnostics(): Promise<AdminDiagnostics> {
    const data = await request<{ generated_at: string; api: { ok: boolean; uptime_seconds: number; started_at: string }; database: { ok: boolean; latency_ms: number }; disk: { ok: boolean; usedPercent: number | null }; menu: { active_products: number; updated_at: string | null }; iiko_orders: { ok: boolean; errors_24h: number; last_error_at: string | null }; webhook: { ok: boolean; errors_24h: number; events_24h: number; last_event_at: string | null }; iiko_sync: { ok: boolean; errors_24h: number; backoff_until: string | null }; incidents: Array<{ component: string; severity: 'warning' | 'error' | 'critical'; message: string; context: Record<string, unknown>; created_at: string }> }>('/admin/diagnostics');
    return { generatedAt: data.generated_at, api: { ok: data.api.ok, uptimeSeconds: data.api.uptime_seconds, startedAt: data.api.started_at }, database: { ok: data.database.ok, latencyMs: data.database.latency_ms }, disk: data.disk, menu: { activeProducts: data.menu.active_products, updatedAt: data.menu.updated_at }, iikoOrders: { ok: data.iiko_orders.ok, errors24h: data.iiko_orders.errors_24h, lastErrorAt: data.iiko_orders.last_error_at }, webhook: { ok: data.webhook.ok, errors24h: data.webhook.errors_24h, events24h: data.webhook.events_24h, lastEventAt: data.webhook.last_event_at }, iikoSync: { ok: data.iiko_sync.ok, errors24h: data.iiko_sync.errors_24h, backoffUntil: data.iiko_sync.backoff_until }, incidents: data.incidents.map((item) => ({ component: item.component, severity: item.severity, message: item.message, context: item.context, createdAt: item.created_at })) };
  },
  unlockIikoConfig: (password: string) => request<{ token: string; expiresIn: number }>('/admin/iiko-config/unlock', { method: 'POST', body: JSON.stringify({ password }) }),
  iikoConfig: (stepToken: string) => request<IikoConnectionConfig>('/admin/iiko-config', { headers: { Authorization: `Bearer ${stepToken}` } }),
  discoverIiko: (stepToken: string, value: { appId: string; apiLogin: string; clientSecret: string }) => request<IikoConnectionDiscovery>('/admin/iiko-config/discover', { method: 'POST', headers: { Authorization: `Bearer ${stepToken}` }, body: JSON.stringify(value) }),
  iikoRestaurantOptions: (stepToken: string, discoveryToken: string, organizationId: string) => request<IikoRestaurantOptions>('/admin/iiko-config/restaurant-options', { method: 'POST', headers: { Authorization: `Bearer ${stepToken}` }, body: JSON.stringify({ discoveryToken, organizationId }) }),
  testIikoConfig: (stepToken: string, value: IikoConnectionSelection) => request<{ result: IikoConnectionTest; testToken: string }>('/admin/iiko-config/test', { method: 'POST', headers: { Authorization: `Bearer ${stepToken}` }, body: JSON.stringify(value) }),
  applyIikoConfig: (stepToken: string, value: IikoConnectionSelection, testToken: string) => request<{ config: IikoConnectionConfig; sync: { menuItems: number; tables: number }; webhook: { registered: boolean; updated: boolean } }>('/admin/iiko-config/apply', { method: 'POST', headers: { Authorization: `Bearer ${stepToken}` }, body: JSON.stringify({ ...value, testToken }) }),
  async banners() {
    const data = await request<ServerBanner[]>('/admin/banners');
    return data.map(banner);
  },
  async createBanner(value: Omit<Banner, 'id' | 'impressions'>) {
    const data = await request<ServerBanner>('/admin/banners', { method: 'POST', body: JSON.stringify({ name: value.name, image_url: value.image, product_id: value.productId, kind: value.kind, active: value.active, starts_at: value.startsAt, ends_at: value.endsAt, impression_limit: value.impressionLimit, sort_order: value.sortOrder }) });
    return banner(data);
  },
  async saveBanner(value: Banner) {
    const data = await request<ServerBanner>(`/admin/banners/${value.id}`, { method: 'PUT', body: JSON.stringify({ name: value.name, image_url: value.image, product_id: value.productId, kind: value.kind, active: value.active, starts_at: value.startsAt, ends_at: value.endsAt, impression_limit: value.impressionLimit, sort_order: value.sortOrder }) });
    return banner(data);
  },
  async deleteBanner(id: string) { await request<void>(`/admin/banners/${id}`, { method: 'DELETE' }); },
  async resetBannerImpressions(id: string) { return banner(await request<ServerBanner>(`/admin/banners/${id}/reset-impressions`, { method: 'POST' })); },
  async uploadBannerImage(dataUrl: string) { return request<{ url: string }>('/admin/banners/upload', { method: 'POST', body: JSON.stringify({ data_url: dataUrl }) }); },
  async uploadProductImage(dataUrl: string) { return request<{ url: string }>('/admin/products/upload', { method: 'POST', body: JSON.stringify({ data_url: dataUrl }) }); },
  async recordBannerImpression(id: string) { return request<{ counted: boolean; exhausted: boolean; impressions: number }>(`/banners/${id}/impression`, { method: 'POST', body: JSON.stringify({ terminal_id: terminalId }) }); },
  waiters: () => request<WaiterProfile[]>('/admin/waiters'),
  createWaiter: (value: { name: string; pin: string }) => request<WaiterProfile>('/admin/waiters', { method: 'POST', body: JSON.stringify(value) }),
  updateWaiter: (id: string, value: { pin?: string; isActive?: boolean }) => request<WaiterProfile>(`/admin/waiters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ pin: value.pin ?? '', is_active: value.isActive }) }),
  adminUsers: () => request<AdminUserProfile[]>('/admin/users'),
  createAdminUser: (value: { username: string; name: string; password: string; role: 'administrator' | 'hostess' }) => request<AdminUserProfile>('/admin/users', { method: 'POST', body: JSON.stringify(value) }),
  updateAdminUser: (id: string, value: { password?: string; role: 'administrator' | 'hostess'; isActive: boolean }) => request<AdminUserProfile>(`/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password: value.password ?? '', role: value.role, is_active: value.isActive }) }),
  audit: () => request<Array<{ id: number; action: string; entity: string; entity_id: string; created_at: string }>>('/admin/audit'),
};
