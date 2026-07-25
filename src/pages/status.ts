import { icon } from '../components/icons';
import type { CartLine, Product, SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const stages = ['Принят', 'На кухне', 'Готовится', 'Почти готов', 'Можно забирать'];

export const statusPage = (order: SubmittedOrder | undefined, number: string | null, step: number, productFor: (line: CartLine) => Product | undefined) => {
  const active = Math.min(step, stages.length - 1);
  const ready = active === stages.length - 1;
  const items = order?.items ?? [];
  const visibleItems = items.slice(0, 4);
  const extra = items.length - visibleItems.length;
  const table = order?.tableNumber;
  const heading = ready ? 'Можно <em>забирать</em>' : active === 0 ? 'Заказ <em>принят</em>' : `${stages[active]}<em>!</em>`;

  return `<section class="status-page status-page--tablet ${ready ? 'is-ready' : ''}">
    <header class="status-tablet__top"><button class="status-back" data-action="navigate" data-route="orders">← Все заказы</button><div><span>ЗАКАЗ</span><b>${escapeHtml(number ?? 'B-0000')}</b>${table ? `<small>СТОЛ №${escapeHtml(table)}</small>` : ''}</div></header>
    <div class="status-tablet__layout">
      <section class="status-tablet__hero"><div><span class="eyebrow">${ready ? 'ЗАКАЗ ГОТОВ' : 'ТЕКУЩИЙ СТАТУС'}</span><h1>${heading}</h1><p>${ready ? 'Подойдите к стойке и покажите номер заказа.' : 'Мы сообщим на этом экране, когда заказ будет готов.'}</p></div>${ready ? `<div class="status-tablet__ready">${icon('bell')}</div>` : '<img src="/images/home-mascot.png" alt="" aria-hidden="true">'}</section>
      <aside class="status-tablet__order"><div class="status-tablet__order-head"><span class="eyebrow">СОСТАВ ЗАКАЗА</span><b>${items.reduce((sum, item) => sum + item.quantity, 0)} поз.</b></div><ul>${visibleItems.map((item) => { const product = productFor(item); return `<li><span>${escapeHtml(item.customName ?? product?.name ?? 'Блюдо')} <small>×${item.quantity}</small></span><b>${formatPrice((item.customPrice ?? product?.price_rub ?? 0) * item.quantity)}</b></li>`; }).join('')}${extra > 0 ? `<li class="status-tablet__more">Ещё ${extra} поз.</li>` : ''}</ul><strong>${formatPrice(order?.total ?? 0)}</strong></aside>
    </div>
    <section class="status-tablet__steps" aria-label="Этапы готовности"><div><span>ГОТОВНОСТЬ ЗАКАЗА</span><b>${Math.round(((active + 1) / stages.length) * 100)}%</b></div><ol>${stages.map((name, index) => `<li class="${index < active ? 'is-done' : index === active ? 'is-current' : ''}"><i>${index < active ? icon('check') : ''}</i><span>${name}</span></li>`).join('')}</ol></section>
    <footer class="status-tablet__actions">${ready ? '<button class="button button--primary" data-action="complete-order">Завершить заказ</button>' : '<button class="button button--secondary" data-action="open-service">Позвать официанта</button>'}</footer>
  </section>`;
};
