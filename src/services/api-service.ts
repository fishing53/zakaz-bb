import type { CartLine, Product, ProductDisplaySettings, Promotion, SubmittedOrder, TerminalSettings } from '../types/menu';
import { Capacitor } from '@capacitor/core';

let token = sessionStorage.getItem('zakaz-admin-token') ?? '';
const terminalKey = 'zakaz-terminal-id';
const rawTerminalId = localStorage.getItem(terminalKey);
export const terminalId = rawTerminalId ?? crypto.randomUUID().replace(/-/g, '');
if (!rawTerminalId) localStorage.setItem(terminalKey, terminalId);
const apiBase = Capacitor.isNativePlatform() ? 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1' : '/api/v1';

type ServerProduct = Product & { is_available: boolean; badge: string; image_position: string; allergens: string; spicy: 'none' | 'mild' | 'hot'; sort_order: number };
type ServerPromotion = { id: number | string; product_id: string; title: string; subtitle: string; label: string; active: boolean; sort_order: number };
type ServerTerminal = { id: string; label: string; table_number: string; is_active: boolean; idle_seconds: number };
type ServerOrder = { order_number: string; items: CartLine[]; total: number; status_step: number; table_number: string; created_at: string };

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
});
const display = (item: ServerProduct): ProductDisplaySettings => ({ badge: item.badge ?? '', unavailable: !item.is_available, imagePosition: item.image_position ?? 'center', allergens: item.allergens ?? '', spicy: item.spicy ?? 'none' });
const promotion = (item: ServerPromotion): Promotion => ({ id: String(item.id), productId: item.product_id, title: item.title, subtitle: item.subtitle, label: item.label, active: item.active });
const terminal = (item: ServerTerminal): TerminalSettings => ({ id: item.id, label: item.label, tableNumber: item.table_number, isActive: item.is_active, idleSeconds: item.idle_seconds });
const order = (item: ServerOrder): SubmittedOrder => ({ id: item.order_number, items: item.items, total: Number(item.total), statusStep: item.status_step, createdAt: item.created_at, orderType: null, tableNumber: item.table_number });

export const apiService = {
  terminalId,
  async bootstrap() {
    const data = await request<{ products: ServerProduct[]; promotions: ServerPromotion[]; terminal: ServerTerminal; orders: ServerOrder[]; settings: Record<string, unknown> }>(`/bootstrap?terminalId=${terminalId}`);
    return { products: data.products.map(product), display: Object.fromEntries(data.products.map((item) => [item.id, display(item)])), promotions: data.promotions.map(promotion), terminal: terminal(data.terminal), orders: data.orders.map(order), settings: data.settings };
  },
  async login(password: string) {
    const data = await request<{ token: string }>('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    token = data.token;
    sessionStorage.setItem('zakaz-admin-token', token);
  },
  logout() { token = ''; sessionStorage.removeItem('zakaz-admin-token'); },
  async saveTerminal(value: TerminalSettings) {
    const data = await request<ServerTerminal>(`/admin/terminals/${encodeURIComponent(value.id)}`, { method: 'PUT', body: JSON.stringify({ label: value.label, table_number: value.tableNumber, is_active: value.isActive, idle_seconds: value.idleSeconds }) });
    return terminal(data);
  },
  async submitOrder(value: { items: CartLine[]; total: number; comment: string; promoCode: string }) {
    const data = await request<ServerOrder>('/orders', { method: 'POST', body: JSON.stringify({ terminal_id: terminalId, items: value.items, total: value.total, comment: value.comment, promo_code: value.promoCode }) });
    return order(data);
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
  async createPromotion(value: Omit<Promotion, 'id'>) {
    const data = await request<ServerPromotion>('/admin/promotions', { method: 'POST', body: JSON.stringify({ product_id: value.productId, title: value.title, subtitle: value.subtitle, label: value.label, active: value.active }) });
    return promotion(data);
  },
  async savePromotion(value: Promotion) {
    const data = await request<ServerPromotion>(`/admin/promotions/${value.id}`, { method: 'PUT', body: JSON.stringify({ product_id: value.productId, title: value.title, subtitle: value.subtitle, label: value.label, active: value.active }) });
    return promotion(data);
  },
  async deletePromotion(id: string) { await request<void>(`/admin/promotions/${id}`, { method: 'DELETE' }); },
  audit: () => request<Array<{ id: number; action: string; entity: string; entity_id: string; created_at: string }>>('/admin/audit'),
};
