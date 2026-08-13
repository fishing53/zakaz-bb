import type { Banner, Product, ProductDisplaySettings, TerminalSettings } from '../types/menu';
import { escapeHtml } from '../utils/helpers';

type AdminTab = 'terminal' | 'menu' | 'banners' | 'staff' | 'quality' | 'audit';
const tabs: Array<[AdminTab, string]> = [['terminal', 'Терминал'], ['menu', 'Витрина'], ['banners', 'Баннеры'], ['staff', 'Официанты'], ['quality', 'Проверка iiko'], ['audit', 'Журнал']];
const options = (products: Product[], selected = '') => products.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.category)} · ${escapeHtml(item.name)}</option>`).join('');
const multipleOptions = (products: Product[], selected: string[] = []) => products.map((item) => `<option value="${escapeHtml(item.id)}" ${selected.includes(item.id) ? 'selected' : ''}>${escapeHtml(item.category)} · ${escapeHtml(item.name)}</option>`).join('');
const missing = (products: Product[]) => ({ description: products.filter((item) => !item.description).length, kbju: products.filter((item) => !item.kbju).length, pairs: products.filter((item) => !item.pairs_with?.length).length });
const localDateTime = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

type Waiter = { id: string; display_name: string; is_active: boolean; created_at: string };
export function adminPage(products: Product[], banners: Banner[], display: Record<string, ProductDisplaySettings>, terminal: TerminalSettings | null, tab: AdminTab, selectedId: string | null, audit: Array<{ action: string; entity: string; entity_id: string; created_at: string }> = [], scope: 'terminal' | 'restaurant' | null = 'restaurant', waiters: Waiter[] = []) {
  const selected = products.find((item) => item.id === selectedId) ?? products[0];
  const stats = missing(products);
  const terminalView = `<section class="admin-panel admin-terminal">
    <div class="admin-panel__intro"><span class="eyebrow">ПРИВЯЗКА ПЛАНШЕТА</span><h2>Этот терминал</h2><p>Стол сохраняется для этого планшета и автоматически добавляется к каждому заказу.</p></div>
    <div class="terminal-form">
      <label>Название планшета<input data-admin-terminal="label" value="${escapeHtml(terminal?.label ?? '')}" placeholder="Например: Основной зал"></label>
      <label>Номер стола<input data-admin-terminal="tableNumber" value="${escapeHtml(terminal?.tableNumber ?? '')}" placeholder="Например: 14" inputmode="numeric"></label>
      <label>Таймаут бездействия<select data-admin-terminal="idleSeconds"><option value="45" ${(terminal?.idleSeconds ?? 45) === 45 ? 'selected' : ''}>45 секунд</option><option value="60" ${terminal?.idleSeconds === 60 ? 'selected' : ''}>1 минута</option><option value="90" ${terminal?.idleSeconds === 90 ? 'selected' : ''}>1,5 минуты</option><option value="120" ${terminal?.idleSeconds === 120 ? 'selected' : ''}>2 минуты</option></select></label>
      <label class="admin-switch"><input type="checkbox" data-admin-terminal="isActive" ${terminal?.isActive !== false ? 'checked' : ''}><span></span> Терминал принимает заказы</label>
      <button class="button button--primary" data-action="save-terminal">Сохранить терминал</button>
    </div>
    <div class="admin-app-update"><div><span class="eyebrow">ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ</span><h3>Актуальная версия интерфейса</h3><p>Скачает и сразу применит последнюю OTA-версию. Для логотипа при запуске и системных функций всё ещё нужна новая APK.</p></div><button class="button button--secondary" data-action="install-ota-update">Проверить обновления</button></div>
  </section>`;
  const menuView = selected ? `<section class="admin-panel admin-menu-editor">
    <div class="admin-panel__intro"><span class="eyebrow">ЛОКАЛЬНОЕ ОФОРМЛЕНИЕ</span><h2>Витрина блюда</h2><p>Название, цена, состав и модификаторы поступают из iiko. Здесь хранятся только фото, кадрирование, бейдж и рекомендации.</p></div>
    <label class="admin-product-picker">Блюдо<select data-admin-product-select>${options(products, selected.id)}</select></label>
    <div class="admin-product-form" data-admin-product-form>
      <label>Бейдж<select data-admin-product="badge"><option value="">Без бейджа</option><option ${display[selected.id]?.badge === 'НОВИНКА' ? 'selected' : ''}>НОВИНКА</option><option ${display[selected.id]?.badge === 'ХИТ' ? 'selected' : ''}>ХИТ</option></select></label><label>Кадрирование<select data-admin-product="imagePosition"><option value="center">По центру</option><option value="top">Сверху</option><option value="bottom">Снизу</option></select></label>
      <label class="admin-product-form__wide">Ссылка на фото<input data-admin-product="image" value="${escapeHtml(selected.image)}"></label>
      <label class="admin-product-form__wide">Идеально с этим блюдом<select data-admin-product="pairs" multiple size="5">${multipleOptions(products.filter((item) => item.id !== selected.id), selected.pairs_with ?? [])}</select></label>
      <button class="button button--primary" data-action="save-product" data-product-id="${escapeHtml(selected.id)}">Сохранить блюдо</button>
    </div>
  </section>` : '';
  const bannerView = `<section class="admin-panel admin-banners"><div class="admin-panel__intro"><span class="eyebrow">ГЛАВНЫЙ ЭКРАН</span><h2>Баннеры</h2><p>На планшете отображается только изображение. Для рекламного баннера обязательно задайте период и лимит показов.</p></div>
    <div class="banner-create">
      <div class="banner-upload-preview" data-banner-preview="create"><span>Загрузите изображение</span></div>
      <div class="banner-form-grid">
        <label>Название в админке<input data-banner-create="name" placeholder="Например: Летнее меню"></label>
        <label>Тип<select data-banner-create="kind"><option value="restaurant">Баннер заведения</option><option value="advertising">Рекламный баннер</option></select></label>
        <label class="banner-form-grid__wide">Открывать блюдо<select data-banner-create="productId"><option value="">Без перехода к блюду</option>${options(products)}</select></label>
        <label class="banner-form-grid__wide">Файл изображения<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-banner-image" data-banner-target="create"><input type="hidden" data-banner-create="image"></label>
        <label>Показывать с<input type="datetime-local" data-banner-create="startsAt"></label><label>Показывать до<input type="datetime-local" data-banner-create="endsAt"></label>
        <label>Лимит показов<input type="number" min="1" step="1" data-banner-create="impressionLimit" placeholder="Только для рекламы"></label><label>Порядок<input type="number" step="1" data-banner-create="sortOrder" value="0"></label>
        <button class="button button--primary banner-form-grid__wide" data-action="create-banner">Добавить баннер</button>
      </div>
    </div>
    <div class="banner-admin-list">${banners.length ? banners.map((item) => `<article class="banner-admin-card ${item.active ? '' : 'is-muted'}" data-banner-card="${escapeHtml(item.id)}">
      <div class="banner-admin-card__image"><img src="${escapeHtml(item.image)}" alt=""><span>${item.kind === 'advertising' ? 'РЕКЛАМА' : 'ЗАВЕДЕНИЕ'}</span></div>
      <div class="banner-form-grid">
        <label>Название<input data-banner-field="name" value="${escapeHtml(item.name)}"></label>
        <label>Тип<select data-banner-field="kind"><option value="restaurant" ${item.kind === 'restaurant' ? 'selected' : ''}>Баннер заведения</option><option value="advertising" ${item.kind === 'advertising' ? 'selected' : ''}>Рекламный баннер</option></select></label>
        <label class="banner-form-grid__wide">Открывать блюдо<select data-banner-field="productId"><option value="">Без перехода к блюду</option>${options(products, item.productId ?? '')}</select></label>
        <label class="banner-form-grid__wide">Заменить изображение<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-banner-image" data-banner-target="${escapeHtml(item.id)}"><input type="hidden" data-banner-field="image" value="${escapeHtml(item.image)}"></label>
        <label>Показывать с<input type="datetime-local" data-banner-field="startsAt" value="${localDateTime(item.startsAt)}"></label><label>Показывать до<input type="datetime-local" data-banner-field="endsAt" value="${localDateTime(item.endsAt)}"></label>
        <label>Лимит показов<input type="number" min="1" step="1" data-banner-field="impressionLimit" value="${item.impressionLimit ?? ''}" placeholder="Только для рекламы"></label><label>Порядок<input type="number" step="1" data-banner-field="sortOrder" value="${item.sortOrder}"></label>
        <div class="banner-admin-card__stats"><b>${item.impressions}</b><span>${item.impressionLimit ? `из ${item.impressionLimit} показов` : 'показов'}</span></div>
        <div class="banner-admin-card__actions"><button class="button button--primary button--compact" data-action="save-banner" data-banner-id="${escapeHtml(item.id)}">Сохранить</button><button class="button button--secondary button--compact" data-action="toggle-banner" data-banner-id="${escapeHtml(item.id)}">${item.active ? 'Скрыть' : 'Показать'}</button><button class="button button--secondary button--compact" data-action="reset-banner-impressions" data-banner-id="${escapeHtml(item.id)}">Сбросить показы</button><button class="button button--secondary button--compact" data-action="delete-banner" data-banner-id="${escapeHtml(item.id)}">Удалить</button></div>
      </div>
    </article>`).join('') : '<div class="empty-state">Баннеров пока нет. Загрузите первое изображение выше.</div>'}</div>
  </section>`;
  const qualityView = `<section class="admin-panel"><div class="admin-panel__intro"><span class="eyebrow">КОНТРОЛЬ ПЕРЕД ПУБЛИКАЦИЕЙ</span><h2>Проверка меню</h2><p>Список полей, которые стоит заполнить до обновления витрины.</p></div><div class="quality-grid"><article><strong>${stats.description}</strong><span>без описания</span></article><article><strong>${stats.kbju}</strong><span>без КБЖУ</span></article><article><strong>${stats.pairs}</strong><span>без рекомендаций</span></article></div></section>`;
  const staffView = `<section class="admin-panel"><div class="admin-panel__intro"><span class="eyebrow">РАБОЧЕЕ МЕСТО ОФИЦИАНТА</span><h2>Официанты и PIN</h2><p>Создайте отдельный доступ для приложения официанта. PIN кассы iiko здесь не используется и не хранится.</p></div><div class="promotion-create"><label>Имя официанта<input data-admin-waiter="name" placeholder="Например: Анна"></label><label>PIN-код<input data-admin-waiter="pin" inputmode="numeric" maxlength="8" placeholder="4–8 цифр"></label><button class="button button--primary" data-action="create-waiter">Добавить официанта</button></div><div class="audit-list">${waiters.length ? waiters.map((item) => `<article><b>${escapeHtml(item.display_name)}</b><span>${item.is_active ? 'Доступ активен' : 'Доступ отключён'}</span><div><input data-waiter-pin="${escapeHtml(item.id)}" inputmode="numeric" maxlength="8" placeholder="Новый PIN"><button class="button button--secondary button--compact" data-action="save-waiter" data-waiter-id="${escapeHtml(item.id)}">Сохранить PIN</button><button class="button button--secondary button--compact" data-action="toggle-waiter" data-waiter-id="${escapeHtml(item.id)}" data-waiter-active="${item.is_active ? 'false' : 'true'}">${item.is_active ? 'Отключить' : 'Включить'}</button></div></article>`).join('') : '<div class="empty-state">Официантов пока нет. Создайте первый профиль выше.</div>'}</div></section>`;
  const auditView = `<section class="admin-panel"><div class="admin-panel__intro"><span class="eyebrow">ПРОЗРАЧНОСТЬ</span><h2>Последние изменения</h2><p>Журнал действий сотрудников на этом сервере.</p></div><div class="audit-list">${audit.length ? audit.map((item) => `<article><b>${escapeHtml(item.action)}</b><span>${escapeHtml(item.entity)} · ${escapeHtml(item.entity_id)}</span><time>${new Date(item.created_at).toLocaleString('ru-RU')}</time></article>`).join('') : '<div class="empty-state">Журнал загрузится после первого изменения.</div>'}</div></section>`;
  const views = { terminal: terminalView, menu: menuView, banners: bannerView, staff: staffView, quality: qualityView, audit: auditView };
  const visibleTabs = scope === 'terminal' ? tabs.filter(([id]) => id === 'terminal') : tabs.filter(([id]) => id !== 'terminal');
  const visibleTab = scope === 'terminal' ? 'terminal' : (tab === 'terminal' ? 'menu' : tab);
  return `<section class="admin-page"><header class="admin-header"><div><span class="eyebrow">${scope === 'terminal' ? 'СЕРВИСНЫЙ РЕЖИМ ПЛАНШЕТА' : 'УПРАВЛЕНИЕ РЕСТОРАНОМ'}</span><h1>${scope === 'terminal' ? 'Этот <em>терминал</em>' : 'Админ-<em>панель</em>'}</h1><p>${scope === 'terminal' ? 'Доступны только настройки этого планшета.' : 'Все изменения сохраняются на сервере и применяются на терминалах.'}</p></div><button class="button button--secondary button--compact admin-logout" data-action="logout-admin">Выйти</button></header><nav class="admin-tabs">${visibleTabs.map(([id, title]) => `<button data-action="select-admin-tab" data-admin-tab="${id}" class="${visibleTab === id ? 'is-active' : ''}">${title}</button>`).join('')}</nav>${views[visibleTab]}</section>`;
}
