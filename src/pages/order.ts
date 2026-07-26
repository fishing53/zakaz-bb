import type { CartLine, Product } from '../types/menu';
import { formatPrice, escapeHtml } from '../utils/helpers';
import { icon } from '../components/icons';

export function orderPage(lines: CartLine[], productFor: (line: CartLine) => Product | undefined, subtotal: number, discount: number, total: number, comment: string, promoCode: string) {
  const orderLines = lines.length ? lines.map((line) => {
    const product = productFor(line);
    if (!product) return '';
    return `<article class="order-line" data-key="${escapeHtml(line.key)}">
      <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">
      <div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${[line.sauce, line.addon, line.flavor].filter(Boolean).map(escapeHtml).join(' · ') || `${escapeHtml(product.portion)} ${escapeHtml(product.unit)}`}</p>
        <b data-line-total>${formatPrice((line.customPrice ?? product.price_rub) * line.quantity)}</b>
      </div>
      <div class="quantity">
        <button data-action="change-quantity" data-key="${escapeHtml(line.key)}" data-delta="-1">${icon('minus')}</button>
        <span data-line-quantity>${line.quantity}</span>
        <button data-action="change-quantity" data-key="${escapeHtml(line.key)}" data-delta="1">${icon('plus')}</button>
      </div>
      <button class="line-remove" data-action="remove-line" data-key="${escapeHtml(line.key)}">${icon('close')}</button>
    </article>`;
  }).join('') : '<div class="empty-state">Ваш заказ пока пуст. В меню найдется много интересного.</div>';

  return `<section class="order-page">
    <header class="page-heading"><h1>Ваш <em>заказ</em></h1><p>Проверьте позиции перед оформлением.</p></header>
    <div class="order-layout">
      <section class="order-lines">${orderLines}</section>
      <aside class="order-summary">
        <h2>Итог заказа</h2>
        <label>Комментарий<textarea data-action="set-comment" placeholder="Например: без лука, пожалуйста">${escapeHtml(comment)}</textarea></label>
        <div class="promo-code"><label>Промокод<input data-action="set-promo" value="${escapeHtml(promoCode)}" placeholder="Например: BOWL10" /></label><button class="button button--secondary button--compact" data-action="apply-promo">Применить</button></div>
        <small class="promo-hint">Тестовый код: <b>BOWL10</b> даёт скидку 10%</small>
        <div class="summary-row"><span>Блюда</span><b data-order-subtotal>${formatPrice(subtotal)}</b></div>
        <div class="summary-row summary-row--discount"><span>Скидка</span><b data-order-discount>${discount ? `−${formatPrice(discount)}` : '0 ₽'}</b></div>
        <div class="summary-total"><span>К оплате</span><strong data-order-total>${formatPrice(total)}</strong></div>
        <button class="button button--primary button--wide" ${lines.length ? 'data-action="navigate" data-route="payment"' : 'disabled'}>Оформить заказ ${icon('arrow')}</button>
      </aside>
    </div>
  </section>`;
}
