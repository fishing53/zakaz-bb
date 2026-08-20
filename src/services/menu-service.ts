import type { Catalog, Product } from '../types/menu';

let catalog: Catalog = { menu: [] };
let byId = new Map<string, Product>();
let ready = false;

export function setCatalog(products: Product[]) {
  catalog = { menu: products };
  byId = new Map(products.map((product) => [product.id, product]));
  ready = true;
}

export const menuService = {
  ready: () => ready,
  all: () => catalog.menu,
  find: (id: string) => byId.get(id),
  categories: () => [...new Set(catalog.menu.flatMap((product) => product.categories?.length ? product.categories : [product.category]))],
  byCategory: (category: string) => catalog.menu.filter((product) => (product.categories?.length ? product.categories : [product.category]).includes(category)),
  search: (query: string, category: string) => {
    const normalized = query.trim().toLocaleLowerCase('ru');
    return catalog.menu.filter((product) => (category === 'Все блюда' || (product.categories?.length ? product.categories : [product.category]).includes(category))
      && (!normalized || `${product.name} ${product.description ?? ''}`.toLocaleLowerCase('ru').includes(normalized)));
  },
  related: (product: Product) => (product.pairs_with ?? []).map((id) => byId.get(id)).filter(Boolean) as Product[],
  featured: (amount = 6) => {
    const mentions = new Map<string, number>();
    catalog.menu.forEach((product) => product.pairs_with?.forEach((id) => mentions.set(id, (mentions.get(id) ?? 0) + 1)));
    return [...catalog.menu].sort((a, b) => (mentions.get(b.id) ?? 0) - (mentions.get(a.id) ?? 0) || a.price_rub - b.price_rub).slice(0, amount);
  },
  recent: (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as Product[],
};
