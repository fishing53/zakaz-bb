import { test, expect, type Page } from '@playwright/test';

const product = { id: 'pizza-1', sku: 'PIZZA-1', name: 'Пицца Маргарита', category: 'Пицца', price_rub: 559, portion: '1000', unit: 'г', description: 'Томатный соус и сыр', composition: '', kbju: null, image: '/images/menu/0.webp', source_url: '', modifier_groups: [], is_available: true, badge: '', image_position: 'center', allergens: '', spicy: 'none', sort_order: 0 };

async function mockApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/bootstrap')) return route.fulfill({ json: { products: [product], banners: [], terminal: { id: 'terminal-test', label: 'Тест', table_number: '5', is_active: true, demo_mode: false, idle_seconds: 45, table_source: 'admin', table_id: 'table-5' }, orders: [], settings: {} } });
    if (url.pathname.endsWith('/orders') && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { order_number: 'B-TEST01', items: [{ key: 'line', productId: 'pizza-1', quantity: 1 }], total: 559, status_step: 0, table_number: '5', created_at: new Date().toISOString() } });
    return route.fulfill({ json: { ok: true, tables: [] } });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
});

test('guest completes the critical order path', async ({ page }) => {
  await page.getByRole('button', { name: 'СДЕЛАТЬ ЗАКАЗ' }).click();
  await expect(page.getByText('Пицца Маргарита')).toBeVisible();
  await page.locator('.product-card').click();
  await expect(page.locator('.product-modal')).toBeVisible();
  await page.getByRole('button', { name: /Добавить в заказ/i }).click();
  await page.locator('[data-route="order"]').click();
  await expect(page.getByRole('heading', { name: /Ваш заказ/i })).toBeVisible();
  await page.getByRole('button', { name: /Оформить заказ/i }).click();
  await expect(page.getByRole('heading', { name: /Заказ принят/i })).toBeVisible();
  await expect(page.getByText('Пицца Маргарита')).toBeVisible();
});

test('administrator sees security checks and protected Telegram settings', async ({ page }) => {
  await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap')) return route.fulfill({ json: { products: [product], banners: [], terminal: { id: 'terminal-test', label: 'Тест', table_number: '5', is_active: true, demo_mode: false, idle_seconds: 45, table_source: 'admin', table_id: 'table-5' }, orders: [], settings: {} } });
    if (path.endsWith('/admin/login')) return route.fulfill({ json: { token: 'admin-token', scope: 'restaurant', role: 'administrator' } });
    if (path.endsWith('/admin/orders')) return route.fulfill({ json: [] });
    if (path.endsWith('/admin/security')) return route.fulfill({ json: { generated_at: new Date().toISOString(), telegram: { configured: false, enabled: false, chat_id_masked: '', last_test_at: null, last_success_at: null, last_error: null }, automated: { status: 'passed', commit: 'abcdef1', passed: 22, failed: 0, duration_ms: 500, created_at: new Date().toISOString() }, safe_run: { status: 'passed', passed: 8, failed: 0, created_at: new Date().toISOString() }, smoke: { status: 'unknown', created_at: null, detail: 'Ещё не запускался' }, load: { status: 'unknown', created_at: null, detail: 'Ещё не запускался' }, checks: [{ id: 'database', name: 'База данных', status: 'passed', detail: 'Ответ 2 мс' }], backup: { status: 'passed', last_at: new Date().toISOString(), age_hours: 2, file: 'zakaz-test.dump' } } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/#/admin');
  await page.locator('[data-admin-password]').fill('test-password');
  await page.getByRole('button', { name: 'Войти' }).click();
  const [securityResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/v1/admin/security')),
    page.getByRole('button', { name: 'Безопасность' }).click(),
  ]);
  expect(await securityResponse.json()).toHaveProperty('automated.status', 'passed');
  await expect(page.getByRole('heading', { name: 'Безопасность' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Уведомления в Telegram' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeVisible();
  await page.locator('[data-telegram-setting="token"]').fill('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd');
  await page.locator('[data-telegram-setting="chatId"]').fill('-1001234567890');
  await page.locator('[data-telegram-setting="password"]').fill('test-password');
  await page.locator('[data-telegram-setting="enabled"]').check();
  const settingsRequest = page.waitForRequest((request) => request.url().includes('/api/v1/admin/security/telegram') && request.method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  expect((await settingsRequest).postDataJSON()).toMatchObject({ chat_id: '-1001234567890', password: 'test-password', enabled: true });
});
