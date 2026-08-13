export interface KBJU { calories: string; protein: string; fat: string; carbs: string }

export interface Product {
  id: string;
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

export interface IikoModifier { productId: string; name: string; price: number; defaultQuantity?: number; minQuantity?: number; maxQuantity?: number }
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
  modifiers?: Array<{ productId: string; name: string; amount: number; price: number }>;
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
