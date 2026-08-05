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
const audit = (actor, action, entity, entityId, before, after) => pool.query(
  'insert into audit_log(actor, action, entity, entity_id, before_data, after_data) values ($1,$2,$3,$4,$5,$6)',
  [actor, action, entity, entityId, before ?? null, after ?? null],
);

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
  const [products, promotions, terminal, settings] = await Promise.all([
    pool.query('select * from products order by category, sort_order, name'),
    pool.query('select * from promotions order by sort_order, created_at desc'),
    pool.query('insert into terminals(id) values ($1) on conflict (id) do update set last_seen_at = now() returning *', [terminalId]),
    pool.query('select key, value from app_settings'),
  ]);
  const orders = await pool.query('select order_number, items, total, status_step, table_number, created_at from customer_orders where terminal_id = $1 and completed_at is null and created_at > now() - interval \'4 hours\' order by created_at desc', [terminalId]);
  return { products: products.rows, promotions: promotions.rows, terminal: terminal.rows[0], orders: orders.rows, settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])) };
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
      const isStale = !result.rowCount || Date.now() - new Date(result.rows[0].updated_at).getTime() > 15_000;
      if (isStale) {
        const synced = await fetchIikoOrder(orderId);
        result = { rowCount: 1, rows: [synced] };
      }
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
    if (request.method === 'POST' && path === '/api/v1/admin/login') {
      const { password } = await readBody(request);
      if (!password || sha256(password) !== adminPasswordHash) return json(response, 401, { error: 'Неверный пароль' });
      return json(response, 200, { token: sign({ admin: true, exp: Date.now() + 8 * 60 * 60 * 1000 }) });
    }
    if (request.method === 'POST' && path === '/api/v1/orders') {
      const body = await readBody(request);
      if (!body.terminal_id) return json(response, 400, { error: 'Некорректный заказ' });
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно не принимает заказы' });
      const order = await normalizeOrder(body);
      let saved;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const number = `B-${crypto.randomInt(1000, 10000)}`;
        try {
          saved = await pool.query('insert into customer_orders(order_number,terminal_id,table_number,items,total,comment,promo_code) values ($1,$2,$3,$4,$5,$6,$7) returning order_number, items, total, status_step, table_number, created_at', [number, body.terminal_id, terminal.rows[0].table_number, JSON.stringify(order.items), order.total, String(body.comment ?? '').slice(0, 1000), order.promoCode]);
          break;
        } catch (error) { if (error.code !== '23505') throw error; }
      }
      if (!saved) throw new Error('Unable to allocate order number');
      return json(response, 201, saved.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/service-requests') {
      const body = await readBody(request);
      const type = String(body.type ?? '');
      if (!body.terminal_id || !serviceTypes.has(type)) return json(response, 400, { error: 'Некорректный запрос' });
      const terminal = await pool.query('select table_number from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно недоступен' });
      await pool.query('insert into service_requests(terminal_id, table_number, request_type) values ($1,$2,$3)', [String(body.terminal_id), terminal.rows[0].table_number, type]);
      return json(response, 201, { ok: true });
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/orders/') && path.endsWith('/complete')) {
      const orderNumber = decodeURIComponent(path.slice('/api/v1/orders/'.length, -'/complete'.length));
      const body = await readBody(request);
      if (!body.terminal_id || !orderNumber) return json(response, 400, { error: 'Некорректный заказ' });
      const result = await pool.query('update customer_orders set completed_at = now(), updated_at = now() where order_number = $1 and terminal_id = $2 and completed_at is null', [orderNumber, String(body.terminal_id)]);
      if (!result.rowCount) return json(response, 404, { error: 'Заказ не найден или уже завершён' });
      return json(response, 204, {});
    }
    if (!path.startsWith('/api/v1/admin/')) return json(response, 404, { error: 'Not found' });
    const actor = requireAdmin(request).admin ? 'admin' : 'unknown';
    if (request.method === 'GET' && path === '/api/v1/admin/state') return json(response, 200, await publicState(url.searchParams.get('terminalId') ?? 'admin-preview'));
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

server.listen(port, '127.0.0.1', () => console.log(`Zakaz API listening on ${port}`));
