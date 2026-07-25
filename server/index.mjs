import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 3107);
const tokenSecret = process.env.TOKEN_SECRET;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
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
const updateProduct = async (id, input, actor) => {
  const before = await pool.query('select * from products where id = $1', [id]);
  if (!before.rowCount) throw Object.assign(new Error('Product not found'), { status: 404 });
  const fields = productFields.filter((field) => Object.hasOwn(input, field));
  if (!fields.length) return before.rows[0];
  const values = fields.map((field) => input[field]);
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
