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
  const message = ready
    ? 'Подойдите к стойке и покажите номер заказа.'
    : active === 0
      ? 'Передали заказ на кухню. Оставьте экран открытым — здесь появится каждый следующий этап.'
      : 'Повара уже работают над заказом. Покажем обновление, как только статус изменится.';

  return `<section class="status-page status-page--tablet ${ready ? 'is-ready' : ''}">
    <header class="status-tablet__top"><div class="status-tablet__number"><span>ЗАКАЗ</span><b>${escapeHtml(number ?? 'B-0000')}</b></div>${table ? `<div class="status-tablet__number"><span>СТОЛ</span><b>№${escapeHtml(table)}</b></div>` : ''}</header>
    <div class="status-tablet__layout">
      <div class="status-tablet__status-column">
        <section class="status-tablet__hero"><div><span class="eyebrow">${ready ? 'ЗАКАЗ ГОТОВ' : active === 0 ? 'ЗАКАЗ ОТПРАВЛЕН НА КУХНЮ' : 'ТЕКУЩИЙ СТАТУС'}</span><h1>${heading}</h1><p>${message}</p>${ready ? '' : '<span class="status-tablet__keep-open">Не закрывайте этот экран</span>'}</div>${ready ? `<div class="status-tablet__ready">${icon('bell')}</div>` : '<img src="/images/home-mascot.png" alt="" aria-hidden="true">'}</section>
        <section class="status-tablet__steps" aria-label="Этапы готовности"><div><span>ГОТОВНОСТЬ ЗАКАЗА</span><b>ЭТАП ${active + 1} ИЗ ${stages.length}</b></div><ol>${stages.map((name, index) => `<li class="${index < active ? 'is-done' : index === active ? 'is-current' : ''}"><i>${index < active ? icon('check') : ''}</i><span>${name}</span></li>`).join('')}</ol></section>
      </div>
      <aside class="status-tablet__order-column"><section class="status-tablet__order"><div class="status-tablet__order-head"><span class="eyebrow">СОСТАВ ЗАКАЗА</span><b>${items.reduce((sum, item) => sum + item.quantity, 0)} поз.</b></div><ul>${visibleItems.map((item) => { const product = productFor(item); return `<li><span>${escapeHtml(item.customName ?? product?.name ?? 'Блюдо')} <small>×${item.quantity}</small></span><b>${formatPrice((item.customPrice ?? product?.price_rub ?? 0) * item.quantity)}</b></li>`; }).join('')}${extra > 0 ? `<li class="status-tablet__more">Ещё ${extra} поз.</li>` : ''}</ul><strong>${formatPrice(order?.total ?? 0)}</strong></section><footer class="status-tablet__actions">${ready ? '<button class="button button--primary" data-action="complete-order">Завершить заказ</button>' : '<button class="button button--secondary" data-action="open-service">Позвать официанта</button>'}</footer></aside>
    </div>
  </section>`;
};
