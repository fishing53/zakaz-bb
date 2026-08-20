import type { AdminDiagnostics, AdminOrder, AdminPromotion, ApplicationDownloadIssue, Banner, CartLine, IikoConnectionConfig, IikoConnectionDiscovery, IikoConnectionSelection, IikoConnectionTest, IikoDiscountOption, IikoRestaurantOptions, Product, ProductDisplaySettings, PromoRule, RestaurantTable, SecurityOverview, SubmittedOrder, TableQrCode, TerminalSettings } from '../types/menu';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { imageCacheService } from './image-cache-service';

let token = sessionStorage.getItem('zakaz-admin-token') ?? '';
let adminScope = sessionStorage.getItem('zakaz-admin-scope') as 'terminal' | 'restaurant' | null;
let adminRole = sessionStorage.getItem('zakaz-admin-role') as 'administrator' | 'hostess' | 'terminal_manager' | null;
const terminalKey = 'zakaz-terminal-id';
const rawTerminalId = localStorage.getItem(terminalKey);
export const terminalId = rawTerminalId ?? crypto.randomUUID().replace(/-/g, '');
if (!rawTerminalId) localStorage.setItem(terminalKey, terminalId);
let activeTerminalId = terminalId;
let source: 'tablet' | 'qr' = 'tablet';
const productionOrigin = 'https://order.brooklynbowl.ru';
const isNative = Capacitor.isNativePlatform();
const apiBase = isNative ? `${productionOrigin}/api/v1` : '/api/v1';
const assetSource = (value: string) => value.startsWith('/uploads/') ? `${productionOrigin}${value}` : value;
const cachedAsset = (value: string) => imageCacheService.resolve(assetSource(value));
const apiErrorMessage = (path: string, status: number, message?: string) => {
  if (status === 401 && path.startsWith('/admin/iiko-config')) return 'Доступ к настройкам iiko истёк. Подтвердите пароль администратора ещё раз.';
  if (message) return message;
  return status === 413 ? 'Файл слишком большой для загрузки' : 'Ошибка сервера';
};

type ServerProduct = Product & { sku?: string; is_available: boolean; badge: string; image_position: string; allergens: string; spicy: 'none' | 'mild' | 'hot'; sort_order: number };
type ServerBanner = { id: number | string; name: string; image_url: string; product_id: string | null; kind: 'restaurant' | 'advertising'; active: boolean; starts_at: string | null; ends_at: string | null; impression_limit: number | null; impressions: number; sort_order: number };
type ServerTerminal = { id: string; label: string; table_number: string; is_active: boolean; demo_mode: boolean; idle_seconds: number; table_source?: 'admin' | 'guest' | 'qr' | null; table_id?: string | null; waiter_id?: string | null };
type ServerOrder = { order_number: string; items: CartLine[]; total: number; status_step: number; table_number: string; created_at: string };
type ServerQrCode = { id: string; table_id: string; table_number: string; table_name: string; section_name: string; is_active: boolean; scans_count: number; last_scanned_at: string | null; created_at: string; updated_at: string; public_url: string; qr_svg: string };
type ServerApplicationDownload = { id: string; app_kind: 'kiosk' | 'waiter'; app_name: string; label: string; status: ApplicationDownloadIssue['status']; version: string; artifact_available: boolean; artifact_size: number; expires_at: string; downloaded_at: string | null; installed_at: string | null; revoked_at: string | null; created_at: string; public_url: string | null; qr_svg: string | null };
export type WaiterProfile = { id: string; display_name: string; is_active: boolean; auth_source: 'local' | 'iiko'; iiko_employee_id: string | null; created_at: string };
export type AdminUserProfile = { id: string; username: string; display_name: string; role: 'administrator' | 'hostess'; is_active: boolean; created_at: string };
export type IikoFrontOverview = {
  bridges: Array<{ id: string; installation_id: string; display_name: string; connected: boolean; is_active: boolean; version: string; api_version: string; module_id: number | null; terminal_id: string; last_seen_at: string | null; last_sync_at: string | null; created_at: string }>;
  employees: Array<{ employee_id: string; display_name: string; first_name: string; middle_name: string; last_name: string; role_ids: string[]; role_names: string[]; is_active: boolean; app_access_enabled: boolean; last_synced_at: string }>;
  pairing?: { code: string; expiresAt: string };
};

