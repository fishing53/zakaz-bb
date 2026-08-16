import type { RestaurantTable } from '../types/menu';
import { escapeHtml } from '../utils/helpers';

export const tablePage = (tables: RestaurantTable[], loading = false) => {
  const grouped = new Map<string, RestaurantTable[]>();
  tables.forEach((table) => grouped.set(table.section || 'Зал', [...(grouped.get(table.section || 'Зал') ?? []), table]));
  return `<section class="table-picker"><header><span class="eyebrow">НАЧАЛО ЗАКАЗА</span><h1>Выберите<br><em>стол</em></h1><p>Пожалуйста, укажите стол, за которым вы сидите. Заказ сразу попадёт на нужный стол в ресторане.</p></header><div class="table-picker__list">${loading ? '<div class="page-state">Готовим список столов…</div>' : [...grouped.entries()].map(([section, items]) => `<section class="table-picker__section"><h2>${escapeHtml(section)}</h2><div>${items.map((table) => `<button class="table-picker__table" data-action="select-table" data-table-id="${escapeHtml(table.id)}"><span>СТОЛ</span><b>№${escapeHtml(table.number || table.name)}</b></button>`).join('')}</div></section>`).join('') || '<div class="page-state">Не удалось показать столы. Попробуйте ещё раз или позовите официанта.</div>'}</div><button class="button button--secondary table-picker__back" data-action="navigate" data-route="welcome">Назад</button></section>`;
};
