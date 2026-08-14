import brand from '../config/brand.json';
import { orderStore } from '../store/order-store';
import { appStore } from '../store/app-store';
import { icon, type IconName } from './icons';
import type { RouteName } from '../types/menu';

const nav: Array<[RouteName, string, IconName]> = [['menu', 'Меню', 'plate'], ['order', 'Заказ', 'ticket'], ['orders', 'Мои заказы', 'serviceReceipt']];

export function appShell(content: string, route: RouteName) {
  const count = orderStore.count();
  const isWelcome = route === 'welcome';
  const isReview = route === 'table';
  const isStatus = route === 'status';
  const isAdmin = route === 'admin';
  const hideAppNavigation = isWelcome || isReview || isStatus || isAdmin;
  const orderCount = appStore.get().orders.length;
  return `<div class="app-shell ${isWelcome ? 'app-shell--welcome' : ''} ${isReview ? 'app-shell--review' : ''} ${isStatus ? 'app-shell--status' : ''} ${isAdmin ? 'app-shell--admin' : ''} ${!hideAppNavigation ? 'app-shell--navigation' : ''} ${route === 'menu' ? 'app-shell--menu' : ''}" style="--accent:${brand.theme.accent};--accent-hover:${brand.theme.accentHover}">
    ${hideAppNavigation ? '' : `<div class="bottom-nav-blur" aria-hidden="true"></div><aside class="rail">${nav.map(([name, label, iconName]) => `<button class="rail__item ${route === name ? 'is-active' : ''}" data-action="navigate" data-route="${name}" aria-label="${label}">${icon(iconName)}<span>${label}</span>${name === 'order' && count ? `<small data-order-count>${count}</small>` : name === 'orders' && orderCount ? `<small>${orderCount}</small>` : ''}</button>`).join('')}<button class="rail__item rail__item--service" data-action="open-service" aria-label="Официант">${icon('serviceBell')}<span>Официант</span></button></aside>`}
    <main class="page">${content}</main>
  </div>`;
}
