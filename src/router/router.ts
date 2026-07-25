import type { RouteName } from '../types/menu';

const routes: RouteName[] = ['welcome', 'menu', 'order', 'orders', 'payment', 'status', 'admin'];
export const router = {
  current(): RouteName {
    const route = location.hash.replace('#/', '') as RouteName;
    return routes.includes(route) ? route : 'welcome';
  },
  go(route: RouteName) { location.hash = `/${route}`; },
  start(render: () => void) {
    if (!location.hash) this.go('welcome');
    addEventListener('hashchange', render);
  },
};