const request = async <T>(path: string, init: RequestInit = {}) => {
  try {
    const method = String(init.method ?? 'GET').toUpperCase();
    const hasBody = init.body !== undefined && init.body !== null;
    // Build headers through the Headers API so names are compared
    // case-insensitively. Some protected admin actions pass a short-lived
    // token explicitly; it must replace the regular admin token instead of
    // producing both `Authorization` and `authorization` headers.
    const normalizedHeaders = new Headers();
    if (hasBody) normalizedHeaders.set('Content-Type', 'application/json');
    if (token && path.startsWith('/admin/')) normalizedHeaders.set('Authorization', `Bearer ${token}`);
    new Headers(init.headers).forEach((value, key) => normalizedHeaders.set(key, value));
    const requestHeaders = Object.fromEntries(normalizedHeaders.entries());
    if (isNative) {
      let data: unknown = init.body;
      if (typeof init.body === 'string') {
        try { data = JSON.parse(init.body); } catch { data = init.body; }
      }
      const response = await CapacitorHttp.request({
        url: `${apiBase}${path}`,
        method,
        headers: requestHeaders,
        ...(hasBody ? { data } : {}),
        connectTimeout: 10_000,
        readTimeout: 25_000,
      });
      if (response.status === 204) return undefined as T;
      let body = response.data as T & { error?: string };
      if (typeof response.data === 'string') {
        try { body = JSON.parse(response.data) as T & { error?: string }; }
        catch {
          if (response.status < 200 || response.status >= 300) throw new Error(`Ошибка сервера (${response.status})`);
          throw new SyntaxError('Invalid JSON response');
        }
      }
      if (response.status < 200 || response.status >= 300) throw new Error(apiErrorMessage(path, response.status, body?.error));
      return body;
    }
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      cache: 'no-store',
      headers: requestHeaders,
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
    if (!response.ok) throw new Error(apiErrorMessage(path, response.status, body.error));
    return body;
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('Нет соединения с сервером');
    throw error;
  }
};

const product = (item: ServerProduct): Product => ({
  id: item.id, sku: item.sku, name: item.name, category: item.category, price_rub: Number(item.price_rub), portion: item.portion, unit: item.unit, description: item.description,
  composition: item.composition ?? '', kbju: item.kbju, image: cachedAsset(item.image), imageSource: assetSource(item.image), source_url: item.source_url, sauce_options: item.sauce_options ?? [], sauce_addon_price_rub: item.sauce_addon_price_rub ?? undefined,
  addon_options: item.addon_options ?? [], flavor_options: item.flavor_options ?? [], size_option: item.size_option ?? undefined, pairs_with: item.pairs_with ?? [], recommendations_note: item.recommendations_note ?? undefined,
  modifier_groups: (item.modifier_groups ?? []).map((group) => ({ ...group, items: group.items.map((modifier) => { const source = assetSource(modifier.image || '/images/sauce-fallback.webp'); return { ...modifier, image: imageCacheService.resolve(source), imageSource: source }; }) })),
});
const display = (item: ServerProduct): ProductDisplaySettings => ({ badge: item.badge ?? '', unavailable: !item.is_available, imagePosition: item.image_position ?? 'center', allergens: item.allergens ?? '', spicy: item.spicy ?? 'none' });
const banner = (item: ServerBanner): Banner => { const source = assetSource(item.image_url); return { id: String(item.id), name: item.name, image: imageCacheService.resolve(source), imageSource: source, productId: item.product_id ?? null, kind: item.kind, active: item.active, startsAt: item.starts_at, endsAt: item.ends_at, impressionLimit: item.impression_limit === null ? null : Number(item.impression_limit), impressions: Number(item.impressions), sortOrder: Number(item.sort_order) }; };
const terminal = (item: ServerTerminal): TerminalSettings => ({ id: item.id, label: item.label, tableNumber: item.table_number, isActive: item.is_active, demoMode: item.demo_mode === true, idleSeconds: item.idle_seconds, tableSource: item.table_source ?? null, tableId: item.table_id ?? null, waiterId: item.waiter_id ?? null });
const order = (item: ServerOrder): SubmittedOrder => ({ id: item.order_number, items: item.items, total: Number(item.total), statusStep: item.status_step, createdAt: item.created_at, orderType: null, tableNumber: item.table_number });
const qrCode = (item: ServerQrCode): TableQrCode => ({ id: item.id, tableId: item.table_id, tableNumber: item.table_number, tableName: item.table_name, sectionName: item.section_name, active: item.is_active, scans: Number(item.scans_count), lastScannedAt: item.last_scanned_at, createdAt: item.created_at, updatedAt: item.updated_at, publicUrl: item.public_url, svg: item.qr_svg });
const applicationDownload = (item: ServerApplicationDownload): ApplicationDownloadIssue => ({ id: item.id, appKind: item.app_kind, appName: item.app_name, label: item.label, status: item.status, version: item.version, artifactAvailable: item.artifact_available, artifactSize: Number(item.artifact_size), expiresAt: item.expires_at, downloadedAt: item.downloaded_at, installedAt: item.installed_at, revokedAt: item.revoked_at, createdAt: item.created_at, publicUrl: item.public_url, svg: item.qr_svg });

