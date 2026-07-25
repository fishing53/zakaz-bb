import { icon } from '../components/icons';

const stages = [
  ['Заказ принят', 'Мы получили ваш заказ', 'check'],
  ['Передан на кухню', 'Кухня увидела ваш заказ', 'plate'],
  ['Готовится', 'Повара уже начали работу', 'flame'],
  ['Почти готов', 'Осталось совсем немного', 'plate'],
  ['Можно забирать', 'Покажите номер у стойки', 'bell'],
] as const;

export const statusPage = (number: string | null, step: number) => {
  const active = Math.min(step, stages.length - 1);
  const [title] = stages[active];
  const progress = Math.round(((active + 1) / stages.length) * 100);
  return `<section class="status-page">
    <button class="status-back" data-action="navigate" data-route="orders">← Все заказы</button>
    <div class="status-orbit"><span></span><span></span><div>${icon(active >= 4 ? 'bell' : 'flame')}</div></div>
    <span class="eyebrow">ЗАКАЗ ${number ?? 'B-0000'}</span>
    <h1>${active >= 4 ? 'Можно <em>забирать</em>' : `Уже <em>${title.toLowerCase()}</em>`}</h1>
    <p>Тестовая симуляция обновляет статус каждые несколько секунд.</p>
    <div class="status-progress"><div><span>Готовность заказа</span><b>${progress}%</b></div><i><em style="width:${progress}%"></em></i></div>
    <div class="status-timeline">${stages.map(([name, description, glyph], index) => `<article class="${index < active ? 'is-done' : index === active ? 'is-current' : ''}">${icon((index < active ? 'check' : glyph) as 'check')}<div><b>${name}</b><span>${description}</span></div></article>`).join('')}</div>
    ${active >= 4 ? '<button class="button button--primary" data-action="complete-order">Завершить заказ</button>' : '<button class="button button--secondary" data-action="open-service">Позвать официанта</button>'}
  </section>`;
};
