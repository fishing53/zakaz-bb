import type { IconName } from '../components/icons';

export const orderStages: ReadonlyArray<{ name: string; description: string; icon: IconName }> = [
  { name: 'Принят', description: 'Ресторан получил ваш заказ', icon: 'check' },
  { name: 'Готовится', description: 'Блюда уже на кухне', icon: 'cooking' },
  { name: 'Готов', description: 'Скоро принесём к столу', icon: 'waiter' },
  { name: 'Подан', description: 'Приятного аппетита!', icon: 'utensils' },
];

export const guestOrderStep = (technicalStep: number) => technicalStep <= 1
  ? 0
  : Math.min(technicalStep - 1, orderStages.length - 1);

export const orderStatusMessage = (technicalStep: number) => {
  const step = guestOrderStep(technicalStep);
  if (step === 3) return 'Заказ подан. Приятного аппетита!';
  if (step === 2) return 'Ваш заказ готов. Скоро официант принесёт его к столу.';
  if (step === 1) return 'Повара уже готовят ваши блюда. Сообщим, когда всё будет готово.';
  return 'Мы получили ваш заказ и уже передали его на кухню.';
};
