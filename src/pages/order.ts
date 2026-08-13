import type { CartLine, Product, PromoRule } from '../types/menu';
import { formatPrice, escapeHtml } from '../utils/helpers';
import { icon } from '../components/icons';

export function orderPage(lines: CartLine[], productFor: (line: CartLine) => Product | undefined, subtotal: number, discount: number, total: number, comment: string, promoCode: string, promoRule: PromoRule | null) {
  const orderLines = lines.length ? lines.map((line) => {
    const product = productFor(line);
    if (!product) return '';
    const modifiers = (line.modifiers ?? []).map((modifier) => `<article class="order-line order-line--modifier" data-parent-key="${escapeHtml(line.key)}" data-modifier-id="${escapeHtml(modifier.productId)}">
      <img src="${escapeHtml(modifier.image || '/images/sauce-fallback.webp')}" alt="${escapeHtml(modifier.name)}">
      <div>
        <h3>${escapeHtml(modifier.name)}</h3>
        <p>К блюду «${escapeHtml(product.name)}»</p>
        <b data-modifier-total>${formatPrice(modifier.price * modifier.amount * line.quantity)}</b>
      </div>
      <div class="quantity">
        <button data-action="change-modifier-quantity" data-key="${escapeHtml(line.key)}" data-modifier-id="${escapeHtml(modifier.productId)}" data-delta="-1">${icon('minus')}</button>
        <span data-modifier-quantity>${modifier.amount * line.quantity}</span>
        <button data-action="change-modifier-quantity" data-key="${escapeHtml(line.key)}" data-modifier-id="${escapeHtml(modifier.productId)}" data-delta="1">${icon('plus')}</button>
      </div>
      <button class="line-remove" data-action="remove-modifier" data-key="${escapeHtml(line.key)}" data-modifier-id="${escapeHtml(modifier.productId)}" aria-label="Удалить дополнение">${icon('close')}</button>
    </article>`).join('');
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
    </article>${modifiers}`;
  }).join('') : '<div class="empty-state">Ваш заказ пока пуст. В меню найдется много интересного.</div>';

  return `<section class="order-page">
    <header class="page-heading"><h1>Ваш <em>заказ</em></h1><p>Проверьте позиции перед оформлением.</p></header>
    <div class="order-layout">
      <section class="order-lines">${orderLines}</section>
      <aside class="order-summary">
        <label class="order-summary__comment"><span>Комментарий для кухни</span><div class="order-summary__comment-field"><textarea data-action="set-comment" placeholder="Например: без лука, пожалуйста">${escapeHtml(comment)}</textarea>${icon('edit')}</div></label>
        <section class="order-summary__promo ${promoRule ? 'is-applied' : ''}">
          <div class="order-summary__promo-title"><span>ПРОМОКОД</span>${promoRule ? `<b>${escapeHtml(promoRule.name)}</b>` : '<small>Если он у вас есть</small>'}</div>
          <div class="promo-code"><div class="promo-code__field">${icon('ticket')}<input aria-label="Промокод" data-action="set-promo" value="${escapeHtml(promoCode)}" placeholder="Введите код" ${promoRule ? 'readonly' : ''}/></div>${promoRule ? '<button class="promo-code__remove" data-action="remove-promo" aria-label="Удалить промокод">×</button>' : '<button class="button button--secondary button--compact" data-action="apply-promo">Применить</button>'}</div>
        </section>
        <div class="order-summary__receipt">
          <div class="summary-row"><span>Заказ</span><b data-order-subtotal>${formatPrice(subtotal)}</b></div>
          ${discount ? `<div class="summary-row summary-row--discount"><span>Скидка по промокоду</span><b data-order-discount>−${formatPrice(discount)}</b></div>` : ''}
          <div class="summary-total"><span>К оплате</span><strong data-order-total>${formatPrice(total)}</strong></div>
        </div>
        <button class="button button--primary button--wide order-summary__checkout" ${lines.length ? 'data-action="submit-order"' : 'disabled'}><span>Оформить заказ</span><strong>${formatPrice(total)}</strong></button>
      </aside>
    </div>
  </section>`;
}
