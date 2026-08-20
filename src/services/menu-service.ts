import type { Catalog, MenuCategory, Product } from '../types/menu';

export const ALL_MENU_CATEGORY = 'all';

let catalog: Catalog = { menu: [], categories: [] };
let byId = new Map<string, Product>();
let ready = false;

function derivedCategories(products: Product[]): MenuCategory[] {
  const result: MenuCategory[] = [];
  products.forEach((product) => {
    const names = product.categories?.length ? product.categories : [product.category];
    const ids = product.categoryIds?.length ? product.categoryIds : names.map((name) => `local:${name}`);
    names.forEach((name, index) => {
      const id = ids[index] ?? `local:${name}`;
      let category = result.find((item) => item.id === id);
      if (!category) { category = { id, name, productIds: [] }; result.push(category); }
      if (!category.productIds.includes(product.id)) category.productIds.push(product.id);
    });
  });
  return result;
}

export function setCatalog(products: Product[], categories?: MenuCategory[]) {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const sourceCategories = categories !== undefined
    ? (categories.length ? categories : derivedCategories(products))
    : (catalog.categories.length ? catalog.categories : derivedCategories(products));
  const normalizedCategories = sourceCategories.map((category) => ({
    ...category,
    productIds: category.productIds.filter((id) => productsById.has(id)),
  })).filter((category) => category.productIds.length);
  const orderedIds = normalizedCategories.flatMap((category) => category.productIds);
  const seen = new Set<string>();
  const orderedProducts = [...orderedIds, ...products.map((product) => product.id)]
    .filter((id) => !seen.has(id) && Boolean(seen.add(id)))
    .map((id) => productsById.get(id))
    .filter(Boolean) as Product[];

  catalog = { menu: orderedProducts, categories: normalizedCategories };
  byId = new Map(orderedProducts.map((product) => [product.id, product]));
  ready = true;
}

export const menuService = {
  ready: () => ready,
  all: () => catalog.menu,
  find: (id: string) => byId.get(id),
  categories: () => catalog.categories,
  hasCategory: (id: string) => id === ALL_MENU_CATEGORY || catalog.categories.some((category) => category.id === id),
  byCategory: (categoryId: string) => {
    if (categoryId === ALL_MENU_CATEGORY) return catalog.menu;
    const category = catalog.categories.find((item) => item.id === categoryId);
    return category ? category.productIds.map((id) => byId.get(id)).filter(Boolean) as Product[] : [];
  },
  search: (query: string, categoryId: string) => {
    const normalized = query.trim().toLocaleLowerCase('ru');
    const products = normalized ? catalog.menu : menuService.byCategory(categoryId);
    return products.filter((product) => !normalized || `${product.name} ${product.description ?? ''}`.toLocaleLowerCase('ru').includes(normalized));
  },
  related: (product: Product) => (product.pairs_with ?? []).map((id) => byId.get(id)).filter(Boolean) as Product[],
  featured: (amount = 6) => {
    const mentions = new Map<string, number>();
    catalog.menu.forEach((product) => product.pairs_with?.forEach((id) => mentions.set(id, (mentions.get(id) ?? 0) + 1)));
    return [...catalog.menu].sort((a, b) => (mentions.get(b.id) ?? 0) - (mentions.get(a.id) ?? 0) || a.price_rub - b.price_rub).slice(0, amount);
  },
  recent: (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as Product[],
};
