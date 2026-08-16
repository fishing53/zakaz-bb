import type { Banner, TerminalSettings } from '../types/menu';
import { escapeHtml } from '../utils/helpers';

export function welcomePage(banners: Banner[], terminal: TerminalSettings | null) {
  const slides = banners.length
    ? banners.map((item, index) => `<figure class="welcome-banner ${item.productId ? 'welcome-banner--linked ' : ''}${index === 0 ? 'is-active' : ''}" data-banner-id="${escapeHtml(item.id)}" ${item.productId ? `data-action="open-product" data-product-id="${escapeHtml(item.productId)}" role="button" tabindex="0"` : ''}><img src="${escapeHtml(item.image)}" alt="" draggable="false"></figure>`).join('')
    : '<figure class="welcome-banner welcome-banner--empty is-active" aria-label="Добро пожаловать в Brooklyn Bowl"></figure>';
  const tableNumber = terminal?.tableNumber?.trim();

  return `<section class="welcome-home">
    <div class="welcome-banners" aria-label="Баннеры ресторана">
      ${slides}
      <button class="welcome-table-badge${tableNumber ? '' : ' welcome-table-badge--unassigned'}" data-action="admin-tap" aria-label="Текущий стол">
        <span>СТОЛ</span><strong>${tableNumber ? `№${escapeHtml(tableNumber)}` : 'ВЫБЕРЕТЕ ПРИ ЗАКАЗЕ'}</strong>
      </button>
      ${banners.length > 1 ? `<nav class="welcome-banner-dots" aria-label="Переключить баннер">${banners.map((_, index) => `<button data-action="banner-slide" data-banner-index="${index}" class="${index === 0 ? 'is-active' : ''}" aria-label="Баннер ${index + 1}"></button>`).join('')}</nav>` : ''}
    </div>
    <div class="welcome-home__actions">
      <button class="welcome-home__button welcome-home__button--order" data-action="start-order">СДЕЛАТЬ ЗАКАЗ</button>
      <button class="welcome-home__button welcome-home__button--waiter" data-action="open-service">ВЫЗВАТЬ ОФИЦИАНТА</button>
    </div>
  </section>`;
}
