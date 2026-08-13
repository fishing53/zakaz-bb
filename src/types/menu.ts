export interface KBJU { calories: string; protein: string; fat: string; carbs: string }

export interface Product {
  id: string;
  sku?: string;
  name: string;
  category: string;
  price_rub: number;
  portion: string;
  unit: string;
  description: string | null;
  kbju: KBJU | null;
  image: string;
  source_url: string;
  sauce_options?: string[];
  sauce_addon_price_rub?: string;
  addon_options?: string[];
  flavor_options?: string[];
  size_option?: string[] | string;
  pairs_with?: string[];
  recommendations_note?: string;
  modifier_groups?: IikoModifierGroup[];
}

export interface IikoModifier { productId: string; name: string; price: number; image?: string; defaultQuantity?: number; minQuantity?: number; maxQuantity?: number }
export interface IikoModifierGroup { name: string; minQuantity?: number; maxQuantity?: number; freeQuantity?: number; items: IikoModifier[] }

export interface Catalog { menu: Product[] }

export interface CartLine {
  key: string;
  productId: string;
  quantity: number;
  kind?: 'product' | 'sauce';
  customName?: string;
  customPrice?: number;
  sauce?: string;
  addon?: string;
  flavor?: string;
  modifiers?: Array<{ productId: string; name: string; amount: number; price: number; image?: string; maxQuantity?: number }>;
}

export interface Banner {
  id: string;
  name: string;
  image: string;
  productId: string | null;
  kind: 'restaurant' | 'advertising';
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  impressionLimit: number | null;
  impressions: number;
  sortOrder: number;
}

export interface ProductDisplaySettings {
  badge: string;
  unavailable: boolean;
  imagePosition?: string;
  allergens?: string;
  spicy?: 'none' | 'mild' | 'hot';
}

export interface SubmittedOrder {
  id: string;
  items: CartLine[];
  total: number;
  statusStep: number;
  createdAt: string;
  orderType: OrderType;
  tableNumber?: string;
}

export interface AdminOrder {
  id: string;
  iikoOrderId: string | null;
  iikoPosId: string | null;
  tableNumber: string;
  terminalLabel: string;
  items: CartLine[];
  total: number;
  statusStep: number;
  status: string;
  creationStatus: string | null;
  source: 'tablet' | 'qr' | 'waiter';
  createdAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  history: Array<{ eventType: string; payload: Record<string, unknown>; createdAt: string }>;
}

export interface AdminDiagnostics {
  generatedAt: string;
  api: { ok: boolean; uptimeSeconds: number; startedAt: string };
  database: { ok: boolean; latencyMs: number };
  disk: { ok: boolean; usedPercent: number | null };
  menu: { activeProducts: number; updatedAt: string | null };
  iikoOrders: { ok: boolean; errors24h: number; lastErrorAt: string | null };
  webhook: { ok: boolean; errors24h: number; events24h: number; lastEventAt: string | null };
  iikoSync: { ok: boolean; errors24h: number; backoffUntil: string | null };
  incidents: Array<{ component: string; severity: 'warning' | 'error' | 'critical'; message: string; context: Record<string, unknown>; createdAt: string }>;
}

export interface IikoConnectionConfig {
  apiBase: string;
  organizationId: string;
  terminalGroupId: string;
  externalMenuId: string;
  orderTypeId: string;
  orderSourceKey: string;
  appIdConfigured: boolean;
  apiLoginConfigured: boolean;
  clientSecretConfigured: boolean;
  webhookTokenConfigured: boolean;
  updatedAt: string | null;
  configuredBy: string;
  lastTestAt: string | null;
  lastTestDetails: Record<string, unknown> | null;
  allowedApiBases: string[];
  webhookUrl: string;
}

export interface IikoConnectionTest {
  organizationName: string;
  menuItems: number;
  tables: number;
  orderTypes: number;
  responseMs: number;
}

export interface IikoConnectionDiscovery {
  discoveryToken: string;
  organizations: Array<{ id: string; name: string; code: string }>;
  recommendedOrganizationId: string;
}

export interface IikoRestaurantOptions {
  terminalGroups: Array<{ id: string; name: string; address: string }>;
  externalMenus: Array<{ id: string; name: string }>;
  orderTypes: Array<{ id: string; name: string }>;
  recommendedTerminalGroupId: string;
  recommendedExternalMenuId: string;
  orderTypeId: string;
}

export interface IikoConnectionSelection {
  discoveryToken: string;
  organizationId: string;
  terminalGroupId: string;
  externalMenuId: string;
}

export interface TerminalSettings {
  id: string;
  label: string;
  tableNumber: string;
  isActive: boolean;
  idleSeconds: number;
  tableSource?: 'admin' | 'guest' | null;
  tableId?: string | null;
}

export interface RestaurantTable { id: string; section: string; number: string; name: string }

export type RouteName = 'welcome' | 'table' | 'menu' | 'order' | 'orders' | 'payment' | 'status' | 'admin';
export type OrderType = 'dine-in' | 'takeaway' | 'pickup' | null;
