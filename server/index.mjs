import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 3107);
const tokenSecret = process.env.TOKEN_SECRET;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const iikoApiBase = process.env.IIKO_API_BASE ?? 'https://api-ru.iiko.services';
const iikoOrganizationId = process.env.IIKO_ORGANIZATION_ID ?? '528faa64-3219-4cc9-b17f-96fa28fd8627';
const iikoWebhookToken = process.env.IIKO_WEBHOOK_TOKEN;
const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const iikoTerminalGroupId = process.env.IIKO_TERMINAL_GROUP_ID ?? '';
const iikoExternalMenuId = process.env.IIKO_EXTERNAL_MENU_ID ?? '';
const iikoOrderTypeId = process.env.IIKO_ORDER_TYPE_ID ?? '';
const otaManifestPath = process.env.OTA_MANIFEST_PATH ?? '/var/www/zakaz-zvyak/ota/manifest.json';
const allowedOrigins = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost', 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai']);

if (!process.env.DATABASE_URL || !tokenSecret || !adminPasswordHash) throw new Error('DATABASE_URL, TOKEN_SECRET and ADMIN_PASSWORD_HASH are required');

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sign = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};
const verify = (value) => {
  const [encoded, signature] = String(value ?? '').split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(encoded).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
};
const requireAdmin = (request) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = verify(token);
  if (!payload?.admin) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return payload;
};
const requireWaiter = (request) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = verify(token);
  if (!payload?.waiterId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return payload;
};
const audit = (actor, action, entity, entityId, before, after) => pool.query(
  'insert into audit_log(actor, action, entity, entity_id, before_data, after_data) values ($1,$2,$3,$4,$5,$6)',
  [actor, action, entity, entityId, before ?? null, after ?? null],
);
const publishEvent = (eventType, aggregateType, aggregateId, payload, restaurantId = iikoOrganizationId) => pool.query(
  'insert into app_events(restaurant_id,event_type,aggregate_type,aggregate_id,payload) values($1,$2,$3,$4,$5)',
  [restaurantId, eventType, aggregateType, aggregateId, JSON.stringify(payload)],
);
let firebaseMessagingPromise;
const firebaseMessaging = async () => {
  if (!firebaseServiceAccountPath) return null;
  if (!firebaseMessagingPromise) firebaseMessagingPromise = (async () => {
    const [{ cert, getApps, initializeApp }, { getMessaging }] = await Promise.all([import('firebase-admin/app'), import('firebase-admin/messaging')]);
    const serviceAccount = JSON.parse(await fs.readFile(firebaseServiceAccountPath, 'utf8'));
    const app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
    return getMessaging(app);
  })();
  return firebaseMessagingPromise;
};
const notifyWaiters = async (title, body, data = {}) => {
  try {
    const messaging = await firebaseMessaging(); if (!messaging) return;
    const tokens = await pool.query(`select d.token from waiter_devices d join waiter_profiles w on w.id=d.waiter_id where w.restaurant_id=$1 and w.is_active=true and d.is_active=true`, [iikoOrganizationId]);
    if (!tokens.rowCount) return;
    const result = await messaging.sendEachForMulticast({ tokens: tokens.rows.map((row) => row.token), notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([key,value]) => [key,String(value)])), android: { priority: 'high', notification: { channelId: 'bb_waiter_urgent', sound: 'default', priority: 'PRIORITY_MAX' } } });
    result.responses.forEach((response, index) => { if (!response.success && /registration-token-not-registered|invalid-registration-token/.test(response.error?.code ?? '')) void pool.query('update waiter_devices set is_active=false where token=$1', [tokens.rows[index].token]); });
  } catch (error) { console.warn('Firebase waiter notification:', error.message); }
};
const createGuestSession = async ({ terminalId = null, source = 'tablet', table = null, metadata = {} }) => {
  const id = crypto.randomUUID();
  await pool.query('insert into guest_sessions(id,restaurant_id,terminal_id,source,table_id,table_number,metadata) values($1,$2,$3,$4,$5,$6,$7)', [id, iikoOrganizationId, terminalId, source, table?.table_id ?? null, table?.table_number ?? '', JSON.stringify(metadata)]);
  await publishEvent('guest_session_started', 'guest_session', id, { source, tableNumber: table?.table_number ?? '' });
  return id;
};

