import type { Product, ProductDisplaySettings, Promotion, TerminalSettings } from '../types/menu';
import { escapeHtml, imageStyle } from '../utils/helpers';

export function welcomePage(featured: Product[], promotions: Promotion[], allProducts: Product[], display: Record<string, ProductDisplaySettings>, terminal: TerminalSettings | null) {
  const activePromotions = promotions.filter((promotion) => promotion.active && !display[promotion.productId]?.unavailable);
  const availableFeatured = featured.filter((product) => !display[product.id]?.unavailable);
  const restaurantPromos = [0, 1].flatMap((index) => {
    const promotion = activePromotions[index] ?? activePromotions[0];
    const product = allProducts.find((item) => item.id === promotion?.productId && !display[item.id]?.unavailable) ?? availableFeatured[index] ?? availableFeatured[0];
    return product ? [{ promotion, product }] : [];
  });
  if (!restaurantPromos.length) return '<div class="page-state">Меню пока загружается...</div>';

  const slides = restaurantPromos.map(({ promotion, product }, index) => `<button class="welcome-promo welcome-promo--restaurant welcome-promo--${index + 1}" data-action="open-product" data-product-id="${escapeHtml(product.id)}" ${imageStyle(product.image, display[product.id]?.imagePosition)}>
    <span class="welcome-promo__shade"></span><span class="welcome-promo__content"><small>${escapeHtml(promotion?.label || 'НОВИНКА МЕНЮ')}</small><strong>${escapeHtml(promotion?.title || product.name)}</strong><em>${escapeHtml(promotion?.subtitle || product.description || 'Попробуйте сегодня')}</em><i>Открыть блюдо →</i></span>
  </button>`).join('');

  return `<section class="welcome welcome--showcase">
    <div class="welcome-showcase__promos" aria-label="Предложения ресторана">
      ${slides}
      <article class="welcome-promo welcome-promo--partner"><span class="welcome-promo__partner-mark">МЕСТО ДЛЯ<br>ПАРТНЁРА</span><span class="welcome-promo__partner-copy">Ваше рекламное<br>изображение здесь</span></article>
      <div class="welcome-promo__dots" aria-label="Переключить баннер">${[0, 1, 2].map((index) => `<button data-action="promo-slide" data-promo-index="${index}" aria-label="Баннер ${index + 1}"></button>`).join('')}</div>
    </div>
    <div class="welcome-showcase__action">
      <div class="welcome-showcase__halo"></div><img class="welcome-showcase__mascot" src="/images/home-mascot.png" alt="Маскот Brooklyn Bowl" data-action="admin-tap" role="button" tabindex="0">
      <div class="welcome-showcase__copy"><span class="eyebrow">${terminal?.tableNumber ? `ВАШ СТОЛ №${escapeHtml(terminal.tableNumber)}` : 'ВЫБЕРИТЕ СТОЛ ПЕРЕД ЗАКАЗОМ'}</span><h1>ВКУСНЫЙ<br><b>ВЕЧЕР</b> НАЧИНАЕТСЯ</h1><p>Выберите блюда, а мы принесём заказ прямо к вашему столу.</p><div class="welcome-showcase__actions"><button class="button button--primary welcome-order-button" data-action="start-order">Заказать</button><button class="button button--secondary welcome-waiter-button" data-action="open-service">Позвать официанта</button></div></div>
    </div>
  </section>`;
}
