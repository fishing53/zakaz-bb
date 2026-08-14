import { icon } from '../components/icons';
import type { SubmittedOrder } from '../types/menu';
import { escapeHtml, formatPrice } from '../utils/helpers';

const statusNames = ['Принят', 'Готовится', 'Готов', 'Подан'];

export const ordersPage = (orders: SubmittedOrder[]) => `<section class="orders-page">
  <header class="page-heading">
    <h1>Мои <em>заказы</em></h1>
    <p>Здесь собраны все заказы этой сессии. Корзина для нового заказа остаётся отдельной.</p>
  </header>
  <div class="orders-list">
    ${orders.length ? orders.map((order) => {
      const step = order.statusStep <= 1 ? 0 : Math.min(order.statusStep - 1, statusNames.length - 1);
      const count = order.items.reduce((sum, item) => sum + item.quantity, 0);
      return `<button class="submitted-order" data-action="open-order-status" data-order-id="${escapeHtml(order.id)}">
        <span class="submitted-order__state ${order.statusStep >= 3 ? 'is-ready' : ''}"><i></i>${statusNames[step]}</span>
        <span class="submitted-order__number">${escapeHtml(order.id)}</span>
        <span class="submitted-order__meta">${count} поз. · ${new Date(order.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <strong>${formatPrice(order.total)}</strong>
        ${icon('arrow')}
      </button>`;
    }).join('') : '<div class="empty-state">Оформленных заказов пока нет.</div>'}
  </div>
</section>`;
