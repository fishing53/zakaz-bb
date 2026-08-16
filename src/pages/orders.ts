import { icon } from '../components/icons';
import { guestOrderStep, orderStages, orderStatusMessage } from '../config/order-stages';
import type { SubmittedOrder } from '../types/menu';
import { escapeHtml } from '../utils/helpers';

export const ordersPage = (orders: SubmittedOrder[]) => `<section class="orders-page">
  <header class="page-heading">
    <h1>Мои <em>заказы</em></h1>
    <p>Здесь можно следить за готовностью ваших заказов.</p>
  </header>
  <div class="orders-list">
    ${orders.length ? orders.map((order) => {
      const step = guestOrderStep(order.statusStep);
      return `<button class="submitted-order" data-action="open-order-status" data-order-id="${escapeHtml(order.id)}" aria-label="Открыть заказ ${escapeHtml(order.id)}">
        <span class="submitted-order__summary">
          <strong class="submitted-order__number">${escapeHtml(order.id)}</strong>
          <span>${escapeHtml(orderStatusMessage(order.statusStep))}</span>
        </span>
        <span class="submitted-order__timeline" aria-hidden="true">${orderStages.map((stage, index) => `<span class="${index < step ? 'is-complete' : index === step ? 'is-active' : ''}"><i>${icon(stage.icon)}</i><b>${stage.name}</b><small>${stage.description}</small></span>`).join('')}</span>
        <span class="submitted-order__open">${icon('arrowRight')}</span>
      </button>`;
    }).join('') : '<div class="empty-state">Здесь появятся ваши заказы после оформления.</div>'}
  </div>
</section>`;
