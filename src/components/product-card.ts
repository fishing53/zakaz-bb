import type { Product, ProductDisplaySettings } from '../types/menu';
import { escapeHtml, formatPrice, imageStyle } from '../utils/helpers';

export function productCard(product: Product, compact = false, display: ProductDisplaySettings = { badge: '', unavailable: false }) {
  return `<article class="product-card ${compact ? 'product-card--compact' : ''} ${display.unavailable ? 'is-unavailable' : ''}" data-action="${display.unavailable ? '' : 'open-product'}" data-product-id="${escapeHtml(product.id)}" ${imageStyle(product.image, display.imagePosition)}>
    <div class="product-card__image">${display.badge ? `<span class="product-card__badge">${escapeHtml(display.badge)}</span>` : ''}${display.unavailable ? '<img class="product-card__stop-stamp" src="/images/stop-list-stamp.png" alt="Стоп-лист">' : ''}</div>
    <div class="product-card__content"><h3>${escapeHtml(product.name)}</h3><div class="product-card__meta"><strong>${formatPrice(product.price_rub)}</strong><span>${escapeHtml(product.portion)} ${escapeHtml(product.unit)}</span></div></div>
  </article>`;
}
