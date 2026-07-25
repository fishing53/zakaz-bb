import type { Promotion } from '../types/menu';
import { menuService } from './menu-service';

export const marketingService = {
  defaults(): Promotion[] {
    return menuService.featured(3).map((product, index) => ({
      id: `promo-${product.id}`,
      productId: product.id,
      title: product.name,
      subtitle: product.description || `Попробуйте ${product.name} сегодня.`,
      label: ['ВЫБОР ГОСТЕЙ', 'СЕЗОННЫЙ ВКУС', 'РЕКОМЕНДУЕМ'][index] || 'СПЕЦПРЕДЛОЖЕНИЕ',
      active: true,
    }));
  },
};
