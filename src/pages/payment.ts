import type { CartLine, Product } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

export const paymentPage = (lines: CartLine[], productFor: (line: CartLine) => Product | undefined, subtotal: number, discount: number, total: number, comment: string) => {
  const saucesByProduct = new Map<string, CartLine[]>();
  lines.filter((line) => line.kind === 'sauce').forEach((line) => saucesByProduct.set(line.productId, [...(saucesByProduct.get(line.productId) ?? []), line]));
  const dishes = lines.filter((line) => line.kind !== 'sauce');
  const reviewLines = dishes.map((line) => {
    const product = productFor(line);
    if (!product) return '';
    const details = [line.sauce, line.addon, line.flavor, ...(saucesByProduct.get(line.productId) ?? []).map((sauce) => sauce.customName)].filter(Boolean).map(escapeHtml);
    return `<article class="review-line"><div><h3>${escapeHtml(product.name)} <small>×${line.quantity}</small></h3>${details.length ? `<p>${details.join(' · ')}</p>` : ''}</div><strong>${formatPrice((line.customPrice ?? product.price_rub) * line.quantity)}</strong></article>`;
  }).join('');
  const standaloneSauces = lines.filter((line) => line.kind === 'sauce' && !dishes.some((dish) => dish.productId === line.productId));

  return `<section class="payment-page payment-confirmation payment-review">
    <header class="payment-review__heading"><span class="eyebrow">ФИНАЛЬНАЯ ПРОВЕРКА</span><h1>Проверьте<br><em>заказ</em></h1><p>Если всё указано верно, отправим заказ на кухню сразу.</p></header>
    <div class="payment-review__layout">
      <section class="payment-review__items"><div class="payment-review__items-head"><h2>Состав заказа</h2><span>${lines.reduce((sum, line) => sum + line.quantity, 0)} поз.</span></div><div class="payment-review__list">${reviewLines}${standaloneSauces.map((line) => `<article class="review-line"><div><h3>${escapeHtml(line.customName ?? 'Соус')} <small>×${line.quantity}</small></h3></div><strong>${formatPrice((line.customPrice ?? 0) * line.quantity)}</strong></article>`).join('')}</div>${comment ? `<div class="payment-review__comment"><span>Комментарий к заказу</span><p>${escapeHtml(comment)}</p></div>` : ''}</section>
      <aside class="payment-review__total"><span class="eyebrow">ИТОГ ЗАКАЗА</span><div class="summary-row"><span>Блюда и дополнения</span><b>${formatPrice(subtotal)}</b></div>${discount ? `<div class="summary-row summary-row--discount"><span>Скидка</span><b>−${formatPrice(discount)}</b></div>` : ''}<div class="summary-total"><span>Итого</span><strong>${formatPrice(total)}</strong></div><button class="button button--primary button--wide" data-action="submit-order">ВСЁ ВЕРНО — ОТПРАВИТЬ НА КУХНЮ</button><button class="button button--secondary button--wide payment-review__edit" data-action="navigate" data-route="order">Изменить заказ</button></aside>
    </div>
  </section>`;
};
