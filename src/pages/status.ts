import { icon } from '../components/icons';
import type { CartLine, Product, SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const stages = [
  ['Принят', 'Ресторан получил заказ'],
  ['Готовится', 'Блюда уже на кухне'],
  ['Готов', 'Можно подавать к столу'],
  ['Подан', 'Заказ у вашего стола'],
] as const;

export const statusPage = (order: SubmittedOrder | undefined, number: string | null, step: number, productFor: (line: CartLine) => Product | undefined) => {
  // iiko exposes five technical item states. Added and PrintedNotCooking are
  // one guest-facing stage, so the screen deliberately presents four steps.
  const active = step <= 1 ? 0 : Math.min(step - 1, stages.length - 1);
  const ready = step >= 3;
  const served = step >= 4;
  const items = order?.items ?? [];
  const table = order?.tableNumber;
  const heading = served ? 'Заказ <em>подан</em>' : ready ? 'Заказ <em>готов</em>' : active === 0 ? 'Заказ <em>принят</em>' : 'Заказ <em>готовится</em>';
  const message = served
    ? 'Все позиции уже у вашего стола. Если понадобится помощь, официант рядом.'
    : ready
      ? 'Кухня закончила готовить заказ. Официант скоро принесёт его к вашему столу.'
      : active === 0
        ? 'Ресторан принял заказ. Следующее обновление появится здесь автоматически.'
        : 'Повара уже готовят ваши блюда. Экран обновится сразу после смены статуса в iiko.';

  const positionCount = items.reduce((sum, item) => sum + item.quantity + (item.modifiers ?? []).reduce((modifierSum, modifier) => modifierSum + modifier.amount * item.quantity, 0), 0);
  const orderLines = items.map((item) => {
    const product = productFor(item);
    const productName = item.customName ?? product?.name ?? 'Блюдо';
    const weight = [product?.portion, product?.unit].filter(Boolean).join(' ');
    const mainPrice = (item.customPrice ?? product?.price_rub ?? 0) * item.quantity;
    const main = `<article class="live-status-line">
      <h3>${escapeHtml(productName)}${weight ? `<span>, ${escapeHtml(weight)}</span>` : ''}</h3>
      <small>×${item.quantity}</small><strong>${formatPrice(mainPrice)}</strong>
    </article>`;
    const modifiers = (item.modifiers ?? []).map((modifier) => {
      const quantity = modifier.amount * item.quantity;
      const price = modifier.price * quantity;
      return `<article class="live-status-line" data-kind="modifier">
        <h3>${escapeHtml(modifier.name)}</h3>
        <small>×${quantity}</small><strong>${formatPrice(price)}</strong>
      </article>`;
    }).join('');
    return main + modifiers;
  }).join('');

  return `<section class="live-status ${ready ? 'is-ready' : ''} ${served ? 'is-served' : ''}">
    <header class="live-status__header">
      <div class="live-status__identity"><span>ЗАКАЗ <b>${escapeHtml(number ?? 'B-0000')}</b></span>${table ? `<span>СТОЛ <b>№${escapeHtml(table)}</b></span>` : ''}</div>
      <div class="live-status__sync"><i></i><span>Статус обновляется автоматически</span></div>
    </header>
    <div class="live-status__layout">
      <main class="live-status__stage">
        <div class="live-status__stage-copy"><div class="live-status__stage-index">0${active + 1}<small>/ 04</small></div><h1>${heading}</h1><p>${message}</p></div>
        ${ready ? `<div class="live-status__ready-mark">${icon(served ? 'check' : 'bell')}</div>` : ''}
        <section class="live-status__timeline" aria-label="Этапы заказа"><div><span>ЭТАПЫ ЗАКАЗА</span></div><ol>${stages.map(([name, description], index) => `<li class="${index < active ? 'is-complete' : index === active ? 'is-active' : ''}"><i>${index < active ? icon('check') : ''}</i><div><b>${name}</b><span>${description}</span></div></li>`).join('')}</ol></section>
      </main>
      <aside class="live-status__receipt">
        <header><div><h2>Состав заказа</h2></div><b>${positionCount} поз.</b></header>
        <div class="live-status__items">${orderLines || '<div class="live-status__empty">Состав заказа загружается…</div>'}</div>
        <div class="live-status__total"><span>ИТОГО</span><strong>${formatPrice(order?.total ?? 0)}</strong></div>
        <footer><button class="button button--primary" data-action="open-service">Позвать официанта</button><button class="button button--secondary" data-action="new-order">Сделать ещё заказ</button></footer>
      </aside>
    </div>
  </section>`;
};
