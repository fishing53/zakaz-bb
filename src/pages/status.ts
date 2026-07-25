import { icon } from '../components/icons';
import type { CartLine, Product, SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const stages = ['Принят', 'На кухне', 'Готовится', 'Почти готов', 'Можно забирать'];

export const statusPage = (
  order: SubmittedOrder | undefined,
  number: string | null,
  step: number,
  productFor: (line: CartLine) => Product | undefined,
) => {
  const active = Math.min(step, stages.length - 1);
  const ready = active >= stages.length - 1;
  const items = order?.items ?? [];
  const shownItems = items.slice(0, 4);
  const remainingItems = Math.max(0, items.length - shownItems.length);
  const title = ready ? 'Можно <em>забирать</em>' : active === 0 ? 'Заказ <em>принят</em>' : `Уже <em>${stages[active].toLowerCase()}</em>`;
  const table = order?.tableNumber;

  return `<section class="status-page status-page--compact ${ready ? 'is-ready' : ''}">
    <header class="status-page__top">
      <button class="status-back" data-action="navigate" data-route="orders">← Все заказы</button>
      <span class="status-page__number">ЗАКАЗ ${escapeHtml(number ?? 'B-0000')}</span>
    </header>
    <div class="status-page__hero">
      <div>
        <span class="eyebrow">${ready ? 'ЗАКАЗ ГОТОВ' : 'СЛЕДИМ ЗА ГОТОВНОСТЬЮ'}</span>
        <h1>${title}</h1>
        <p>${ready ? 'Подойдите к стойке и покажите номер заказа.' : 'Мы сообщим здесь, когда заказ будет готов.'}</p>
        ${table ? `<span class="status-page__table">ВАШ СТОЛ <b>№${escapeHtml(table)}</b></span>` : ''}
      </div>
      ${ready ? `<div class="status-page__ready-mark">${icon('bell')}</div>` : '<img class="status-page__mascot" src="/images/home-mascot.png" alt="" aria-hidden="true">'}
    </div>
    <section class="status-page__progress" aria-label="Готовность заказа">
      <div><span>Готовность заказа</span><b>${Math.round(((active + 1) / stages.length) * 100)}%</b></div>
      <ol>${stages.map((name, index) => `<li class="${index < active ? 'is-done' : index === active ? 'is-current' : ''}"><i>${index < active ? icon('check') : ''}</i><span>${name}</span></li>`).join('')}</ol>
    </section>
    <section class="status-page__order">
      <div><span class="eyebrow">СОСТАВ ЗАКАЗА</span><b>${items.reduce((sum, item) => sum + item.quantity, 0)} поз.</b></div>
      <ul>${shownItems.map((item) => {
        const product = productFor(item);
        return `<li><span>${escapeHtml(item.customName ?? product?.name ?? 'Блюдо')} <small>×${item.quantity}</small></span><b>${formatPrice((item.customPrice ?? product?.price_rub ?? 0) * item.quantity)}</b></li>`;
      }).join('')}${remainingItems ? `<li class="status-page__more">и ещё ${remainingItems} поз.</li>` : ''}</ul>
      <strong>${formatPrice(order?.total ?? 0)}</strong>
    </section>
    <footer class="status-page__actions">${ready ? '<button class="button button--primary" data-action="complete-order">Завершить заказ</button>' : '<button class="button button--secondary" data-action="open-service">Позвать официанта</button>'}</footer>
  </section>`;
};