export const apiService = {
  get terminalId() { return activeTerminalId; },
  isQrMode: () => source === 'qr',
  async activateQr(value: string) {
    const data = await request<{ terminal_id: string; source: 'qr'; table: { table_id: string; table_number: string; table_name: string; section_name: string } }>('/qr/resolve', { method: 'POST', body: JSON.stringify({ token: value, device_id: terminalId }) });
    activeTerminalId = data.terminal_id;
    source = 'qr';
    return data.table;
  },
  async bootstrap() {
    const data = await request<{ products: ServerProduct[]; banners: ServerBanner[]; terminal: ServerTerminal; orders: ServerOrder[]; settings: Record<string, unknown>; catalogRevision: string }>(`/bootstrap?terminalId=${activeTerminalId}`);
    return { products: data.products.map(product), display: Object.fromEntries(data.products.map((item) => [item.id, display(item)])), banners: data.banners.map(banner), terminal: terminal(data.terminal), orders: data.orders.map(order), settings: data.settings, catalogRevision: data.catalogRevision ?? '' };
  },
  catalogRevision: () => request<{ revision: string }>('/catalog/revision'),
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
    const data = await request<ServerTerminal>(`/admin/terminals/${encodeURIComponent(value.id)}`, { method: 'PUT', body: JSON.stringify({ label: value.label, table_id: value.tableId ?? '', table_number: value.tableNumber, waiter_id: value.waiterId ?? '', is_active: value.isActive, demo_mode: value.demoMode, idle_seconds: value.idleSeconds }) });
    return terminal(data);
  },
  async submitOrder(value: { items: CartLine[]; total: number; comment: string; promoCode: string; requestId: string }) {
    const data = await request<ServerOrder>('/orders', { method: 'POST', body: JSON.stringify({ terminal_id: activeTerminalId, source, items: value.items, total: value.total, comment: value.comment, promo_code: value.promoCode, client_request_id: value.requestId }) });
    return order(data);
  },
  validatePromotion(code: string, subtotal: number) {
    return request<PromoRule>('/promotions/validate', { method: 'POST', body: JSON.stringify({ code, subtotal }) });
  },
  async tables() {
    const data = await request<{ tables: Array<{ table_id: string; section_name: string; table_number: string; table_name: string }> }>(`/tables?terminalId=${activeTerminalId}`);
    return data.tables.map((item): RestaurantTable => ({ id: item.table_id, section: item.section_name, number: item.table_number, name: item.table_name }));
  },
  async selectTable(tableId: string) {
    return request<{ table_number: string; table_id: string; source: 'guest' }>('/tables/select', { method: 'POST', body: JSON.stringify({ terminal_id: activeTerminalId, table_id: tableId }) });
  },
  async requestService(type: string) {
    await request<{ ok: true }>('/service-requests', { method: 'POST', body: JSON.stringify({ terminal_id: activeTerminalId, source, type }) });
  },
  async completeOrder(orderNumber: string) {
    await request<void>(`/orders/${encodeURIComponent(orderNumber)}/complete`, { method: 'POST', body: JSON.stringify({ terminal_id: activeTerminalId }) });
  },
  async saveProduct(id: string, value: Partial<Product> & Partial<ProductDisplaySettings>) {
    const body = { ...value, is_available: value.unavailable === undefined ? undefined : !value.unavailable, image_position: value.imagePosition, ...('imagePosition' in value ? { imagePosition: undefined } : {}) };
    const data = await request<ServerProduct>(`/admin/products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    return { product: product(data), display: display(data) };
  },
  async saveIikoPresentation(id: string, value: { image: string; imagePosition: string; badge: string; composition: string; pairsWith: string[] }) {
    const data = await request<{ image: string; image_position: string; badge: string; composition: string; pairs_with: string[] }>(`/admin/iiko-products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ image: value.image, image_position: value.imagePosition, badge: value.badge, composition: value.composition, pairs_with: value.pairsWith }) });
    return { image: data.image, imagePosition: data.image_position, badge: data.badge, composition: data.composition, pairsWith: data.pairs_with };
  },
  async adminOrders(filter: 'active' | 'all' = 'active') {
    const data = await request<Array<{ order_number: string; iiko_order_id: string | null; iiko_pos_id: string | null; table_number: string; terminal_label: string; items: CartLine[]; total: number; status_step: number; status: string; creation_status: string | null; source: 'tablet' | 'qr' | 'waiter'; created_at: string; updated_at: string; completed_at: string | null; history: Array<{ event_type: string; payload: Record<string, unknown>; created_at: string }> }>>(`/admin/orders?filter=${filter}`);
    return data.map((item): AdminOrder => ({ id: item.order_number, iikoOrderId: item.iiko_order_id, iikoPosId: item.iiko_pos_id, tableNumber: item.table_number, terminalLabel: item.terminal_label, items: item.items, total: Number(item.total), statusStep: Number(item.status_step), status: item.status, creationStatus: item.creation_status, source: item.source, createdAt: item.created_at, updatedAt: item.updated_at, completedAt: item.completed_at, history: item.history.map((event) => ({ eventType: event.event_type, payload: event.payload, createdAt: event.created_at })) }));
  },
  async qrCodes() { return (await request<ServerQrCode[]>('/admin/qr-codes')).map(qrCode); },
  async createQrCode(tableId: string) { return qrCode(await request<ServerQrCode>('/admin/qr-codes', { method: 'POST', body: JSON.stringify({ table_id: tableId }) })); },
  async generateAllQrCodes() { return (await request<ServerQrCode[]>('/admin/qr-codes/generate-all', { method: 'POST' })).map(qrCode); },
  async regenerateQrCode(id: string) { return qrCode(await request<ServerQrCode>(`/admin/qr-codes/${encodeURIComponent(id)}/regenerate`, { method: 'POST' })); },
  async setQrCodeActive(id: string, active: boolean) { return qrCode(await request<ServerQrCode>(`/admin/qr-codes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ is_active: active }) })); },
  async applicationDownloads() { return (await request<ServerApplicationDownload[]>('/admin/application-downloads')).map(applicationDownload); },
  async createApplicationDownload(value: { appKind: 'kiosk' | 'waiter'; label: string; expiresInHours: number }) { return applicationDownload(await request<ServerApplicationDownload>('/admin/application-downloads', { method: 'POST', body: JSON.stringify({ app_kind: value.appKind, label: value.label, expires_in_hours: value.expiresInHours }) })); },
  async updateApplicationDownload(id: string, status: 'installed' | 'revoked') { return applicationDownload(await request<ServerApplicationDownload>(`/admin/application-downloads/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status }) })); },
  async diagnostics(): Promise<AdminDiagnostics> {
    const data = await request<{ generated_at: string; api: { ok: boolean; uptime_seconds: number; started_at: string }; database: { ok: boolean; latency_ms: number }; disk: { ok: boolean; usedPercent: number | null }; menu: { active_products: number; updated_at: string | null }; iiko_orders: { ok: boolean; errors_24h: number; last_error_at: string | null }; webhook: { ok: boolean; errors_24h: number; events_24h: number; last_event_at: string | null }; iiko_sync: { ok: boolean; errors_24h: number; backoff_until: string | null }; incidents: Array<{ component: string; severity: 'warning' | 'error' | 'critical'; message: string; context: Record<string, unknown>; created_at: string }> }>('/admin/diagnostics');
    return { generatedAt: data.generated_at, api: { ok: data.api.ok, uptimeSeconds: data.api.uptime_seconds, startedAt: data.api.started_at }, database: { ok: data.database.ok, latencyMs: data.database.latency_ms }, disk: data.disk, menu: { activeProducts: data.menu.active_products, updatedAt: data.menu.updated_at }, iikoOrders: { ok: data.iiko_orders.ok, errors24h: data.iiko_orders.errors_24h, lastErrorAt: data.iiko_orders.last_error_at }, webhook: { ok: data.webhook.ok, errors24h: data.webhook.errors_24h, events24h: data.webhook.events_24h, lastEventAt: data.webhook.last_event_at }, iikoSync: { ok: data.iiko_sync.ok, errors24h: data.iiko_sync.errors_24h, backoffUntil: data.iiko_sync.backoff_until }, incidents: data.incidents.map((item) => ({ component: item.component, severity: item.severity, message: item.message, context: item.context, createdAt: item.created_at })) };
  },
  async security(): Promise<SecurityOverview> {
    const data = await request<{ generated_at: string; telegram: { configured: boolean; enabled: boolean; chat_id_masked: string; last_test_at: string | null; last_success_at: string | null; last_error: string | null }; automated: { status: 'passed' | 'warning' | 'failed' | 'unknown'; commit: string | null; passed: number; failed: number; duration_ms: number | null; created_at: string | null }; safe_run: { status: 'passed' | 'warning' | 'failed' | 'unknown'; passed: number; failed: number; created_at: string | null }; smoke: { status: 'passed' | 'warning' | 'failed' | 'unknown'; created_at: string | null; detail: string }; load: { status: 'passed' | 'warning' | 'failed' | 'unknown'; created_at: string | null; detail: string }; checks: Array<{ id: string; name: string; status: 'passed' | 'warning' | 'failed'; detail: string }>; backup: { status: 'passed' | 'warning' | 'failed'; last_at: string | null; age_hours: number | null; file: string | null } }>('/admin/security');
    return { generatedAt: data.generated_at, telegram: { configured: data.telegram.configured, enabled: data.telegram.enabled, chatIdMasked: data.telegram.chat_id_masked, lastTestAt: data.telegram.last_test_at, lastSuccessAt: data.telegram.last_success_at, lastError: data.telegram.last_error }, automated: { status: data.automated.status, commit: data.automated.commit, passed: data.automated.passed, failed: data.automated.failed, durationMs: data.automated.duration_ms, createdAt: data.automated.created_at }, safeRun: { status: data.safe_run.status, passed: data.safe_run.passed, failed: data.safe_run.failed, createdAt: data.safe_run.created_at }, smoke: { status: data.smoke.status, createdAt: data.smoke.created_at, detail: data.smoke.detail }, load: { status: data.load.status, createdAt: data.load.created_at, detail: data.load.detail }, checks: data.checks, backup: { status: data.backup.status, lastAt: data.backup.last_at, ageHours: data.backup.age_hours, file: data.backup.file } };
  },
  runSecurityChecks: () => request<SecurityOverview>('/admin/security/run', { method: 'POST' }),
  saveTelegram(value: { token: string; chatId: string; enabled: boolean; password: string }) { return request('/admin/security/telegram', { method: 'PUT', body: JSON.stringify({ token: value.token, chat_id: value.chatId, enabled: value.enabled, password: value.password }) }); },
  testTelegram: () => request<{ ok: true }>('/admin/security/telegram/test', { method: 'POST' }),
  runLoadTest: () => request('/admin/security/load', { method: 'POST' }),
  runIikoSmokeTest: (tableId: string, productId: string) => request('/admin/security/smoke', { method: 'POST', body: JSON.stringify({ table_id: tableId, product_id: productId, confirmation: 'СОЗДАТЬ ТЕСТОВЫЙ ЗАКАЗ' }) }),
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
  async promotions(refresh = false) {
    const data = await request<{ promotions: Array<{ id: number | string; code: string; name: string; iiko_discount_type_id: string; iiko_discount_name: string; discount_type: 'percent' | 'fixed'; value: number; min_order_total: number; active: boolean; starts_at: string | null; ends_at: string | null; usage_limit: number | null; uses_count: number }>; iikoDiscounts: IikoDiscountOption[] }>(`/admin/promotions${refresh ? '?refresh=1' : ''}`);
    return {
      promotions: data.promotions.map((item): AdminPromotion => ({ id: String(item.id), code: item.code, name: item.name, iikoDiscountTypeId: item.iiko_discount_type_id, iikoDiscountName: item.iiko_discount_name, discountType: item.discount_type, value: Number(item.value), minOrderTotal: Number(item.min_order_total), active: item.active, startsAt: item.starts_at, endsAt: item.ends_at, usageLimit: item.usage_limit === null ? null : Number(item.usage_limit), usesCount: Number(item.uses_count) })),
      iikoDiscounts: data.iikoDiscounts,
    };
  },
  createPromotion(value: { code: string; name: string; iikoDiscountTypeId: string; active: boolean; startsAt: string | null; endsAt: string | null; usageLimit: number | null }) {
    return request('/admin/promotions', { method: 'POST', body: JSON.stringify({ code: value.code, name: value.name, iiko_discount_type_id: value.iikoDiscountTypeId, active: value.active, starts_at: value.startsAt, ends_at: value.endsAt, usage_limit: value.usageLimit }) });
  },
  updatePromotion(id: string, value: { active: boolean }) {
    return request(`/admin/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) });
  },
  deletePromotion(id: string) { return request<void>(`/admin/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
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
  async recordBannerImpression(id: string) { return request<{ counted: boolean; exhausted: boolean; impressions: number }>(`/banners/${id}/impression`, { method: 'POST', body: JSON.stringify({ terminal_id: activeTerminalId }) }); },
  waiters: () => request<WaiterProfile[]>('/admin/waiters'),
  createWaiter: (value: { name: string; pin: string }) => request<WaiterProfile>('/admin/waiters', { method: 'POST', body: JSON.stringify(value) }),
  updateWaiter: (id: string, value: { pin?: string; isActive?: boolean }) => request<WaiterProfile>(`/admin/waiters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ pin: value.pin ?? '', is_active: value.isActive }) }),
  iikoFront: () => request<IikoFrontOverview>('/admin/iiko-front'),
  createIikoFrontPairingCode: () => request<{ code: string; expiresAt: string }>('/admin/iiko-front/pairing-code', { method: 'POST' }),
  revokeIikoFrontBridge: (id: string) => request<void>(`/admin/iiko-front/bridges/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setIikoEmployeeAccess: (id: string, enabled: boolean) => request(`/admin/iiko-employees/${encodeURIComponent(id)}/access`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  adminUsers: () => request<AdminUserProfile[]>('/admin/users'),
  createAdminUser: (value: { username: string; name: string; password: string; role: 'administrator' | 'hostess' }) => request<AdminUserProfile>('/admin/users', { method: 'POST', body: JSON.stringify(value) }),
  updateAdminUser: (id: string, value: { password?: string; role: 'administrator' | 'hostess'; isActive: boolean }) => request<AdminUserProfile>(`/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ password: value.password ?? '', role: value.role, is_active: value.isActive }) }),
  audit: () => request<Array<{ id: number; action: string; entity: string; entity_id: string; created_at: string }>>('/admin/audit'),
};
