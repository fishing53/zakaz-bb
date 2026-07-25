import type { Product } from '../types/menu';
import { escapeHtml, formatPrice, imageStyle } from '../utils/helpers';
import { icon } from './icons';

export function upsellSheet(product: Product | undefined) {
  if (!product) return '';
  return `<aside class="upsell-sheet" aria-live="polite"><button class="upsell-sheet__close" data-action="dismiss-upsell" aria-label="Закрыть">${icon('close')}</button><div class="upsell-sheet__image" ${imageStyle(product.image)}></div><div class="upsell-sheet__content"><span class="eyebrow">СОЧЕТАЕТСЯ ИДЕАЛЬНО</span><h3>Добавить ${escapeHtml(product.name)}?</h3><p>${formatPrice(product.price_rub)} · ${escapeHtml(product.portion)} ${escapeHtml(product.unit)}</p><button class="button button--primary" data-action="accept-upsell" data-product-id="${escapeHtml(product.id)}">Добавить ${icon('plus')}</button></div></aside>`;
}
