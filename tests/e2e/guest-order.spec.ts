import { test, expect, type Page } from '@playwright/test';

const product = { id: 'pizza-1', sku: 'PIZZA-1', name: 'Пицца Маргарита', category: 'Пицца', price_rub: 559, portion: '1000', unit: 'г', description: 'Томатный соус и сыр', composition: '', kbju: null, image: '/images/menu/0.webp', source_url: '', modifier_groups: [{ name: 'Острота', minQuantity: 0, maxQuantity: 1, items: [{ productId: 'mild', name: 'Не острое', price: 0, defaultQuantity: 1 }, { productId: 'hot', name: 'Острое', price: 99 }] }], is_available: true, badge: '', image_position: 'center', allergens: '', spicy: 'none', sort_order: 0 };

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
  const stage = await page.locator('.live-status__stage').boundingBox();
  const receipt = await page.locator('.live-status__receipt').boundingBox();
  const actions = await page.locator('.live-status__actions').boundingBox();
  expect(stage).not.toBeNull(); expect(receipt).not.toBeNull(); expect(actions).not.toBeNull();
  expect(await page.locator('.live-status__actions .icon').count()).toBe(0);
  if ((page.viewportSize()?.width ?? 0) < 700) {
    expect(actions!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height - 1);
    expect(receipt!.y).toBeGreaterThanOrEqual(actions!.y + actions!.height - 1);
  } else {
    expect(actions!.y).toBeGreaterThanOrEqual(Math.max(stage!.y + stage!.height, receipt!.y + receipt!.height) - 1);
  }
});

test('free iiko modifiers use a centered check without a technical label', async ({ page }) => {
  await page.getByRole('button', { name: 'СДЕЛАТЬ ЗАКАЗ' }).click();
  await page.locator('.product-card').click();

  const freeModifier = page.locator('[data-iiko-modifier="true"][data-product-id="mild"]');
  const paidModifier = page.locator('[data-iiko-modifier="true"][data-product-id="hot"]');
  await expect(freeModifier).toHaveAttribute('aria-pressed', 'true');
  await expect(freeModifier.getByText('Включено')).toHaveCount(0);
  await expect(freeModifier.locator('.option-chip__check')).toBeVisible();
  await expect(paidModifier).toContainText('+99 ₽');

  const buttonBox = await freeModifier.boundingBox();
  const checkBox = await freeModifier.locator('.option-chip__check').boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(checkBox).not.toBeNull();
  expect(Math.abs((checkBox!.y + checkBox!.height / 2) - (buttonBox!.y + buttonBox!.height / 2))).toBeLessThanOrEqual(2);

  await paidModifier.click();
  await expect(paidModifier).toHaveAttribute('aria-pressed', 'true');
  await expect(freeModifier).toHaveAttribute('aria-pressed', 'false');
});

test('administrator sees security checks and protected Telegram settings', async ({ page }) => {
  await page.unroute('**/api/v1/**');
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bootstrap')) return route.fulfill({ json: { products: [product], banners: [], terminal: { id: 'terminal-test', label: 'Тест', table_number: '5', is_active: true, demo_mode: false, idle_seconds: 45, table_source: 'admin', table_id: 'table-5' }, orders: [], settings: {} } });
    if (path.endsWith('/admin/login')) return route.fulfill({ json: { token: 'admin-token', scope: 'restaurant', role: 'administrator' } });
    if (path.endsWith('/admin/orders')) return route.fulfill({ json: [] });
    if (path.endsWith('/admin/application-downloads')) return route.fulfill({ json: [{ id: '11111111-1111-4111-8111-111111111111', app_kind: 'kiosk', app_name: 'BB Kiosk', label: 'Планшет зала №2', status: 'issued', version: '0.2.0-39', artifact_available: true, artifact_size: 1024, expires_at: new Date(Date.now() + 86_400_000).toISOString(), downloaded_at: null, installed_at: null, revoked_at: null, created_at: new Date().toISOString(), public_url: 'https://order.brooklynbowl.ru/api/v1/apps/install/token', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }] });
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
  await page.getByRole('button', { name: 'Приложения' }).click();
  await expect(page.getByRole('heading', { name: 'Приложения' })).toBeVisible();
  await expect(page.getByText('Планшет зала №2').first()).toBeVisible();
  await expect(page.getByText('ГОТОВ К СКАЧИВАНИЮ').first()).toBeVisible();
});
