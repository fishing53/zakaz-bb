import type { MenuCategory, Product, ProductDisplaySettings } from '../types/menu';
import { productCard } from '../components/product-card';
import { escapeHtml } from '../utils/helpers';
import { icon } from '../components/icons';

export function menuResults(products: Product[], selected: string, search: string, recent: Product[], display: Record<string, ProductDisplaySettings> = {}, ready = true) {
  const card = (product: Product, compact = false) => productCard(product, compact, display[product.id]);
  const recentSection = recent.length && !search && selected === 'all' ? `<div class="recent-row"><span class="eyebrow">ВЫ НЕДАВНО СМОТРЕЛИ</span><h2>Вернуться к выбору</h2><div class="recent-row__items">${recent.slice(0, 4).map((product) => card(product, true)).join('')}</div></div>` : '';
  const empty = ready ? 'Ничего не нашли. Попробуйте другой запрос.' : 'Готовим меню для вас…';
  return `${recentSection}<div class="menu-grid">${products.map((product) => card(product)).join('')}</div>${products.length ? '' : `<div class="empty-state">${empty}</div>`}`;
}

export function menuPage(categories: MenuCategory[], products: Product[], selected: string, search: string, recent: Product[], display: Record<string, ProductDisplaySettings> = {}, ready = true, searchOpen = false) {
  const tabs = [{ id: 'all', name: 'Все блюда' }, ...categories];
  return `<section class="menu-page"><header class="menu-toolbar"><nav class="category-nav">${tabs.map((category) => `<button data-action="select-category" data-category="${escapeHtml(category.id)}" class="${selected === category.id ? 'is-active' : ''}">${escapeHtml(category.name)}</button>`).join('')}</nav><div class="search-box${search || searchOpen ? ' is-open' : ''}" role="search"><button type="button" class="search-box__open" data-action="open-search" aria-label="Открыть поиск">${icon('search')}</button><input aria-label="Поиск блюд" data-action="search" value="${escapeHtml(search)}" placeholder="Поиск по всему меню..." autocomplete="off"/><button type="button" class="search-box__close" data-action="close-search" aria-label="Закрыть поиск">${icon('close')}</button></div></header><section class="menu-content" data-menu-results>${menuResults(products, selected, search, recent, display, ready)}</section></section>`;
}
