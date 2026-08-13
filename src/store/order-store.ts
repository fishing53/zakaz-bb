import { menuService } from '../services/menu-service';
import { appStore } from './app-store';
import type { CartLine, Product } from '../types/menu';

const lineKey = (line: Pick<CartLine, 'productId' | 'kind' | 'customName' | 'sauce' | 'addon' | 'flavor' | 'modifiers'>) => [line.kind, line.productId, line.customName, line.sauce, line.addon, line.flavor, line.modifiers?.map((item) => `${item.productId}:${item.amount}`).join(',')].filter(Boolean).join('|');
const linePrice = (line: CartLine) => (line.customPrice ?? menuService.find(line.productId)?.price_rub ?? 0) + (line.modifiers ?? []).reduce((sum, item) => sum + item.price * item.amount, 0);
const modifierLimit = (line: CartLine, modifierId: string) => {
  const stored = line.modifiers?.find((modifier) => modifier.productId === modifierId)?.maxQuantity;
  if (stored && stored > 0) return stored;
  const product = menuService.find(line.productId);
  for (const group of product?.modifier_groups ?? []) {
    const modifier = group.items.find((item) => item.productId === modifierId);
    if (modifier) return modifier.maxQuantity || group.maxQuantity || 20;
  }
  return 20;
};
const append = (cart: CartLine[], next: Omit<CartLine, 'key' | 'quantity'>) => {
  const key = lineKey(next);
  const found = cart.find((line) => line.key === key);
  if (found) found.quantity += 1;
  else cart.push({ key, quantity: 1, ...next });
};

export const orderStore = {
  lines: () => appStore.get().cart,
  product: (line: CartLine): Product | undefined => {
    const product = menuService.find(line.productId);
    if (!line.customName) return product;
    return {
      id: line.key, name: line.customName, category: line.kind === 'sauce' ? 'Соусы' : product?.category ?? 'Заказ', price_rub: line.customPrice ?? product?.price_rub ?? 0,
      portion: '1', unit: 'шт.', description: null, kbju: null, image: product?.image ?? '/icons/app-icon.svg', source_url: '',
    };
  },
  subtotal: () => appStore.get().cart.reduce((sum, line) => sum + linePrice(line) * line.quantity, 0),
  discount: () => appStore.get().promoCode.trim().toUpperCase() === 'BOWL10' ? Math.round(orderStore.subtotal() * .1) : 0,
  total: () => Math.max(0, orderStore.subtotal() - orderStore.discount()),
  count: () => appStore.get().cart.reduce((sum, line) => sum + line.quantity + (line.modifiers ?? []).reduce((modifierSum, modifier) => modifierSum + modifier.amount * line.quantity, 0), 0),
  add(product: Product, options: Omit<CartLine, 'key' | 'productId' | 'quantity'> = {}) {
    const next = { productId: product.id, kind: 'product' as const, ...options };
    const cart = appStore.get().cart.map((line) => ({ ...line }));
    append(cart, next);
    appStore.set({ cart, upsellId: null, pendingOrderRequestId: null });
  },
  addSauce(product: Product, name: string) {
    const price = Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0;
    const next = { productId: product.id, kind: 'sauce' as const, customName: `Соус «${name}»`, customPrice: price };
    const cart = appStore.get().cart.map((line) => ({ ...line }));
    append(cart, next);
    appStore.set({ cart, pendingOrderRequestId: null });
  },
  addBundle(product: Product, options: Omit<CartLine, 'key' | 'productId' | 'quantity'>, sauces: string[], related: Product[], quantity = 1) {
    const cart = appStore.get().cart.map((line) => ({ ...line }));
    for (let index = 0; index < quantity; index += 1) append(cart, { productId: product.id, kind: 'product', ...options });
    const saucePrice = Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0;
    sauces.forEach((name) => append(cart, { productId: product.id, kind: 'sauce', customName: `Соус «${name}»`, customPrice: saucePrice }));
    related.forEach((item) => append(cart, { productId: item.id, kind: 'product' }));
    appStore.set({ cart, productId: null, upsellId: null, pendingOrderRequestId: null });
  },
  change(key: string, delta: number, notify = true) {
    const cart = appStore.get().cart.map((line) => line.key === key ? { ...line, quantity: line.quantity + delta } : line).filter((line) => line.quantity > 0);
    appStore.set({ cart, pendingOrderRequestId: null }, notify);
  },
  changeModifier(key: string, modifierId: string, delta: number) {
    const cart: CartLine[] = appStore.get().cart.map((line) => ({ ...line, ...(line.modifiers ? { modifiers: line.modifiers.map((modifier) => ({ ...modifier })) } : {}) }));
    const index = cart.findIndex((line) => line.key === key);
    const modifier = cart[index]?.modifiers?.find((item) => item.productId === modifierId);
    if (index < 0 || !modifier) return false;
    const nextAmount = modifier.amount + delta;
    if (nextAmount > modifierLimit(cart[index], modifierId)) return false;
    if (nextAmount <= 0) {
      const modifiers = (cart[index].modifiers ?? []).filter((item) => item.productId !== modifierId);
      cart[index] = { ...cart[index], modifiers: modifiers.length ? modifiers : undefined };
    } else {
      modifier.amount = nextAmount;
    }
    cart[index].key = lineKey(cart[index]);
    const duplicateIndex = cart.findIndex((line, lineIndex) => lineIndex !== index && line.key === cart[index].key);
    if (duplicateIndex >= 0) {
      cart[duplicateIndex].quantity += cart[index].quantity;
      cart.splice(index, 1);
    }
    appStore.set({ cart, pendingOrderRequestId: null });
    return true;
  },
  removeModifier(key: string, modifierId: string) {
    const cart: CartLine[] = appStore.get().cart.map((line) => ({ ...line, ...(line.modifiers ? { modifiers: line.modifiers.map((modifier) => ({ ...modifier })) } : {}) }));
    const index = cart.findIndex((line) => line.key === key);
    if (index < 0) return;
    const modifiers = (cart[index].modifiers ?? []).filter((modifier) => modifier.productId !== modifierId);
    const updated: CartLine = { ...cart[index], modifiers: modifiers.length ? modifiers : undefined };
    updated.key = lineKey(updated);
    const duplicateIndex = cart.findIndex((line, lineIndex) => lineIndex !== index && line.key === updated.key);
    if (duplicateIndex >= 0) {
      cart[duplicateIndex].quantity += updated.quantity;
      cart.splice(index, 1);
    } else {
      cart[index] = updated;
    }
    appStore.set({ cart, pendingOrderRequestId: null });
  },
  remove(key: string) { appStore.set({ cart: appStore.get().cart.filter((line) => line.key !== key), pendingOrderRequestId: null }); },
};
