import { icon } from '../components/icons';
import type { CartLine, Product, SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const stages = [
  ['Принят', 'Ресторан получил заказ'],
  ['Готовится', 'Блюда уже на кухне'],
  ['Готов', 'Можно подавать к столу'],
  ['Подан', 'Заказ у вашего стола'],
] as const;

const fallbackImage = '/images/sauce-fallback.webp';

export const statusPage = (order: SubmittedOrder | undefined, number: string | null, step: number, productFor: (line: CartLine) => Product | undefined) => {
  // iiko exposes five technical item states. Added and PrintedNotCooking are
  // one guest-facing stage, so the screen deliberately presents four steps.
  const active = step <= 1 ? 0 : Math.min(step - 1, stages.length - 1);
  const ready = step >= 3;
  const served = step >= 4;
  const items = order?.items ?? [];
  const table = order?.tableNumber;
  const heading = served ? 'Заказ <em>подан</em>' : ready ? 'Заказ <em>готов</em>' : active === 0 ? 'Заказ <em>принят</em>' : 'Заказ <em>готовится</em>';
  const statusLabel = served ? 'ПРИЯТНОГО АППЕТИТА' : ready ? 'МОЖНО ПОДАВАТЬ' : active === 0 ? 'ЗАКАЗ В РЕСТОРАНЕ' : 'КУХНЯ РАБОТАЕТ';
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
    const mainPrice = (item.customPrice ?? product?.price_rub ?? 0) * item.quantity;
    const main = `<article class="live-status-item">
      <img src="${escapeHtml(product?.image || fallbackImage)}" alt="${escapeHtml(productName)}">
      <div class="live-status-item__copy"><span>БЛЮДО</span><h3>${escapeHtml(productName)}</h3></div>
      <small>×${item.quantity}</small><strong>${formatPrice(mainPrice)}</strong>
    </article>`;
    const modifiers = (item.modifiers ?? []).map((modifier) => {
      const quantity = modifier.amount * item.quantity;
      const price = modifier.price * quantity;
      return `<article class="live-status-item" data-kind="modifier">
        <img src="${escapeHtml(modifier.image || fallbackImage)}" alt="${escapeHtml(modifier.name)}">
        <div class="live-status-item__copy"><span>ДОПОЛНЕНИЕ К «${escapeHtml(productName)}»</span><h3>${escapeHtml(modifier.name)}</h3></div>
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
        <div class="live-status__stage-copy"><span class="eyebrow">${statusLabel}</span><div class="live-status__stage-index">0${active + 1}<small>/ 04</small></div><h1>${heading}</h1><p>${message}</p></div>
        ${ready ? `<div class="live-status__ready-mark">${icon(served ? 'check' : 'bell')}</div>` : '<img class="live-status__mascot" src="/images/home-mascot.png" alt="" aria-hidden="true">'}
        <section class="live-status__timeline" aria-label="Этапы заказа"><div><span>ГОТОВНОСТЬ</span><b>${Math.round((active + 1) / stages.length * 100)}%</b></div><ol>${stages.map(([name, description], index) => `<li class="${index < active ? 'is-complete' : index === active ? 'is-active' : ''}"><i>${index < active ? icon('check') : ''}</i><div><b>${name}</b><span>${description}</span></div></li>`).join('')}</ol></section>
      </main>
      <aside class="live-status__receipt">
        <header><div><span class="eyebrow">ВАШ ЗАКАЗ</span><h2>Состав заказа</h2></div><b>${positionCount} поз.</b></header>
        <div class="live-status__items">${orderLines || '<div class="live-status__empty">Состав заказа загружается…</div>'}</div>
        <div class="live-status__total"><span>ИТОГО</span><strong>${formatPrice(order?.total ?? 0)}</strong></div>
        <footer><button class="button button--primary" data-action="open-service">Позвать официанта</button><button class="button button--secondary" data-action="new-order">Сделать ещё заказ</button></footer>
      </aside>
    </div>
  </section>`;
};
