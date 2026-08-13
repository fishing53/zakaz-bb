import type { Product, ProductDisplaySettings } from '../types/menu';
import { escapeHtml, formatPrice, imageStyle } from '../utils/helpers';
import { icon } from './icons';

const choice = (name: string, values?: string[], multiple = false, price = 0) => values?.length
  ? `<section class="option-group" data-multiple="${multiple}" data-option-group="${name}"><div class="option-group__heading"><h3>${name}</h3>${multiple ? '<span><b data-sauce-count>0</b> выбрано</span>' : ''}</div><div class="option-chips">${values.map((value, index) => `<button data-action="set-option" data-option="${name}" data-value="${escapeHtml(value)}" class="option-chip${name === 'Соусы' ? ' option-chip--sauce' : ''}${!multiple && index === 0 ? ' is-selected' : ''}"><span class="option-chip__check">${icon('check')}</span><span class="option-chip__label">${escapeHtml(value)}</span>${name === 'Соусы' ? `<small>${price ? `+${formatPrice(price)}` : 'Бесплатно'}</small>` : ''}</button>`).join('')}</div></section>`
  : '';

const iikoChoices = (product: Product) => (product.modifier_groups ?? []).map((group, groupIndex) => group.items.length ? `<section class="option-group" data-multiple="${(group.maxQuantity ?? 99) > 1}" data-min-quantity="${group.minQuantity ?? 0}" data-iiko-group="${groupIndex}"><div class="option-group__heading"><h3>${escapeHtml(group.name)}</h3><span>${group.minQuantity ? `Выберите от ${group.minQuantity}` : 'По желанию'}</span></div><div class="option-chips">${group.items.map((item) => `<button data-action="set-option" data-iiko-modifier="true" data-product-id="${escapeHtml(item.productId)}" data-value="${escapeHtml(item.name)}" data-price="${item.price}" data-image="${escapeHtml(item.image || '/images/sauce-fallback.webp')}" data-allergens="${escapeHtml(item.allergens ?? '')}" data-max-quantity="${item.maxQuantity ?? group.maxQuantity ?? 20}" class="option-chip${item.defaultQuantity ? ' is-selected' : ''}"><span class="option-chip__check">${icon('check')}</span><span class="option-chip__label">${escapeHtml(item.name)}</span><small>${item.price ? `+${formatPrice(item.price)}` : 'Включено'}</small></button>`).join('')}</div></section>` : '').join('');

const spicyLabel = (level?: ProductDisplaySettings['spicy']) => level === 'hot'
  ? '<span class="product-fact product-fact--hot">Острое</span>'
  : level === 'mild' ? '<span class="product-fact product-fact--mild">Слегка острое</span>' : '';

export function productModal(product: Product | undefined, display: ProductDisplaySettings = { badge: '', unavailable: false }, allDisplay: Record<string, ProductDisplaySettings> = {}) {
  if (!product) return '';
  const related = product.pairs_with ?? [];
  const saucePrice = Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0;
  const baseAllergens = display.allergens?.trim() ?? '';
  const allergens = [...new Map([baseAllergens, ...(product.modifier_groups ?? []).flatMap((group) => group.items.filter((item) => item.defaultQuantity).map((item) => item.allergens ?? ''))]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => [value.toLocaleLowerCase('ru-RU'), value])).values()].join(', ');
  return `<div class="overlay product-overlay" data-action="close-product">
    <section class="product-modal">
      <button class="modal__close" data-action="close-product" aria-label="Вернуться к меню">${icon('close')}</button>
      <div class="product-modal__visual" ${imageStyle(product.image, display.imagePosition)}><button class="product-modal__back" data-action="close-product"><span>К меню</span></button></div>
      <div class="product-modal__body">
        <div class="product-modal__scroll">
          <h2><span>${escapeHtml(product.name)}</span>${product.portion || product.unit ? `<small class="product-modal__weight">, ${escapeHtml(product.portion)} ${escapeHtml(product.unit)}</small>` : ''}</h2>
          <section class="product-modal__composition"><h3>Состав</h3><p class="product-modal__description">${escapeHtml(product.description || 'Состав блюда уточнит официант.')}</p></section>
          <div class="product-facts">${spicyLabel(display.spicy)}<span class="product-fact product-fact--allergens" data-product-allergens data-base-allergens="${escapeHtml(baseAllergens)}">${allergens ? `Аллергены: ${escapeHtml(allergens)}` : 'Аллергены уточняйте у официанта'}</span></div>
          ${product.kbju ? `<section class="nutrition-details"><header class="nutrition-details__heading"><h3>КБЖУ</h3><small>НА 100 Г</small></header><div class="nutrition"><div><span><b>${escapeHtml(product.kbju.calories)}</b><small>ККАЛ</small></span><span><b>${escapeHtml(product.kbju.protein)}</b><small>БЕЛКИ</small></span><span><b>${escapeHtml(product.kbju.fat)}</b><small>ЖИРЫ</small></span><span><b>${escapeHtml(product.kbju.carbs)}</b><small>УГЛЕВОДЫ</small></span></div></div></section>` : ''}
          ${choice('Соусы', product.sauce_options, true, saucePrice)}
          ${choice('Добавки', product.addon_options)}
          ${choice('Вкус', product.flavor_options)}
          ${iikoChoices(product)}
          ${related.length ? `<section class="modal-related"><h3>Идеально с этим блюдом</h3><div class="related-grid" data-related-for="${escapeHtml(product.id)}"></div></section>` : ''}
          ${/* Блок «Ваш выбор» временно убран. Состав по-прежнему формируется из выбранных опций, а итог показывается на кнопке. */ ''}
        </div>
        <footer class="product-modal__actions">
          <div class="product-modal__quantity" aria-label="Количество блюд"><button data-action="change-modal-quantity" data-delta="-1" aria-label="Уменьшить количество">${icon('minus')}</button><strong data-modal-quantity>1</strong><button data-action="change-modal-quantity" data-delta="1" aria-label="Увеличить количество">${icon('plus')}</button></div>
          <button class="button button--primary button--wide product-modal__submit" data-action="add-product" data-product-id="${escapeHtml(product.id)}"><span>Добавить в заказ</span><strong data-modal-total>${formatPrice(product.price_rub)}</strong></button>
        </footer>
      </div>
    </section>
  </div>`;
}

export function relatedCards(products: Product[], display: Record<string, ProductDisplaySettings>) {
  return products.slice(0, 4).map((item) => `<button class="related-choice" data-action="toggle-related" data-product-id="${escapeHtml(item.id)}" data-product-name="${escapeHtml(item.name)}" data-price="${item.price_rub}" ${imageStyle(item.image, display[item.id]?.imagePosition)}><span class="related-choice__check">${icon('check')}</span><span>${escapeHtml(item.name)}</span><b>${formatPrice(item.price_rub)}</b></button>`).join('');
}
