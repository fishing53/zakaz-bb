import brand from '../config/brand.json';
import { orderStore } from '../store/order-store';
import { appStore } from '../store/app-store';
import type { RouteName } from '../types/menu';

const nav: Array<[RouteName, string]> = [['menu', 'Меню'], ['order', 'Заказ'], ['orders', 'Мои заказы']];

export function appShell(content: string, route: RouteName) {
  const count = orderStore.count();
  const isWelcome = route === 'welcome';
  const isReview = route === 'table';
  const isStatus = route === 'status';
  const isAdmin = route === 'admin';
  const hideAppNavigation = isWelcome || isReview || isStatus || isAdmin;
  const orderCount = appStore.get().orders.length;
  return `<div class="app-shell ${isWelcome ? 'app-shell--welcome' : ''} ${isReview ? 'app-shell--review' : ''} ${isStatus ? 'app-shell--status' : ''} ${isAdmin ? 'app-shell--admin' : ''} ${route === 'menu' ? 'app-shell--menu' : ''}" style="--accent:${brand.theme.accent};--accent-hover:${brand.theme.accentHover}">
    ${hideAppNavigation ? '' : `<div class="bottom-nav-blur" aria-hidden="true"></div><aside class="rail">${nav.map(([name, label]) => `<button class="rail__item ${route === name ? 'is-active' : ''}" data-action="navigate" data-route="${name}"><span>${label}</span>${name === 'order' && count ? `<small data-order-count>${count}</small>` : name === 'orders' && orderCount ? `<small>${orderCount}</small>` : ''}</button>`).join('')}<button class="rail__item" data-action="open-service"><span>Официант</span></button></aside>`}
    <main class="page">${content}</main>
  </div>`;
}
