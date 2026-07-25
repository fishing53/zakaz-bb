import type { CartLine, Product } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

export const paymentPage = (
  lines: CartLine[],
  productFor: (line: CartLine) => Product | undefined,
  subtotal: number,
  discount: number,
  total: number,
  comment: string,
) => `<section class="payment-page payment-confirmation">
  <header class="payment-confirmation__heading">
    <h1>Подтвердите<br><em>заказ</em></h1>
    <p>Проверьте блюда и дополнения. Если всё указано правильно, подтвердите заказ — мы сразу передадим его на кухню.</p>
  </header>
  <div class="payment-confirmation__layout">
    <section class="payment-order-list">
      ${lines.map((line) => {
        const product = productFor(line);
        if (!product) return '';
        const unitPrice = line.customPrice ?? product.price_rub;
        const details = [line.sauce, line.addon, line.flavor].filter(Boolean).map(escapeHtml).join(' · ');
        return `<article class="payment-order-line">
          <img src="${escapeHtml(product.image)}" alt="">
          <div><h3>${escapeHtml(product.name)}</h3>${details ? `<p>${details}</p>` : ''}<span>${line.quantity} шт.</span></div>
          <strong>${formatPrice(unitPrice * line.quantity)}</strong>
        </article>`;
      }).join('')}
    </section>
    <aside class="payment-card">
      <h2>Итог заказа</h2>
      ${comment ? `<div class="payment-comment"><span>Комментарий</span><p>${escapeHtml(comment)}</p></div>` : ''}
      <div class="summary-row"><span>Блюда</span><b>${formatPrice(subtotal)}</b></div>
      ${discount ? `<div class="summary-row summary-row--discount"><span>Скидка</span><b>−${formatPrice(discount)}</b></div>` : ''}
      <div class="summary-total"><span>К оплате</span><strong>${formatPrice(total)}</strong></div>
      <button class="button button--primary button--wide" data-action="submit-order">ВСЕ ВЕРНО</button>
    </aside>
  </div>
</section>`;
