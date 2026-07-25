import { appStore } from '../store/app-store';
import { orderStore } from '../store/order-store';
import { apiService } from './api-service';

export const orderService = {
  async submit() {
    const state = appStore.get();
    const order = await apiService.submitOrder({ items: orderStore.lines().map((line) => ({ ...line })), total: orderStore.total(), comment: state.comment, promoCode: state.promoCode });
    appStore.set({
      orders: [order, ...state.orders],
      selectedOrderId: order.id,
      orderNumber: order.id,
      statusStep: 0,
      upsellId: null,
    });
    return order.id;
  },
};
