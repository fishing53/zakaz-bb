import type { RouteName } from '../types/menu';

const routes: RouteName[] = ['welcome', 'table', 'menu', 'order', 'orders', 'status', 'admin'];
export const router = {
  current(): RouteName {
    const rawRoute = location.hash.replace('#/', '');
    // The former confirmation screen no longer exists. Preserve old bookmarks
    // and cached navigation history by taking the guest back to their cart.
    if (rawRoute === 'payment') return 'order';
    const route = rawRoute as RouteName;
    return routes.includes(route) ? route : 'welcome';
  },
  go(route: RouteName) { location.hash = `/${route}`; },
  start(render: () => void) {
    if (!location.hash) this.go('welcome');
    addEventListener('hashchange', render);
  },
};
