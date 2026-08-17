import type { Banner, CartLine, OrderType, ProductDisplaySettings, PromoRule, RestaurantTable, SubmittedOrder, TerminalSettings } from '../types/menu';
import { storage } from '../services/storage';

export interface AppState {
  category: string;
  cart: CartLine[];
  comment: string;
  productDisplay: Record<string, ProductDisplaySettings>;
  language: 'ru' | 'en';
  isOnline: boolean;
  adminAuthenticated: boolean;
  adminLoginOpen: boolean;
  adminScope: 'terminal' | 'restaurant' | null;
  adminRole: 'administrator' | 'hostess' | 'terminal_manager' | null;
  adminProductId: string | null;
  adminTab: 'terminal' | 'orders' | 'menu' | 'banners' | 'qr' | 'promotions' | 'staff' | 'quality' | 'security' | 'audit';
  inactivityWarning: boolean;
  inactivitySeconds: number;
  orderNumber: string | null;
  orders: SubmittedOrder[];
  selectedOrderId: string | null;
  orderType: OrderType;
  promoCode: string;
  promoRule: PromoRule | null;
  pendingOrderRequestId: string | null;
  productId: string | null;
  pwaUpdateReady: boolean;
  banners: Banner[];
  recentProductIds: string[];
  search: string;
  serviceOpen: boolean;
  statusStep: number;
  toast: string | null;
  terminal: TerminalSettings | null;
  tables: RestaurantTable[];
  upsellId: string | null;
}

const persisted = storage.get<Pick<AppState, 'cart' | 'language' | 'orderNumber' | 'orders' | 'selectedOrderId' | 'statusStep' | 'orderType' | 'recentProductIds' | 'banners' | 'productDisplay' | 'pendingOrderRequestId'>>('bb-kiosk', {
  cart: [], language: 'ru', orderNumber: null, orders: [], selectedOrderId: null, statusStep: 0, orderType: null, recentProductIds: [], banners: [], productDisplay: {}, pendingOrderRequestId: null,
});
const restoredOrders: SubmittedOrder[] = persisted.orders ?? (persisted.orderNumber ? [{
  id: persisted.orderNumber,
  items: [],
  total: 0,
  statusStep: persisted.statusStep ?? 0,
  createdAt: new Date().toISOString(),
  orderType: persisted.orderType ?? null,
}] : []);

let state: AppState = {
  category: 'Все блюда',
  comment: '',
  isOnline: navigator.onLine,
  adminAuthenticated: false,
  adminLoginOpen: false,
  adminScope: null,
  adminRole: null,
  adminProductId: null,
  adminTab: 'terminal',
  inactivityWarning: false,
  inactivitySeconds: 15,
  productId: null,
  promoCode: '',
  promoRule: null,
  pwaUpdateReady: false,
  search: '',
  serviceOpen: false,
  toast: null,
  terminal: null,
  tables: [],
  upsellId: null,
  ...persisted,
  pendingOrderRequestId: persisted.pendingOrderRequestId ?? null,
  cart: persisted.cart ?? [],
  language: persisted.language ?? 'ru',
  orderNumber: persisted.orderNumber ?? restoredOrders[0]?.id ?? null,
  orders: restoredOrders,
  selectedOrderId: persisted.selectedOrderId ?? restoredOrders[0]?.id ?? null,
  orderType: persisted.orderType ?? null,
  banners: persisted.banners ?? [],
  recentProductIds: persisted.recentProductIds ?? [],
  statusStep: persisted.statusStep ?? 0,
  productDisplay: persisted.productDisplay ?? {},
};
const subscribers = new Set<(value: AppState) => void>();
const persistedKeys = new Set<keyof AppState>(['cart', 'language', 'orderNumber', 'orders', 'selectedOrderId', 'statusStep', 'orderType', 'recentProductIds', 'banners', 'productDisplay', 'pendingOrderRequestId']);

function persist() {
  storage.set('bb-kiosk', { cart: state.cart, language: state.language, orderNumber: state.orderNumber, orders: state.orders, selectedOrderId: state.selectedOrderId, statusStep: state.statusStep, orderType: state.orderType, recentProductIds: state.recentProductIds, banners: state.banners, productDisplay: state.productDisplay, pendingOrderRequestId: state.pendingOrderRequestId });
}

export const appStore = {
  get: () => state,
  set(patch: Partial<AppState>, notify = true) {
    const entries = Object.entries(patch) as Array<[keyof AppState, AppState[keyof AppState]]>;
    if (!entries.some(([key, value]) => state[key] !== value)) return;
    state = { ...state, ...patch };
    if (entries.some(([key]) => persistedKeys.has(key))) persist();
    if (notify) subscribers.forEach((subscriber) => subscriber(state));
  },
  subscribe(subscriber: (value: AppState) => void) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
  resetOrder() { this.set({ cart: [], comment: '', orderNumber: null, orderType: null, promoCode: '', promoRule: null, pendingOrderRequestId: null, productId: null, serviceOpen: false, statusStep: 0, upsellId: null, inactivityWarning: false, inactivitySeconds: 15 }); },
};
