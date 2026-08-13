import type { Product, ProductDisplaySettings } from '../types/menu';
import { productCard } from '../components/product-card';
import { escapeHtml } from '../utils/helpers';
import { icon } from '../components/icons';

export function menuResults(products: Product[], selected: string, search: string, recent: Product[], display: Record<string, ProductDisplaySettings> = {}, ready = true) {
  const card = (product: Product, compact = false) => productCard(product, compact, display[product.id]);
  const recentSection = recent.length && !search && selected === 'Все блюда' ? `<div class="recent-row"><span class="eyebrow">ВЫ НЕДАВНО СМОТРЕЛИ</span><h2>Вернуться к выбору</h2><div class="recent-row__items">${recent.slice(0, 4).map((product) => card(product, true)).join('')}</div></div>` : '';
  const empty = ready ? 'Ничего не нашли. Попробуйте другой запрос.' : 'Загружаем актуальное меню…';
  return `${recentSection}<div class="menu-grid">${products.map((product) => card(product)).join('')}</div>${products.length ? '' : `<div class="empty-state">${empty}</div>`}`;
}

export function menuPage(categories: string[], products: Product[], selected: string, search: string, recent: Product[], display: Record<string, ProductDisplaySettings> = {}, ready = true) {
  return `<section class="menu-page"><header class="menu-toolbar"><nav class="category-nav">${['Все блюда', ...categories].map((category) => `<button data-action="select-category" data-category="${escapeHtml(category)}" class="${selected === category ? 'is-active' : ''}">${escapeHtml(category)}</button>`).join('')}</nav><label class="search-box${search ? ' is-open' : ''}" aria-label="Поиск блюд">${icon('search')}<input data-action="search" value="${escapeHtml(search)}" placeholder="Поиск блюд..." autocomplete="off"/></label></header><section class="menu-content" data-menu-results>${menuResults(products, selected, search, recent, display, ready)}</section></section>`;
}
