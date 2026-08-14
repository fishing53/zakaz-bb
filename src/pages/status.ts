import { icon } from '../components/icons';
import type { CartLine, Product, SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const stages = ['Принят', 'На кухне', 'Готовится', 'Почти готов', 'Можно забирать'];

export const statusPage = (order: SubmittedOrder | undefined, number: string | null, step: number, productFor: (line: CartLine) => Product | undefined) => {
  const active = Math.min(step, stages.length - 1);
  const ready = active === stages.length - 1;
  const items = order?.items ?? [];
  const table = order?.tableNumber;
  const heading = ready ? 'Можно <em>забирать</em>' : active === 0 ? 'Заказ <em>принят</em>' : `${stages[active]}<em>!</em>`;
  const message = ready
    ? 'Подойдите к стойке и покажите номер заказа.'
    : active === 0
      ? 'Передали заказ на кухню. Оставьте экран открытым — здесь появится каждый следующий этап.'
      : 'Повара уже работают над заказом. Покажем обновление, как только статус изменится.';

  const positionCount = items.reduce((sum, item) => sum + item.quantity + (item.modifiers ?? []).reduce((modifierSum, modifier) => modifierSum + modifier.amount * item.quantity, 0), 0);
  const orderLines = items.map((item) => {
    const product = productFor(item);
    const main = `<li><span>${escapeHtml(item.customName ?? product?.name ?? 'Блюдо')} <small>×${item.quantity}</small></span><b>${formatPrice((item.customPrice ?? product?.price_rub ?? 0) * item.quantity)}</b></li>`;
    const modifiers = (item.modifiers ?? []).map((modifier) => `<li class="status-tablet__modifier"><span>${escapeHtml(modifier.name)} <small>×${modifier.amount * item.quantity}</small></span><b>${formatPrice(modifier.price * modifier.amount * item.quantity)}</b></li>`).join('');
    return main + modifiers;
  }).join('');

  return `<section class="status-page status-page--tablet ${ready ? 'is-ready' : ''}">
    <div class="status-tablet__layout">
      <div class="status-tablet__status-column">
        <header class="status-tablet__top"><div class="status-tablet__number"><span>ЗАКАЗ</span><b>${escapeHtml(number ?? 'B-0000')}</b></div>${table ? `<div class="status-tablet__number"><span>СТОЛ</span><b>№${escapeHtml(table)}</b></div>` : ''}</header>
        <section class="status-tablet__hero"><div><span class="eyebrow">${ready ? 'ЗАКАЗ ГОТОВ' : active === 0 ? 'ЗАКАЗ ОТПРАВЛЕН НА КУХНЮ' : 'ТЕКУЩИЙ СТАТУС'}</span><h1>${heading}</h1><p>${message}</p></div>${ready ? `<div class="status-tablet__ready">${icon('bell')}</div>` : '<img src="/images/home-mascot.png" alt="" aria-hidden="true">'}</section>
        <section class="status-tablet__steps" aria-label="Этапы готовности"><div><span>ГОТОВНОСТЬ ЗАКАЗА</span><b>ЭТАП ${active + 1} ИЗ ${stages.length}</b></div><ol>${stages.map((name, index) => `<li class="${index < active ? 'is-done' : index === active ? 'is-current' : ''}"><i>${index < active ? icon('check') : ''}</i><span>${name}</span></li>`).join('')}</ol></section>
      </div>
      <aside class="status-tablet__order-column"><section class="status-tablet__order"><div class="status-tablet__order-head"><span class="eyebrow">СОСТАВ ЗАКАЗА</span><b>${positionCount} поз.</b></div><ul>${orderLines || '<li class="status-tablet__empty">Состав заказа загружается…</li>'}</ul><strong>${formatPrice(order?.total ?? 0)}</strong></section><footer class="status-tablet__actions"><button class="button button--primary" data-action="open-service">Позвать официанта</button><button class="button button--secondary" data-action="new-order">Сделать ещё заказ</button></footer></aside>
    </div>
  </section>`;
};