const iikoItemStatuses = new Set(['Added', 'PrintedNotCooking', 'CookingStarted', 'CookingCompleted', 'Served']);
const iikoStatusStep = (order) => {
  const statuses = arrayValue(order?.items).map((item) => item?.status).filter((status) => iikoItemStatuses.has(status));
  if (order?.status === 'Closed' || (statuses.length && statuses.every((status) => status === 'Served'))) return 4;
  if (statuses.length && statuses.every((status) => status === 'CookingCompleted' || status === 'Served')) return 3;
  if (statuses.some((status) => status === 'CookingStarted' || status === 'CookingCompleted' || status === 'Served')) return 2;
  if (statuses.some((status) => status === 'PrintedNotCooking')) return 1;
  return 0;
};
const iikoOrderSnapshot = (eventInfo) => {
  const order = eventInfo?.order ?? {};
  return {
    orderId: String(eventInfo?.id ?? ''),
    posId: eventInfo?.posId ? String(eventInfo.posId) : null,
    externalNumber: eventInfo?.externalNumber ? String(eventInfo.externalNumber) : null,
    orderStatus: order?.status ? String(order.status) : null,
    creationStatus: eventInfo?.creationStatus ? String(eventInfo.creationStatus) : null,
    errorInfo: eventInfo?.errorInfo ?? null,
    itemStatuses: arrayValue(order?.items).map((item) => ({
      positionId: item?.positionId ?? null,
      productId: item?.product?.id ?? null,
      name: item?.product?.name ?? '',
      amount: Number(item?.amount ?? 0),
      status: iikoItemStatuses.has(item?.status) ? item.status : 'Added',
    })),
    statusStep: iikoStatusStep(order),
  };
};
const saveIikoOrder = async (eventInfo, { organizationId = iikoOrganizationId, eventType = 'Poll', webhook = false } = {}) => {
  const snapshot = iikoOrderSnapshot(eventInfo);
  if (!snapshot.orderId) throw Object.assign(new Error('iiko event has no order id'), { status: 400 });
  const result = await pool.query(`
    insert into iiko_orders(order_id,organization_id,pos_id,external_number,order_status,item_statuses,status_step,creation_status,error_info,last_event_type,raw_payload,last_webhook_at,last_polled_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    on conflict (order_id) do update set
      organization_id=excluded.organization_id,pos_id=excluded.pos_id,external_number=excluded.external_number,order_status=excluded.order_status,
      item_statuses=excluded.item_statuses,status_step=excluded.status_step,creation_status=excluded.creation_status,error_info=excluded.error_info,
      last_event_type=excluded.last_event_type,raw_payload=excluded.raw_payload,
      last_webhook_at=coalesce(excluded.last_webhook_at,iiko_orders.last_webhook_at),last_polled_at=coalesce(excluded.last_polled_at,iiko_orders.last_polled_at),updated_at=now()
    returning *`, [
    snapshot.orderId, organizationId, snapshot.posId, snapshot.externalNumber, snapshot.orderStatus, JSON.stringify(snapshot.itemStatuses), snapshot.statusStep,
    snapshot.creationStatus, snapshot.errorInfo ? JSON.stringify(snapshot.errorInfo) : null, eventType, JSON.stringify(eventInfo), webhook ? new Date() : null, webhook ? null : new Date(),
  ]);
  await pool.query('update customer_orders set status_step=$1,iiko_pos_id=coalesce($2,iiko_pos_id),updated_at=now() where iiko_order_id=$3', [snapshot.statusStep, snapshot.posId, snapshot.orderId]);
  return result.rows[0];
};
let iikoAccessToken = '';
let iikoAccessTokenExpiresAt = 0;
let iikoRetryAfter = 0;
const iikoRequest = async (path, body) => {
  if (Date.now() < iikoRetryAfter) throw Object.assign(new Error('iiko временно ограничил запросы, используем сохранённые данные'), { status: 503 });
  const token = await getIikoAccessToken();
  const result = await fetch(`${iikoApiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const seconds = Math.max(30, Number(result.headers.get('retry-after') ?? 60));
    iikoRetryAfter = Date.now() + seconds * 1_000;
    throw Object.assign(new Error('iiko временно ограничил запросы'), { status: 503 });
  }
  if (!result.ok) throw Object.assign(new Error(payload.errorDescription ?? `iiko request failed: ${path}`), { status: 502 });
  return payload;
};
const getIikoAccessToken = async () => {
  if (iikoAccessToken && iikoAccessTokenExpiresAt > Date.now()) return iikoAccessToken;
  const { IIKO_APP_ID: appId, IIKO_API_LOGIN: apiLogin, IIKO_CLIENT_SECRET: clientSecret } = process.env;
  if (!appId || !apiLogin || !clientSecret) throw Object.assign(new Error('iiko credentials are not configured'), { status: 503 });
  const result = await fetch(`${iikoApiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId, apiLogin, clientSecret }) });
  const body = await result.json().catch(() => ({}));
  if (!result.ok || !body.token) throw Object.assign(new Error(body.errorDescription ?? 'iiko authorization failed'), { status: 502 });
  iikoAccessToken = body.token;
  iikoAccessTokenExpiresAt = Date.now() + 14 * 60 * 1000;
  return iikoAccessToken;
};
const defaultItemSize = (item) => arrayValue(item?.itemSizes).find((size) => size?.isDefault) ?? arrayValue(item?.itemSizes)[0] ?? {};
const iikoPrice = (size) => Number(arrayValue(size?.prices).find((price) => String(price?.organizationId) === iikoOrganizationId)?.price ?? arrayValue(size?.prices)[0]?.price ?? 0);
const publicModifierGroups = (groups) => arrayValue(groups).map((group) => ({
  name: String(group?.name ?? 'Дополнения'), minQuantity: Number(group?.restrictions?.minQuantity ?? 0), maxQuantity: Number(group?.restrictions?.maxQuantity ?? 99), freeQuantity: Number(group?.restrictions?.freeQuantity ?? 0),
  items: arrayValue(group?.items).filter((item) => item?.itemId && !item?.isHidden).map((item) => {
    const restrictions = arrayValue(item?.restrictions)[0] ?? {};
    return { productId: String(item.itemId), name: String(item.name ?? ''), price: iikoPrice(item), defaultQuantity: Number(restrictions.byDefault ?? 0), minQuantity: Number(restrictions.minQuantity ?? 0), maxQuantity: Number(restrictions.maxQuantity ?? 1) };
  }),
})).filter((group) => group.items.length);
const syncIikoMenu = async () => {
  if (!iikoExternalMenuId) return 0;
  const menu = await iikoRequest('/api/2/menu/by_id', { organizationIds: [iikoOrganizationId], externalMenuId: iikoExternalMenuId, version: 2, language: 'ru', asyncMode: false });
  const rows = [];
  let sortOrder = 0;
  for (const category of arrayValue(menu?.itemCategories)) for (const item of arrayValue(category?.items)) {
    const size = defaultItemSize(item);
    if (!item?.itemId) continue;
    rows.push([String(item.itemId), String(category?.id ?? ''), String(category?.name ?? 'Без категории'), String(item?.name ?? ''), item?.description ?? null, iikoPrice(size), Number(size?.portionWeightGrams ?? 0), String(size?.measureUnitType ?? ''), JSON.stringify(size?.nutritionPerHundredGrams ?? size?.nutritions?.[0] ?? null), size?.buttonImageUrl ?? null, JSON.stringify(size?.itemModifierGroups ?? []), Boolean(item?.isHidden || size?.isHidden), sortOrder++, Number(menu?.revision ?? 0), JSON.stringify({ item, size })]);
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const row of rows) await client.query(`insert into iiko_menu_items(product_id,category_id,category_name,name,description,price_rub,portion_weight_grams,measure_unit,nutrition,image_url,modifier_groups,is_hidden,sort_order,revision,raw_payload)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      on conflict(product_id) do update set category_id=excluded.category_id,category_name=excluded.category_name,name=excluded.name,description=excluded.description,price_rub=excluded.price_rub,portion_weight_grams=excluded.portion_weight_grams,measure_unit=excluded.measure_unit,nutrition=excluded.nutrition,image_url=excluded.image_url,modifier_groups=excluded.modifier_groups,is_hidden=excluded.is_hidden,sort_order=excluded.sort_order,revision=excluded.revision,raw_payload=excluded.raw_payload,updated_at=now()`, row);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  return rows.length;
};
const syncIikoTables = async () => {
  if (!iikoTerminalGroupId) return 0;
  const payload = await iikoRequest('/api/1/reserve/available_restaurant_sections', { organizationIds: [iikoOrganizationId], terminalGroupIds: [iikoTerminalGroupId], returnSchema: true });
  const sections = arrayValue(payload?.restaurantSections);
  const rows = [];
  for (const section of sections) for (const table of arrayValue(section?.tables)) {
    if (!table?.id) continue;
    rows.push([String(table.id), iikoOrganizationId, iikoTerminalGroupId, String(section?.id ?? ''), String(section?.name ?? ''), String(table?.number ?? table?.name ?? ''), String(table?.name ?? table?.number ?? '')]);
  }
  for (const row of rows) await pool.query(`insert into iiko_tables(table_id,organization_id,terminal_group_id,section_id,section_name,table_number,table_name)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(table_id) do update set organization_id=excluded.organization_id,terminal_group_id=excluded.terminal_group_id,section_id=excluded.section_id,section_name=excluded.section_name,table_number=excluded.table_number,table_name=excluded.table_name,updated_at=now()`, row);
  return rows.length;
};
const fetchIikoOrder = async (orderId) => {
  const token = await getIikoAccessToken();
  const result = await fetch(`${iikoApiBase}/api/1/order/by_id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationIds: [iikoOrganizationId], orderIds: [orderId] }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(body.errorDescription ?? 'Unable to get iiko order'), { status: 502 });
  if (!body.orders?.length) throw Object.assign(new Error('iiko order not found'), { status: 404 });
  return saveIikoOrder(body.orders[0], { organizationId: iikoOrganizationId });
};
const saveIikoStopLists = async (terminalGroupStopLists, organizationId = iikoOrganizationId) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const group of terminalGroupStopLists) {
      const terminalGroupId = String(group?.terminalGroupId ?? '');
      if (!terminalGroupId) continue;
      await client.query('delete from iiko_stop_list_items where organization_id=$1 and terminal_group_id=$2', [organizationId, terminalGroupId]);
      for (const item of arrayValue(group?.items)) {
        if (!item?.productId) continue;
        await client.query(`insert into iiko_stop_list_items(organization_id,terminal_group_id,product_id,size_id,balance,sku,date_added)
          values ($1,$2,$3,$4,$5,$6,$7)`, [organizationId, terminalGroupId, String(item.productId), String(item.sizeId ?? ''), Number(item.balance ?? 0), item.sku ?? null, item.dateAdd ?? null]);
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
};
const fetchIikoStopLists = async (terminalGroupIds = []) => {
  const token = await getIikoAccessToken();
  const result = await fetch(`${iikoApiBase}/api/1/stop_lists`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationIds: [iikoOrganizationId], ...(terminalGroupIds.length ? { terminalGroupsIds: terminalGroupIds } : {}), returnSize: true }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(body.errorDescription ?? 'Unable to get iiko stop list'), { status: 502 });
  const groups = arrayValue(body.terminalGroupStopLists).flatMap((wrapper) => arrayValue(wrapper?.items));
  await saveIikoStopLists(groups, iikoOrganizationId);
  return groups;
};
const publicIikoStatus = (row) => ({
  orderId: row.order_id,
  posId: row.pos_id,
  externalNumber: row.external_number,
  orderStatus: row.order_status,
  itemStatuses: row.item_statuses,
  statusStep: row.status_step,
  creationStatus: row.creation_status,
  error: row.error_info,
  updatedAt: row.updated_at,
});

const publicState = async (terminalId) => {
  const [localProducts, iikoProducts, promotions, terminal, selection, settings] = await Promise.all([
    pool.query('select * from products order by category, sort_order, name'),
    pool.query(`select m.*, o.image as override_image, o.pairs_with as override_pairs_with, o.badge as override_badge, o.image_position as override_image_position,
      exists(select 1 from iiko_stop_list_items s where s.organization_id=$1 and s.terminal_group_id=$2 and s.product_id=m.product_id and s.balance <= 0) as stopped
      from iiko_menu_items m left join iiko_product_overrides o on o.product_id=m.product_id where not m.is_hidden order by m.category_name,m.sort_order,m.name`, [iikoOrganizationId, iikoTerminalGroupId]),
    pool.query('select * from promotions order by sort_order, created_at desc'),
    pool.query('insert into terminals(id) values ($1) on conflict (id) do update set last_seen_at = now() returning *', [terminalId]),
    pool.query('select * from terminal_table_selections where terminal_id=$1', [terminalId]),
    pool.query('select key, value from app_settings'),
  ]);
  const fixedTable = String(terminal.rows[0].table_number ?? '').trim();
  const chosen = selection.rows[0];
  const effectiveTable = fixedTable || chosen?.table_number || '';
  const products = iikoProducts.rowCount ? iikoProducts.rows.map((item) => ({
    id: item.product_id, name: item.name, category: item.category_name, price_rub: Number(item.price_rub), portion: item.portion_weight_grams ? String(Math.round(Number(item.portion_weight_grams))) : '', unit: item.measure_unit === 'GRAM' ? 'г' : item.measure_unit,
    description: item.description, kbju: item.nutrition ? { calories: String(item.nutrition.energy ?? item.nutrition.calories ?? 0), protein: String(item.nutrition.proteins ?? item.nutrition.protein ?? 0), fat: String(item.nutrition.fats ?? item.nutrition.fat ?? 0), carbs: String(item.nutrition.carbs ?? item.nutrition.carbohydrates ?? 0) } : null,
    image: item.override_image || item.image_url || '', source_url: '', sauce_options: [], addon_options: [], flavor_options: [], size_option: null,
    pairs_with: item.override_pairs_with ?? [], recommendations_note: null, is_available: !item.stopped, badge: item.stopped ? 'СТОП-ЛИСТ' : (item.override_badge ?? ''), image_position: item.override_image_position ?? 'center', allergens: '', spicy: 'none', sort_order: item.sort_order, modifier_groups: publicModifierGroups(item.modifier_groups), iiko: true,
  })) : localProducts.rows;
  const orders = await pool.query('select order_number, items, total, status_step, table_number, created_at from customer_orders where terminal_id = $1 and completed_at is null and created_at > now() - interval \'4 hours\' order by created_at desc', [terminalId]);
  return { products, promotions: promotions.rows, terminal: { ...terminal.rows[0], table_number: effectiveTable, table_source: fixedTable ? 'admin' : (chosen ? 'guest' : null), table_id: fixedTable ? null : (chosen?.table_id ?? null) }, orders: orders.rows, settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])) };
};

const serviceTypes = new Set(['waiter', 'cutlery', 'bill', 'help']);
const arrayValue = (value) => Array.isArray(value) ? value : [];
const sauceName = (value) => /^Соус «(.+)»$/u.exec(String(value ?? ''))?.[1] ?? '';

const normalizeOrder = async (input) => {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const ids = [...new Set(input.items.map((line) => String(line?.productId ?? '')).filter(Boolean))];
  if (!ids.length || ids.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const result = await pool.query('select id, price_rub, is_available, sauce_options, sauce_addon_price_rub, addon_options, flavor_options from products where id = any($1::text[])', [ids]);
  const products = new Map(result.rows.map((product) => [product.id, product]));
  if (products.size !== ids.length) throw Object.assign(new Error('Одно из блюд больше недоступно'), { status: 409 });
  let subtotal = 0;
  const items = input.items.map((line) => {
    const product = products.get(String(line.productId));
    const quantity = Number(line.quantity);
    if (!product?.is_available) throw Object.assign(new Error('Одно из блюд больше недоступно'), { status: 409 });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw Object.assign(new Error('Некорректное количество'), { status: 400 });
    if (line.kind === 'sauce') {
      const name = sauceName(line.customName);
      if (!name || !arrayValue(product.sauce_options).includes(name)) throw Object.assign(new Error('Некорректный соус'), { status: 400 });
      const price = Math.max(0, Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0);
      subtotal += price * quantity;
      return { key: `sauce|${product.id}|${name}`, productId: product.id, kind: 'sauce', customName: `Соус «${name}»`, customPrice: price, quantity };
    }
    if (line.kind && line.kind !== 'product') throw Object.assign(new Error('Некорректная позиция заказа'), { status: 400 });
    const addon = line.addon ? String(line.addon) : undefined;
    const flavor = line.flavor ? String(line.flavor) : undefined;
    if (addon && !arrayValue(product.addon_options).includes(addon)) throw Object.assign(new Error('Некорректная добавка'), { status: 400 });
    if (flavor && !arrayValue(product.flavor_options).includes(flavor)) throw Object.assign(new Error('Некорректный вариант блюда'), { status: 400 });
    subtotal += Number(product.price_rub) * quantity;
    return { key: ['product', product.id, addon, flavor].filter(Boolean).join('|'), productId: product.id, kind: 'product', ...(addon ? { addon } : {}), ...(flavor ? { flavor } : {}), quantity };
  });
  const promoCode = String(input.promo_code ?? '').trim().toUpperCase();
  const discount = promoCode === 'BOWL10' ? Math.round(subtotal * 0.1) : 0;
  return { items, total: Math.max(0, subtotal - discount), promoCode };
};
const normalizeIikoOrder = async (input) => {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const ids = [...new Set(input.items.filter((line) => line?.kind !== 'sauce').map((line) => String(line?.productId ?? '')).filter(Boolean))];
  const result = await pool.query(`select m.*, exists(select 1 from iiko_stop_list_items s where s.organization_id=$1 and s.terminal_group_id=$2 and s.product_id=m.product_id and s.balance<=0) as stopped from iiko_menu_items m where m.product_id = any($3::text[]) and not m.is_hidden`, [iikoOrganizationId, iikoTerminalGroupId, ids]);
  const products = new Map(result.rows.map((item) => [item.product_id, item]));
  if (products.size !== ids.length) throw Object.assign(new Error('Одно из блюд больше недоступно'), { status: 409 });
  let total = 0;
  const items = [];
  for (const line of input.items) {
    if (line?.kind === 'sauce') continue; // legacy local sauce lines are not valid for iiko products
    const product = products.get(String(line.productId));
    const amount = Number(line.quantity);
    if (!product || product.stopped) throw Object.assign(new Error('Одно из блюд больше недоступно'), { status: 409 });
    if (!Number.isInteger(amount) || amount < 1 || amount > 20) throw Object.assign(new Error('Некорректное количество'), { status: 400 });
    const allowedModifiers = new Map();
    for (const group of arrayValue(product.modifier_groups)) for (const modifier of arrayValue(group?.items)) if (modifier?.itemId) allowedModifiers.set(String(modifier.itemId), modifier);
    const modifiers = arrayValue(line.modifiers).map((modifier) => {
      const productId = String(modifier?.productId ?? ''); const modifierItem = allowedModifiers.get(productId); const modifierAmount = Number(modifier?.amount ?? 1);
      if (!modifierItem || !Number.isInteger(modifierAmount) || modifierAmount < 1 || modifierAmount > 20) throw Object.assign(new Error('Некорректная добавка'), { status: 400 });
      return { productId, amount: modifierAmount, name: String(modifierItem.name ?? ''), price: iikoPrice(modifierItem) };
    });
    total += (Number(product.price_rub) + modifiers.reduce((sum, modifier) => sum + modifier.price * modifier.amount, 0)) * amount;
    items.push({ key: `product|${product.product_id}|${modifiers.map((modifier) => modifier.productId).join(',')}`, productId: product.product_id, kind: 'product', quantity: amount, ...(modifiers.length ? { modifiers } : {}) });
  }
  if (!items.length) throw Object.assign(new Error('В заказе нет блюд'), { status: 400 });
  return { items, total: Math.round(total), promoCode: '', iikoItems: items.map((line) => ({ type: 'Product', productId: line.productId, amount: line.quantity, ...(line.modifiers?.length ? { modifiers: line.modifiers.map((modifier) => ({ productId: modifier.productId, amount: modifier.amount })) } : {}) })) };
};
const effectiveTableForTerminal = async (terminal) => {
  const fixed = String(terminal.table_number ?? '').trim();
  if (fixed) {
    const table = await pool.query('select * from iiko_tables where terminal_group_id=$1 and table_number=$2 limit 1', [iikoTerminalGroupId, fixed]);
    if (!table.rowCount) throw Object.assign(new Error('Стол из настроек терминала не найден в iiko'), { status: 409 });
    return table.rows[0];
  }
  const selection = await pool.query('select * from terminal_table_selections where terminal_id=$1', [terminal.id]);
  if (!selection.rowCount) throw Object.assign(new Error('Перед заказом выберите стол'), { status: 409 });
  return selection.rows[0];
};
const createIikoOrder = async ({ number, table, items, comment }) => {
  if (!iikoTerminalGroupId || !iikoOrderTypeId) throw Object.assign(new Error('Интеграция iiko ещё не настроена на сервере'), { status: 503 });
  const id = crypto.randomUUID();
  const payload = await iikoRequest('/api/1/order/create', { organizationId: iikoOrganizationId, terminalGroupId: iikoTerminalGroupId, createOrderSettings: { id, externalNumber: number, tableIds: [table.table_id], orderType: { id: iikoOrderTypeId }, items, comment: String(comment ?? '').slice(0, 1000), servicePrint: true, checkStopList: true } });
  if (payload?.errorInfo) throw Object.assign(new Error(payload.errorInfo?.message ?? 'iiko не принял заказ'), { status: 409 });
  return { id, response: payload };
};

const productFields = ['name', 'category', 'price_rub', 'portion', 'unit', 'description', 'kbju', 'image', 'source_url', 'sauce_options', 'sauce_addon_price_rub', 'addon_options', 'flavor_options', 'size_option', 'pairs_with', 'recommendations_note', 'is_available', 'badge', 'image_position', 'allergens', 'spicy', 'sort_order'];
const productJsonFields = new Set(['kbju', 'sauce_options', 'addon_options', 'flavor_options', 'size_option', 'pairs_with']);
const updateProduct = async (id, input, actor) => {
  const before = await pool.query('select * from products where id = $1', [id]);
  if (!before.rowCount) throw Object.assign(new Error('Product not found'), { status: 404 });
  const fields = productFields.filter((field) => Object.hasOwn(input, field));
  if (!fields.length) return before.rows[0];
  // node-postgres serialises JavaScript arrays as PostgreSQL arrays. These
  // columns are JSONB, so JSON.stringify is required for sauce/addon lists,
  // nutrition and product recommendations.
  const values = fields.map((field) => productJsonFields.has(field) ? JSON.stringify(input[field] ?? null) : input[field]);
  const assignment = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
  const result = await pool.query(`update products set ${assignment}, updated_at = now() where id = $${fields.length + 1} returning *`, [...values, id]);
  await audit(actor, 'update', 'product', id, before.rows[0], result.rows[0]);
  return result.rows[0];
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const path = url.pathname;
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS' && path.startsWith('/api/v1/')) {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
      return response.end();
    }
    if (request.method === 'GET' && path === '/api/v1/health') return json(response, 200, { ok: true });
    if (request.method === 'POST' && path === '/api/v1/iiko/webhook') {
      if (!iikoWebhookToken) return json(response, 503, { error: 'Webhook is not configured' });
      const provided = String(request.headers.authorization ?? '');
      const allowed = new Set([iikoWebhookToken, `Bearer ${iikoWebhookToken}`]);
      if (!allowed.has(provided)) return json(response, 401, { error: 'Unauthorized' });
      const events = await readBody(request);
      if (!Array.isArray(events) || events.length > 100) return json(response, 400, { error: 'Invalid webhook payload' });
      for (const event of events) {
        const eventType = String(event?.eventType ?? '');
        if (eventType !== 'TableOrderUpdate' && eventType !== 'TableOrderError' && eventType !== 'StopListUpdate') continue;
        await pool.query('insert into iiko_webhook_events(event_type,organization_id,correlation_id,event_time,payload) values ($1,$2,$3,$4,$5)', [eventType, event.organizationId ?? null, event.correlationId ?? null, event.eventTime ?? null, JSON.stringify(event)]);
        if (event?.eventInfo?.id) await saveIikoOrder(event.eventInfo, { organizationId: event.organizationId ?? iikoOrganizationId, eventType, webhook: true });
        if (eventType === 'StopListUpdate') {
          const terminalGroupIds = arrayValue(event?.eventInfo?.terminalGroupsStopListsUpdates).map((item) => String(item?.id ?? '')).filter(Boolean);
          await fetchIikoStopLists(terminalGroupIds);
        }
      }
      return json(response, 200, { ok: true });
    }
    if (request.method === 'GET' && path === '/api/v1/iiko/stop-list') {
      const terminalGroupId = url.searchParams.get('terminalGroupId');
      const groups = await fetchIikoStopLists(terminalGroupId ? [terminalGroupId] : []);
      return json(response, 200, { terminalGroupStopLists: groups });
    }
    if (request.method === 'GET' && path.startsWith('/api/v1/iiko/orders/') && path.endsWith('/status')) {
      const orderId = decodeURIComponent(path.slice('/api/v1/iiko/orders/'.length, -'/status'.length));
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json(response, 400, { error: 'Invalid order id' });
      let result = await pool.query('select * from iiko_orders where order_id=$1', [orderId]);
      if (!result.rowCount) return json(response, 404, { error: 'Статус заказа пока не получен' });
      return json(response, 200, publicIikoStatus(result.rows[0]));
    }
    // The native updater sends a POST request with device metadata. The public
    // manifest contains no secrets, so its contents are safe to return here.
    if (request.method === 'POST' && path === '/api/v1/ota/update') {
      try {
        const manifest = JSON.parse(await fs.readFile(otaManifestPath, 'utf8'));
        if (typeof manifest.version !== 'string' || typeof manifest.url !== 'string') throw new Error('Invalid manifest');
        return json(response, 200, manifest);
      } catch {
        return json(response, 200, { version: 'builtin' });
      }
    }
    if (request.method === 'GET' && path === '/api/v1/bootstrap') {
      const terminalId = url.searchParams.get('terminalId');
      if (!terminalId || !/^[a-zA-Z0-9_-]{8,80}$/.test(terminalId)) return json(response, 400, { error: 'Invalid terminalId' });
      return json(response, 200, await publicState(terminalId));
    }
    if (request.method === 'GET' && path === '/api/v1/tables') {
      const terminalId = url.searchParams.get('terminalId');
      if (!terminalId || !/^[a-zA-Z0-9_-]{8,80}$/.test(terminalId)) return json(response, 400, { error: 'Invalid terminalId' });
      const tables = await pool.query('select table_id,section_name,table_number,table_name from iiko_tables where terminal_group_id=$1 order by section_name, table_number', [iikoTerminalGroupId]);
      return json(response, 200, { tables: tables.rows });
    }
    if (request.method === 'POST' && path === '/api/v1/tables/select') {
      const body = await readBody(request);
      const terminalId = String(body.terminal_id ?? '');
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(terminalId) || !body.table_id) return json(response, 400, { error: 'Некорректный стол' });
      const terminal = await pool.query('insert into terminals(id) values($1) on conflict(id) do update set last_seen_at=now() returning *', [terminalId]);
      if (String(terminal.rows[0].table_number ?? '').trim()) return json(response, 409, { error: 'Для этого планшета стол уже задан администратором' });
      const table = await pool.query('select * from iiko_tables where table_id=$1 and terminal_group_id=$2', [String(body.table_id), iikoTerminalGroupId]);
      if (!table.rowCount) return json(response, 409, { error: 'Такого стола нет в актуальной схеме iiko' });
      const selected = table.rows[0];
      await pool.query(`insert into terminal_table_selections(terminal_id,table_id,table_number,table_name) values($1,$2,$3,$4)
        on conflict(terminal_id) do update set table_id=excluded.table_id,table_number=excluded.table_number,table_name=excluded.table_name,updated_at=now()`, [terminalId, selected.table_id, selected.table_number, selected.table_name]);
      return json(response, 200, { table_number: selected.table_number, table_id: selected.table_id, source: 'guest' });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/login') {
      const { password } = await readBody(request);
      if (!password || sha256(password) !== adminPasswordHash) return json(response, 401, { error: 'Неверный пароль' });
      return json(response, 200, { token: sign({ admin: true, exp: Date.now() + 8 * 60 * 60 * 1000 }) });
    }
    if (request.method === 'POST' && path === '/api/v1/waiter/login') {
      const body = await readBody(request); const pin = String(body.pin ?? '');
      const waiter = await pool.query('select id,display_name from waiter_profiles where restaurant_id=$1 and is_active=true and pin_hash=$2', [iikoOrganizationId, sha256(pin)]);
      if (!waiter.rowCount) return json(response, 401, { error: 'Неверный PIN-код' });
      const profile = waiter.rows[0];
      return json(response, 200, { token: sign({ waiterId: profile.id, exp: Date.now() + 12 * 60 * 60 * 1000 }), waiter: { id: profile.id, name: profile.display_name } });
    }
    if (request.method === 'GET' && path === '/api/v1/waiter/queue') {
      const waiter = requireWaiter(request);
      const [requests, orders] = await Promise.all([
        pool.query(`select id,table_number,request_type,status,created_at,accepted_by,accepted_at from service_requests where restaurant_id=$1 and status in ('new','accepted') and (accepted_by is null or accepted_by=$2) and created_at > now()-interval '8 hours' order by created_at desc`, [iikoOrganizationId, waiter.waiterId]),
        pool.query(`select order_number,table_number,items,total,status_step,created_at,source from customer_orders where restaurant_id=$1 and completed_at is null and created_at > now()-interval '8 hours' order by created_at desc`, [iikoOrganizationId]),
      ]);
      return json(response, 200, { requests: requests.rows, orders: orders.rows, serverTime: new Date().toISOString() });
    }
    if (request.method === 'POST' && path === '/api/v1/waiter/devices') {
      const waiter = requireWaiter(request); const body = await readBody(request); const deviceToken = String(body.token ?? '');
      if (deviceToken.length < 32 || deviceToken.length > 4096) return json(response, 400, { error: 'Некорректный токен устройства' });
      await pool.query(`insert into waiter_devices(waiter_id,token,platform) values($1,$2,$3) on conflict(token) do update set waiter_id=excluded.waiter_id,platform=excluded.platform,is_active=true,last_seen_at=now()`, [waiter.waiterId, deviceToken, String(body.platform ?? 'android')]);
      return json(response, 204, {});
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/accept')) {
      const waiter = requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/accept'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный вызов' });
      const result = await pool.query(`update service_requests set status='accepted',accepted_by=$1,accepted_at=now() where id=$2 and restaurant_id=$3 and status='new' returning *`, [waiter.waiterId, id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 409, { error: 'Этот вызов уже принял другой официант' });
      await publishEvent('waiter_request_accepted', 'service_request', String(id), { waiterId: waiter.waiterId, tableNumber: result.rows[0].table_number });
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/orders') {
      const body = await readBody(request);
      if (!body.terminal_id) return json(response, 400, { error: 'Некорректный заказ' });
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно не принимает заказы' });
      const useIiko = (await pool.query('select count(*)::int as count from iiko_menu_items')).rows[0].count > 0;
      const order = useIiko ? await normalizeIikoOrder(body) : await normalizeOrder(body);
      const table = useIiko ? await effectiveTableForTerminal(terminal.rows[0]) : { table_number: terminal.rows[0].table_number };
      const clientRequestId = String(body.client_request_id ?? '').trim();
      if (clientRequestId) {
        const existing = await pool.query('select order_number,items,total,status_step,table_number,created_at from customer_orders where restaurant_id=$1 and client_request_id=$2', [iikoOrganizationId, clientRequestId]);
        if (existing.rowCount) return json(response, 200, existing.rows[0]);
      }
      const sessionId = await createGuestSession({ terminalId: String(body.terminal_id), source: body.source === 'qr' ? 'qr' : 'tablet', table, metadata: { clientRequestId: clientRequestId || null } });
      let saved;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const number = `B-${crypto.randomInt(1000, 10000)}`;
        try {
          let iikoOrderId = null;
          if (useIiko) iikoOrderId = (await createIikoOrder({ number, table, items: order.iikoItems, comment: body.comment })).id;
          saved = await pool.query('insert into customer_orders(order_number,terminal_id,table_number,items,total,comment,promo_code,iiko_order_id,restaurant_id,guest_session_id,source,client_request_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning order_number, items, total, status_step, table_number, created_at', [number, body.terminal_id, table.table_number, JSON.stringify(order.items), order.total, String(body.comment ?? '').slice(0, 1000), order.promoCode, iikoOrderId, iikoOrganizationId, sessionId, body.source === 'qr' ? 'qr' : 'tablet', clientRequestId || null]);
          break;
        } catch (error) { if (error.code !== '23505') throw error; }
      }
      if (!saved) throw new Error('Unable to allocate order number');
      await publishEvent('order_created', 'order', saved.rows[0].order_number, { tableNumber: saved.rows[0].table_number, source: body.source === 'qr' ? 'qr' : 'tablet', total: Number(saved.rows[0].total) });
      void notifyWaiters(`Новый заказ · стол №${saved.rows[0].table_number}`, `Заказ ${saved.rows[0].order_number} на ${saved.rows[0].total} ₽`, { type: 'order', orderNumber: saved.rows[0].order_number, tableNumber: saved.rows[0].table_number });
      return json(response, 201, saved.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/service-requests') {
      const body = await readBody(request);
      const type = String(body.type ?? '');
      if (!body.terminal_id || !serviceTypes.has(type)) return json(response, 400, { error: 'Некорректный запрос' });
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно недоступен' });
      const table = await effectiveTableForTerminal(terminal.rows[0]);
      const sessionId = await createGuestSession({ terminalId: String(body.terminal_id), table });
      const created = await pool.query('insert into service_requests(terminal_id, table_number, request_type, restaurant_id, guest_session_id) values ($1,$2,$3,$4,$5) returning id', [String(body.terminal_id), table.table_number, type, iikoOrganizationId, sessionId]);
      await publishEvent('waiter_called', 'service_request', String(created.rows[0].id), { tableNumber: table.table_number, type });
      void notifyWaiters(`Стол №${table.table_number}`, `Новый вызов: ${type}`, { type: 'service_request', requestId: created.rows[0].id, tableNumber: table.table_number, requestType: type });
      return json(response, 201, { ok: true });
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/orders/') && path.endsWith('/complete')) {
      const orderNumber = decodeURIComponent(path.slice('/api/v1/orders/'.length, -'/complete'.length));
      const body = await readBody(request);
      if (!body.terminal_id || !orderNumber) return json(response, 400, { error: 'Некорректный заказ' });
      const result = await pool.query('update customer_orders set completed_at = now(), updated_at = now() where order_number = $1 and terminal_id = $2 and completed_at is null', [orderNumber, String(body.terminal_id)]);
      if (!result.rowCount) return json(response, 404, { error: 'Заказ не найден или уже завершён' });
      const terminal = await pool.query('select table_number from terminals where id=$1', [String(body.terminal_id)]);
      if (!String(terminal.rows[0]?.table_number ?? '').trim()) await pool.query('delete from terminal_table_selections where terminal_id=$1', [String(body.terminal_id)]);
      return json(response, 204, {});
    }
    if (!path.startsWith('/api/v1/admin/')) return json(response, 404, { error: 'Not found' });
    const actor = requireAdmin(request).admin ? 'admin' : 'unknown';
    if (request.method === 'GET' && path === '/api/v1/admin/state') return json(response, 200, await publicState(url.searchParams.get('terminalId') ?? 'admin-preview'));
    if (request.method === 'GET' && path === '/api/v1/admin/waiters') {
      const result = await pool.query('select id,display_name,is_active,created_at from waiter_profiles where restaurant_id=$1 order by display_name', [iikoOrganizationId]); return json(response, 200, result.rows);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/waiters') {
      const body = await readBody(request); const name=String(body.name??'').trim(); const pin=String(body.pin??'');
      if (!name || !/^\d{4,8}$/.test(pin)) return json(response,400,{error:'Укажите имя и PIN из 4–8 цифр'});
      const id=crypto.randomUUID(); const result=await pool.query('insert into waiter_profiles(id,restaurant_id,display_name,pin_hash) values($1,$2,$3,$4) returning id,display_name,is_active,created_at',[id,iikoOrganizationId,name,sha256(pin)]);
      await audit(actor,'create','waiter',id,null,result.rows[0]); return json(response,201,result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/iiko-products/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/iiko-products/'.length)); const body = await readBody(request);
      const exists = await pool.query('select product_id from iiko_menu_items where product_id=$1', [id]);
      if (!exists.rowCount) return json(response, 404, { error: 'Блюдо iiko не найдено' });
      const result = await pool.query(`insert into iiko_product_overrides(product_id,image,image_position,badge,pairs_with) values($1,$2,$3,$4,$5)
        on conflict(product_id) do update set image=excluded.image,image_position=excluded.image_position,badge=excluded.badge,pairs_with=excluded.pairs_with,updated_at=now() returning *`, [id, String(body.image ?? ''), String(body.image_position ?? 'center'), String(body.badge ?? ''), JSON.stringify(arrayValue(body.pairs_with))]);
      await audit(actor, 'update', 'iiko_product_override', id, null, result.rows[0]); return json(response, 200, result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/products/')) {
      const product = await updateProduct(decodeURIComponent(path.slice('/api/v1/admin/products/'.length)), await readBody(request), actor);
      return json(response, 200, product);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/terminals/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/terminals/'.length));
      const body = await readBody(request);
      const before = await pool.query('select * from terminals where id = $1', [id]);
      const result = await pool.query('insert into terminals(id, label, table_number, is_active, idle_seconds) values ($1,$2,$3,$4,$5) on conflict (id) do update set label = excluded.label, table_number = excluded.table_number, is_active = excluded.is_active, idle_seconds = excluded.idle_seconds, updated_at = now() returning *', [id, String(body.label ?? ''), String(body.table_number ?? ''), body.is_active !== false, Math.max(15, Number(body.idle_seconds ?? 45))]);
      await audit(actor, 'update', 'terminal', id, before.rows[0] ?? null, result.rows[0]);
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/promotions') {
      const body = await readBody(request);
      const result = await pool.query('insert into promotions(product_id, title, subtitle, label, active, sort_order) values ($1,$2,$3,$4,$5,$6) returning *', [body.product_id, body.title, body.subtitle, body.label, body.active !== false, Number(body.sort_order ?? 0)]);
      await audit(actor, 'create', 'promotion', result.rows[0].id, null, result.rows[0]);
      return json(response, 201, result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/promotions/')) {
      const id = Number(path.slice('/api/v1/admin/promotions/'.length));
      const body = await readBody(request);
      const before = await pool.query('select * from promotions where id = $1', [id]);
      if (!before.rowCount) return json(response, 404, { error: 'Promotion not found' });
      const result = await pool.query('update promotions set product_id=$1,title=$2,subtitle=$3,label=$4,active=$5,sort_order=$6,updated_at=now() where id=$7 returning *', [body.product_id, body.title, body.subtitle, body.label, body.active !== false, Number(body.sort_order ?? 0), id]);
      await audit(actor, 'update', 'promotion', id, before.rows[0], result.rows[0]);
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/admin/promotions/')) {
      const id = Number(path.slice('/api/v1/admin/promotions/'.length));
      const before = await pool.query('delete from promotions where id = $1 returning *', [id]);
      if (!before.rowCount) return json(response, 404, { error: 'Promotion not found' });
      await audit(actor, 'delete', 'promotion', id, before.rows[0], null);
      return json(response, 204, {});
    }
    if (request.method === 'GET' && path === '/api/v1/admin/audit') {
      const result = await pool.query('select * from audit_log order by created_at desc limit 100');
      return json(response, 200, result.rows);
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    return json(response, status, { error: status === 500 ? 'Internal server error' : error.message });
  }
});

let backgroundSyncRunning = false;
const syncActiveIikoOrders = async () => {
  const active = await pool.query(`select iiko_order_id from customer_orders where iiko_order_id is not null and completed_at is null and status_step < 4 and updated_at > now() - interval '8 hours' limit 30`);
  for (const row of active.rows) await fetchIikoOrder(row.iiko_order_id);
};
const backgroundSync = async () => {
  if (backgroundSyncRunning) return;
  backgroundSyncRunning = true;
  try {
    const results = await Promise.allSettled([syncIikoMenu(), syncIikoTables(), fetchIikoStopLists(iikoTerminalGroupId ? [iikoTerminalGroupId] : [])]);
    results.filter((result) => result.status === 'rejected').forEach((result) => console.warn('iiko cache sync:', result.reason?.message ?? result.reason));
    await syncActiveIikoOrders();
  } catch (error) { console.warn('iiko background sync:', error.message); }
  finally { backgroundSyncRunning = false; }
};

server.listen(port, '127.0.0.1', () => {
  console.log(`Zakaz API listening on ${port}`);
  setTimeout(() => { void backgroundSync(); }, 3_000);
  // No tablet makes these calls. Menu/tables/stop-list are refreshed in one
  // controlled server task; active orders use webhooks first and this fallback.
  setInterval(() => { void backgroundSync(); }, 10 * 60 * 1_000).unref();
  setInterval(() => { void syncActiveIikoOrders().catch((error) => console.warn('iiko order sync:', error.message)); }, 2 * 60 * 1_000).unref();
});
