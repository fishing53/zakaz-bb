import { icon } from './icons';

const actions = [
  ['waiter', 'Позвать<br>официанта', 'bell'],
  ['cutlery', 'Нужны<br>приборы', 'utensils'],
  ['bill', 'Попросить<br>счёт', 'plate'],
  ['help', 'Нужна<br>помощь', 'info'],
] as const;

export const serviceSheet = (isOpen: boolean) => isOpen ? `<div class="overlay service-overlay" data-action="close-service">
  <img class="service-overlay__character" src="/images/waiter-character.png" alt="" aria-hidden="true">
  <section class="service-sheet">
    <button class="modal__close" data-action="close-service" aria-label="Закрыть">${icon('close')}</button>
    <span class="eyebrow">ОФИЦИАНТ</span>
    <h2>Чем можем<br><em>помочь?</em></h2>
    <p>Выберите, что принести или подсказать — мы уже рядом.</p>
    <div class="service-actions">${actions.map(([value, label, glyph]) => `<button data-action="request-service" data-service="${value}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div>
  </section>
</div>` : '';
