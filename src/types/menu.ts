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
}

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
}

export interface Promotion {
  id: string;
  productId: string;
  title: string;
  subtitle: string;
  label: string;
  active: boolean;
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
}

export type RouteName = 'welcome' | 'menu' | 'order' | 'orders' | 'payment' | 'status' | 'admin';
export type OrderType = 'dine-in' | 'takeaway' | 'pickup' | null;
