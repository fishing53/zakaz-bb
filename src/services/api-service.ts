import type { CartLine, Product, ProductDisplaySettings, Promotion, RestaurantTable, SubmittedOrder, TerminalSettings } from '../types/menu';
import { Capacitor } from '@capacitor/core';

let token = sessionStorage.getItem('zakaz-admin-token') ?? '';
let adminScope = sessionStorage.getItem('zakaz-admin-scope') as 'terminal' | 'restaurant' | null;
const terminalKey = 'zakaz-terminal-id';
const rawTerminalId = localStorage.getItem(terminalKey);
export const terminalId = rawTerminalId ?? crypto.randomUUID().replace(/-/g, '');
if (!rawTerminalId) localStorage.setItem(terminalKey, terminalId);
const apiBase = Capacitor.isNativePlatform() ? 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1' : '/api/v1';

type ServerProduct = Product & { is_available: boolean; badge: string; image_position: string; allergens: string; spicy: 'none' | 'mild' | 'hot'; sort_order: number };
type ServerPromotion = { id: number | string; product_id: string; title: string; subtitle: string; label: string; active: boolean; sort_order: number };
type ServerTerminal = { id: string; label: string; table_number: string; is_active: boolean; idle_seconds: number; table_source?: 'admin' | 'guest' | null; table_id?: string | null };
type ServerOrder = { order_number: string; items: CartLine[]; total: number; status_step: number; table_number: string; created_at: string };
export type WaiterProfile = { id: string; display_name: string; is_active: boolean; created_at: string };

const request = async <T>(path: string, init: RequestInit = {}) => {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const body = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Ошибка сервера');
    return body;
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('Нет соединения с сервером');
    throw error;
  }
};

const product = (item: ServerProduct): Product => ({
  id: item.id, name: item.name, category: item.category, price_rub: Number(item.price_rub), portion: item.portion, unit: item.unit, description: item.description,
  kbju: item.kbju, image: item.image, source_url: item.source_url, sauce_options: item.sauce_options ?? [], sauce_addon_price_rub: item.sauce_addon_price_rub ?? undefined,
  addon_options: item.addon_options ?? [], flavor_options: item.flavor_options ?? [], size_option: item.size_option ?? undefined, pairs_with: item.pairs_with ?? [], recommendations_note: item.recommendations_note ?? undefined,
  modifier_groups: item.modifier_groups ?? [],
});
const display = (item: ServerProduct): ProductDisplaySettings => ({ badge: item.badge ?? '', unavailable: !item.is_available, imagePosition: item.image_position ?? 'center', allergens: item.allergens ?? '', spicy: item.spicy ?? 'none' });
const promotion = (item: ServerPromotion): Promotion => ({ id: String(item.id), productId: item.product_id, title: item.title, subtitle: item.subtitle, label: item.label, active: item.active });
const terminal = (item: ServerTerminal): TerminalSettings => ({ id: item.id, label: item.label, tableNumber: item.table_number, isActive: item.is_active, idleSeconds: item.idle_seconds, tableSource: item.table_source ?? null, tableId: item.table_id ?? null });
const order = (item: ServerOrder): SubmittedOrder => ({ id: item.order_number, items: item.items, total: Number(item.total), statusStep: item.status_step, createdAt: item.created_at, orderType: null, tableNumber: item.table_number });

export const apiService = {
  terminalId,
  async bootstrap() {
    const data = await request<{ products: ServerProduct[]; promotions: ServerPromotion[]; terminal: ServerTerminal; orders: ServerOrder[]; settings: Record<string, unknown> }>(`/bootstrap?terminalId=${terminalId}`);
    return { products: data.products.map(product), display: Object.fromEntries(data.products.map((item) => [item.id, display(item)])), promotions: data.promotions.map(promotion), terminal: terminal(data.terminal), orders: data.orders.map(order), settings: data.settings };
  },
  async login(password: string, scope: 'terminal' | 'restaurant') {
    const data = await request<{ token: string; scope: 'terminal' | 'restaurant' }>('/admin/login', { method: 'POST', body: JSON.stringify({ password, scope }) });
    token = data.token;
    sessionStorage.setItem('zakaz-admin-token', token);
    adminScope = data.scope; sessionStorage.setItem('zakaz-admin-scope', data.scope);
    return data.scope;
  },
  scope: () => adminScope,
  logout() { token = ''; adminScope = null; sessionStorage.removeItem('zakaz-admin-token'); sessionStorage.removeItem('zakaz-admin-scope'); },
  async saveTerminal(value: TerminalSettings) {
    const data = await request<ServerTerminal>(`/admin/terminals/${encodeURIComponent(value.id)}`, { method: 'PUT', body: JSON.stringify({ label: value.label, table_number: value.tableNumber, is_active: value.isActive, idle_seconds: value.idleSeconds }) });
    return terminal(data);
  },
  async submitOrder(value: { items: CartLine[]; total: number; comment: string; promoCode: string }) {
    const data = await request<ServerOrder>('/orders', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, items: value.items, total: value.total, comment: value.comment, promo_code: value.promoCode }) });
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
  async createPromotion(value: Omit<Promotion, 'id'>) {
    const data = await request<ServerPromotion>('/admin/promotions', { method: 'POST', body: JSON.stringify({ product_id: value.productId, title: value.title, subtitle: value.subtitle, label: value.label, active: value.active }) });
    return promotion(data);
  },
  async savePromotion(value: Promotion) {
    const data = await request<ServerPromotion>(`/admin/promotions/${value.id}`, { method: 'PUT', body: JSON.stringify({ product_id: value.productId, title: value.title, subtitle: value.subtitle, label: value.label, active: value.active }) });
    return promotion(data);
  },
  async deletePromotion(id: string) { await request<void>(`/admin/promotions/${id}`, { method: 'DELETE' }); },
  waiters: () => request<WaiterProfile[]>('/admin/waiters'),
  createWaiter: (value: { name: string; pin: string }) => request<WaiterProfile>('/admin/waiters', { method: 'POST', body: JSON.stringify(value) }),
  updateWaiter: (id: string, value: { pin?: string; isActive?: boolean }) => request<WaiterProfile>(`/admin/waiters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ pin: value.pin ?? '', is_active: value.isActive }) }),
  audit: () => request<Array<{ id: number; action: string; entity: string; entity_id: string; created_at: string }>>('/admin/audit'),
};
