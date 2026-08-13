import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import pathModule from 'node:path';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 3107);
const tokenSecret = process.env.TOKEN_SECRET;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const terminalAdminPasswordHash = process.env.TERMINAL_ADMIN_PASSWORD_HASH ?? adminPasswordHash;
let iikoApiBase = process.env.IIKO_API_BASE || 'https://api-ru.iiko.services';
let iikoOrganizationId = process.env.IIKO_ORGANIZATION_ID ?? '';
let iikoWebhookToken = process.env.IIKO_WEBHOOK_TOKEN ?? '';
const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const publicIikoWebhookUrl = process.env.IIKO_WEBHOOK_URL || 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1/iiko/webhook';
let iikoTerminalGroupId = process.env.IIKO_TERMINAL_GROUP_ID ?? '';
let iikoExternalMenuId = process.env.IIKO_EXTERNAL_MENU_ID ?? '';
let iikoOrderTypeId = process.env.IIKO_ORDER_TYPE_ID ?? '';
let iikoOrderSourceKey = process.env.IIKO_ORDER_SOURCE_KEY || 'BrooklynBowl Kiosk';
let iikoAppId = process.env.IIKO_APP_ID ?? '';
let iikoApiLogin = process.env.IIKO_API_LOGIN ?? '';
let iikoClientSecret = process.env.IIKO_CLIENT_SECRET ?? '';
const iikoConfigEncryptionKeyHex = process.env.IIKO_CONFIG_ENCRYPTION_KEY ?? '';
const otaManifestPath = process.env.OTA_MANIFEST_PATH ?? '/var/www/zakaz-zvyak/ota/manifest.json';
const bannerUploadDir = process.env.BANNER_UPLOAD_DIR ?? '/var/www/zakaz-zvyak/uploads/banners';
const bannerPublicPath = process.env.BANNER_PUBLIC_PATH ?? '/uploads/banners';
const productUploadDir = process.env.PRODUCT_UPLOAD_DIR ?? '/var/www/zakaz-zvyak/uploads/products';
const productPublicPath = process.env.PRODUCT_PUBLIC_PATH ?? '/uploads/products';
const allowedOrigins = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost', 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai']);

if (!process.env.DATABASE_URL || !tokenSecret || !adminPasswordHash || !/^[a-f0-9]{64}$/i.test(iikoConfigEncryptionKeyHex)) throw new Error('DATABASE_URL, TOKEN_SECRET, ADMIN_PASSWORD_HASH and a 32-byte IIKO_CONFIG_ENCRYPTION_KEY are required');
if (!/^https:\/\/[^\s]+$/i.test(publicIikoWebhookUrl)) throw new Error('IIKO_WEBHOOK_URL must be a public HTTPS URL');
const iikoConfigEncryptionKey = Buffer.from(iikoConfigEncryptionKeyHex, 'hex');

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
const readBody = async (request, maxBytes = 1_000_000) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};
const parseImageUpload = (body) => {
  const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(String(body.data_url ?? ''));
  if (!match) throw Object.assign(new Error('Поддерживаются PNG, JPEG и WebP'), { status: 400 });
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 8 * 1024 * 1024) throw Object.assign(new Error('Изображение должно быть не больше 8 МБ'), { status: 413 });
  const valid = match[1] === 'png'
    ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg'
      ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw Object.assign(new Error('Файл изображения повреждён'), { status: 400 });
  return { data, extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
};
const saveImageUpload = async (body, directory, publicPath) => {
  const { data, extension } = parseImageUpload(body);
  const filename = `${crypto.randomUUID()}.${extension}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(pathModule.join(directory, filename), data, { flag: 'wx' });
  return `${publicPath}/${filename}`;
};
const bannerKinds = new Set(['restaurant', 'advertising']);
const bannerPayload = (body) => {
  const kind = String(body.kind ?? 'restaurant');
  const imageUrl = String(body.image_url ?? '').trim();
  const productId = String(body.product_id ?? '').trim() || null;
  const startsAt = body.starts_at ? new Date(body.starts_at) : null;
  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  const impressionLimit = body.impression_limit === null || body.impression_limit === undefined || body.impression_limit === '' ? null : Number(body.impression_limit);
  const sortOrder = Number(body.sort_order ?? 0);
  if (!bannerKinds.has(kind)) throw Object.assign(new Error('Некорректный тип баннера'), { status: 400 });
  if (productId && productId.length > 160) throw Object.assign(new Error('Некорректное блюдо для баннера'), { status: 400 });
  if (!imageUrl || (!imageUrl.startsWith('/uploads/banners/') && !imageUrl.startsWith('/images/') && !/^https:\/\//i.test(imageUrl))) throw Object.assign(new Error('Загрузите изображение баннера'), { status: 400 });
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) throw Object.assign(new Error('Некорректный период показа'), { status: 400 });
  if (startsAt && endsAt && endsAt <= startsAt) throw Object.assign(new Error('Окончание показа должно быть позже начала'), { status: 400 });
  if (impressionLimit !== null && (!Number.isInteger(impressionLimit) || impressionLimit < 1)) throw Object.assign(new Error('Лимит показов должен быть целым положительным числом'), { status: 400 });
  if (!Number.isInteger(sortOrder)) throw Object.assign(new Error('Некорректный порядок баннера'), { status: 400 });
  if (kind === 'advertising' && (!startsAt || !endsAt || !impressionLimit)) throw Object.assign(new Error('Для рекламного баннера укажите начало, окончание и лимит показов'), { status: 400 });
  return { name: String(body.name ?? '').trim().slice(0, 120) || 'Баннер', imageUrl, productId, kind, active: body.active !== false, startsAt, endsAt, impressionLimit, sortOrder };
};
const ensureBannerProduct = async (productId) => {
  if (!productId) return null;
  const exists = await pool.query(`select sku from iiko_menu_items where product_id=$1 and not is_hidden union all select null::text as sku from products where id=$1 limit 1`, [productId]);
  if (!exists.rowCount) throw Object.assign(new Error('Выбранное блюдо не найдено в актуальном меню'), { status: 400 });
  return exists.rows[0].sku ?? null;
};
const removeUploadedBanner = async (imageUrl) => {
  if (!String(imageUrl ?? '').startsWith(`${bannerPublicPath}/`)) return;
  const filename = pathModule.basename(String(imageUrl));
  if (!/^[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(filename)) return;
  await fs.unlink(pathModule.join(bannerUploadDir, filename)).catch((error) => { if (error.code !== 'ENOENT') console.warn('Unable to remove banner image:', error.message); });
};
const removeUploadedProduct = async (imageUrl) => {
  if (!String(imageUrl ?? '').startsWith(`${productPublicPath}/`)) return;
  const filename = pathModule.basename(String(imageUrl));
  if (!/^[a-f0-9-]+\.(png|jpe?g|webp)$/i.test(filename)) return;
  await fs.unlink(pathModule.join(productUploadDir, filename)).catch((error) => { if (error.code !== 'ENOENT') console.warn('Unable to remove product image:', error.message); });
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = (value) => { const salt=crypto.randomBytes(16); const key=crypto.scryptSync(value,salt,32); return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`; };
const passwordMatches = (value, encoded) => {
  const [scheme,saltHex,keyHex] = String(encoded ?? '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return sha256(value) === encoded;
  try { const expected=Buffer.from(keyHex,'hex'); const actual=crypto.scryptSync(value,Buffer.from(saltHex,'hex'),expected.length); return expected.length===actual.length && crypto.timingSafeEqual(expected,actual); } catch { return false; }
};
const deterministicUuid = (value) => {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const allowedIikoApiBases = new Set(['https://api-ru.iiko.services']);
const encryptIikoCredentials = (credentials) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', iikoConfigEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
};
const decryptIikoCredentials = (row) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', iikoConfigEncryptionKey, Buffer.from(row.credentials_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.credentials_tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.credentials_ciphertext, 'base64')), decipher.final()]).toString('utf8'));
};
const validateIikoConfig = (value) => {
  const config = {
    apiBase: String(value.apiBase ?? '').trim().replace(/\/$/, ''), appId: String(value.appId ?? '').trim(), apiLogin: String(value.apiLogin ?? '').trim(), clientSecret: String(value.clientSecret ?? '').trim(),
    organizationId: String(value.organizationId ?? '').trim(), terminalGroupId: String(value.terminalGroupId ?? '').trim(), externalMenuId: String(value.externalMenuId ?? '').trim(), orderTypeId: String(value.orderTypeId ?? '').trim(),
    orderSourceKey: String(value.orderSourceKey ?? 'BrooklynBowl Kiosk').trim(), webhookToken: String(value.webhookToken ?? '').trim(),
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!allowedIikoApiBases.has(config.apiBase)) throw Object.assign(new Error('Допустим только официальный российский адрес iiko Cloud API'), { status: 400 });
  if (!uuid.test(config.appId) || !uuid.test(config.organizationId) || !uuid.test(config.terminalGroupId) || !uuid.test(config.orderTypeId)) throw Object.assign(new Error('Проверьте UUID приложения, организации, терминальной группы и типа заказа'), { status: 400 });
  if (!/^[a-zA-Z0-9=_-]{16,200}$/.test(config.apiLogin) || config.clientSecret.length < 24) throw Object.assign(new Error('API Login или Client Secret имеют неверный формат'), { status: 400 });
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.externalMenuId)) throw Object.assign(new Error('Некорректный ID внешнего меню'), { status: 400 });
  if (!config.orderSourceKey || config.orderSourceKey.length > 120) throw Object.assign(new Error('Источник заказа должен содержать от 1 до 120 символов'), { status: 400 });
  if (config.webhookToken.length < 32 || config.webhookToken.length > 256) throw Object.assign(new Error('Webhook Token должен содержать от 32 до 256 символов'), { status: 400 });
  return config;
};
const applyRuntimeIikoConfig = (config) => {
  iikoApiBase = config.apiBase; iikoAppId = config.appId; iikoApiLogin = config.apiLogin; iikoClientSecret = config.clientSecret;
  iikoOrganizationId = config.organizationId; iikoTerminalGroupId = config.terminalGroupId; iikoExternalMenuId = config.externalMenuId;
  iikoOrderTypeId = config.orderTypeId; iikoOrderSourceKey = config.orderSourceKey; iikoWebhookToken = config.webhookToken;
  iikoAccessToken = ''; iikoAccessTokenExpiresAt = 0; iikoRetryAfter = 0;
};
let iikoConnectionMetadata = null;
let iikoConfigSwitching = false;
const runtimeIikoConfig = () => ({ apiBase: iikoApiBase, appId: iikoAppId, apiLogin: iikoApiLogin, clientSecret: iikoClientSecret, organizationId: iikoOrganizationId, terminalGroupId: iikoTerminalGroupId, externalMenuId: iikoExternalMenuId, orderTypeId: iikoOrderTypeId, orderSourceKey: iikoOrderSourceKey, webhookToken: iikoWebhookToken });
const configFromRow = (row) => validateIikoConfig({
  apiBase: row.api_base, organizationId: row.organization_id, terminalGroupId: row.terminal_group_id, externalMenuId: row.external_menu_id,
  orderTypeId: row.order_type_id, orderSourceKey: row.order_source_key, ...decryptIikoCredentials(row),
});
const safeIikoConfig = (row = iikoConnectionMetadata) => row ? ({
  apiBase: row.api_base, organizationId: row.organization_id, terminalGroupId: row.terminal_group_id, externalMenuId: row.external_menu_id, orderTypeId: row.order_type_id, orderSourceKey: row.order_source_key,
  appIdConfigured: true, apiLoginConfigured: true, clientSecretConfigured: true, webhookTokenConfigured: true,
  updatedAt: row.updated_at, configuredBy: row.configured_by, lastTestAt: row.last_test_at, lastTestDetails: row.last_test_details,
}) : ({ apiBase: iikoApiBase, organizationId: iikoOrganizationId, terminalGroupId: iikoTerminalGroupId, externalMenuId: iikoExternalMenuId, orderTypeId: iikoOrderTypeId, orderSourceKey: iikoOrderSourceKey,
  appIdConfigured: Boolean(iikoAppId), apiLoginConfigured: Boolean(iikoApiLogin), clientSecretConfigured: Boolean(iikoClientSecret), webhookTokenConfigured: Boolean(iikoWebhookToken),
  updatedAt: null, configuredBy: 'Не настроено', lastTestAt: null, lastTestDetails: null });
const loadStoredIikoConfig = async () => {
  let result = await pool.query("select * from iiko_connection_settings where id='active'");
  if (!result.rowCount) {
    if (![iikoAppId,iikoApiLogin,iikoClientSecret,iikoOrganizationId,iikoTerminalGroupId,iikoExternalMenuId,iikoOrderTypeId,iikoWebhookToken].every(Boolean)) return;
    const initial = validateIikoConfig({ apiBase: iikoApiBase, appId: iikoAppId, apiLogin: iikoApiLogin, clientSecret: iikoClientSecret, organizationId: iikoOrganizationId, terminalGroupId: iikoTerminalGroupId, externalMenuId: iikoExternalMenuId, orderTypeId: iikoOrderTypeId, orderSourceKey: iikoOrderSourceKey, webhookToken: iikoWebhookToken });
    const encrypted = encryptIikoCredentials({ appId: initial.appId, apiLogin: initial.apiLogin, clientSecret: initial.clientSecret, webhookToken: initial.webhookToken });
    result = await pool.query(`insert into iiko_connection_settings(id,api_base,organization_id,terminal_group_id,external_menu_id,order_type_id,order_source_key,credentials_ciphertext,credentials_iv,credentials_tag,configured_by)
      values('active',$1,$2,$3,$4,$5,$6,$7,$8,$9,'environment-migration') returning *`, [initial.apiBase, initial.organizationId, initial.terminalGroupId, initial.externalMenuId, initial.orderTypeId, initial.orderSourceKey, encrypted.ciphertext, encrypted.iv, encrypted.tag]);
  }
  iikoConnectionMetadata = result.rows[0];
  applyRuntimeIikoConfig(configFromRow(result.rows[0]));
};
const candidateIikoConfig = (body) => {
  const current = iikoConnectionMetadata ? configFromRow(iikoConnectionMetadata) : runtimeIikoConfig();
  const keepSecret = (name) => String(body[name] ?? '').trim() || current[name];
  return validateIikoConfig({
    apiBase: body.apiBase ?? current.apiBase, appId: keepSecret('appId'), apiLogin: keepSecret('apiLogin'), clientSecret: keepSecret('clientSecret'), webhookToken: keepSecret('webhookToken'),
    organizationId: body.organizationId ?? current.organizationId, terminalGroupId: body.terminalGroupId ?? current.terminalGroupId, externalMenuId: body.externalMenuId ?? current.externalMenuId,
    orderTypeId: body.orderTypeId ?? current.orderTypeId, orderSourceKey: body.orderSourceKey ?? current.orderSourceKey,
  });
};
const iikoConfigHash = (config) => sha256(JSON.stringify(config));
const credentialsForIikoDiscovery = (body) => {
  const current = iikoConnectionMetadata ? configFromRow(iikoConnectionMetadata) : runtimeIikoConfig();
  const config = { ...current, apiBase: 'https://api-ru.iiko.services', appId: String(body.appId ?? '').trim() || current.appId, apiLogin: String(body.apiLogin ?? '').trim() || current.apiLogin, clientSecret: String(body.clientSecret ?? '').trim() || current.clientSecret };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(config.appId) || !/^[a-zA-Z0-9=_-]{16,200}$/.test(config.apiLogin) || config.clientSecret.length < 24) throw Object.assign(new Error('Проверьте App ID, API Login и Client Secret'), { status: 400 });
  return config;
};
const configFromIikoDiscovery = (session, body) => {
  const options = session.options;
  const organizationId = String(body.organizationId ?? ''); const terminalGroupId = String(body.terminalGroupId ?? ''); const externalMenuId = String(body.externalMenuId ?? '');
  if (!options || options.organizationId !== organizationId) throw Object.assign(new Error('Сначала выберите ресторан и получите его параметры'), { status: 409 });
  if (!options.terminalGroups.some((item) => item.id === terminalGroupId)) throw Object.assign(new Error('Выберите доступную кассовую группу'), { status: 400 });
  if (!options.externalMenus.some((item) => item.id === externalMenuId)) throw Object.assign(new Error('Выберите доступное внешнее меню'), { status: 400 });
  const existingWebhook = String(session.config.webhookToken ?? '');
  return validateIikoConfig({ ...session.config, organizationId, terminalGroupId, externalMenuId, orderTypeId: options.orderTypeId, orderSourceKey: 'BrooklynBowl Kiosk', webhookToken: existingWebhook });
};
const requestIp = (request) => String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0].trim();
const authAttemptKey = (request, realm) => sha256(`${realm}:${requestIp(request)}`);
const assertAuthAllowed = async (key) => {
  const result = await pool.query('select failures,locked_until from auth_attempts where attempt_key=$1', [key]);
  const lockedUntil = result.rows[0]?.locked_until ? new Date(result.rows[0].locked_until) : null;
  if (lockedUntil && lockedUntil > new Date()) {
    const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
    throw Object.assign(new Error(`Слишком много попыток. Повторите через ${Math.ceil(retryAfter / 60)} мин.`), { status: 429, retryAfter });
  }
};
const recordAuthFailure = async (key) => {
  await pool.query(`insert into auth_attempts(attempt_key,failures) values($1,1)
    on conflict(attempt_key) do update set
      failures=case when auth_attempts.window_started_at < now()-interval '15 minutes' then 1 else auth_attempts.failures+1 end,
      window_started_at=case when auth_attempts.window_started_at < now()-interval '15 minutes' then now() else auth_attempts.window_started_at end,
      locked_until=case when (case when auth_attempts.window_started_at < now()-interval '15 minutes' then 1 else auth_attempts.failures+1 end)>=5 then now()+interval '15 minutes' else null end,
      updated_at=now()`, [key]);
};
const clearAuthFailures = (key) => pool.query('delete from auth_attempts where attempt_key=$1', [key]);
const requestWindows = new Map();
const enforceRequestRate = (key, limit, windowMs) => {
  const now = Date.now(); const current = requestWindows.get(key);
  if (requestWindows.size > 5_000) for (const [entryKey, value] of requestWindows) if (value.resetAt <= now) requestWindows.delete(entryKey);
  if (!current || current.resetAt <= now) { requestWindows.set(key, { count: 1, resetAt: now + windowMs }); return; }
  current.count += 1;
  if (current.count > limit) throw Object.assign(new Error('Слишком много запросов. Повторите немного позже.'), { status: 429, retryAfter: Math.ceil((current.resetAt - now) / 1000) });
};
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
const requireIikoConfigAccess = (request) => {
  const payload = requireAdmin(request);
  if (!payload.configAccess || payload.role !== 'administrator') throw Object.assign(new Error('Требуется повторное подтверждение пароля администратора'), { status: 403 });
  return payload;
};
const verifyAdministratorPassword = async (admin, password) => {
  if (admin.role !== 'administrator' || !password) return false;
  if (!admin.userId) return sha256(password) === adminPasswordHash;
  const result = await pool.query('select password_hash from admin_users where id=$1 and is_active=true', [admin.userId]);
  return Boolean(result.rowCount && passwordMatches(password, result.rows[0].password_hash));
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
const recordMonitoringEvent = async (component, message, context = {}, severity = 'error') => {
  try {
    await pool.query('insert into monitoring_events(component,severity,message,context) values($1,$2,$3,$4)', [component, severity, String(message).slice(0, 1000), JSON.stringify(context)]);
  } catch (error) { console.warn('Unable to persist monitoring event:', error.message); }
};
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
    // Data-only message lets the native waiter client show an urgent full-screen notification.
    const payload = Object.fromEntries(Object.entries({ title, body, ...data }).map(([key, value]) => [key, String(value ?? '')]));
    const result = await messaging.sendEachForMulticast({ tokens: tokens.rows.map((row) => row.token), data: payload, android: { priority: 'high' } });
    result.responses.forEach((response, index) => { if (!response.success && /registration-token-not-registered|invalid-registration-token/.test(response.error?.code ?? '')) void pool.query('update waiter_devices set is_active=false where token=$1', [tokens.rows[index].token]); });
  } catch (error) { console.warn('Firebase waiter notification:', error.message); }
};
const getOrCreateGuestSession = async ({ terminalId = null, source = 'tablet', table = null, metadata = {} }) => {
  const existing = terminalId ? await pool.query(`select id from guest_sessions where restaurant_id=$1 and terminal_id=$2 and source=$3 and table_number=$4 and status='active' order by last_seen_at desc limit 1`, [iikoOrganizationId, terminalId, source, table?.table_number ?? '']) : { rows: [] };
  if (existing.rows[0]?.id) {
    await pool.query(`update guest_sessions set last_seen_at=now(),metadata=metadata || $1::jsonb where id=$2`, [JSON.stringify(metadata), existing.rows[0].id]);
    return existing.rows[0].id;
  }
  const id = crypto.randomUUID();
  await pool.query('insert into guest_sessions(id,restaurant_id,terminal_id,source,table_id,table_number,metadata) values($1,$2,$3,$4,$5,$6,$7)', [id, iikoOrganizationId, terminalId, source, table?.table_id ?? null, table?.table_number ?? '', JSON.stringify(metadata)]);
  await publishEvent('guest_session_started', 'guest_session', id, { source, tableNumber: table?.table_number ?? '' });
  return id;
};
const closeGuestSessionIfIdle = async (sessionId, reason = 'completed') => {
  if (!sessionId) return;
  const active = await pool.query(`select
    exists(select 1 from customer_orders where guest_session_id=$1 and completed_at is null) as has_orders,
    exists(select 1 from service_requests where guest_session_id=$1 and status in ('new','accepted','in_progress')) as has_requests`, [sessionId]);
  if (active.rows[0]?.has_orders || active.rows[0]?.has_requests) return;
  const closed = await pool.query(`update guest_sessions set status='closed',ended_at=now(),last_seen_at=now(),metadata=metadata || $1::jsonb where id=$2 and status='active' returning id`, [JSON.stringify({ closeReason: reason }), sessionId]);
  if (closed.rowCount) await publishEvent('guest_session_closed', 'guest_session', sessionId, { reason });
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
  const before = await pool.query('select status_step,order_status,item_statuses,creation_status from iiko_orders where order_id=$1', [snapshot.orderId]);
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
  const customerOrder = await pool.query('update customer_orders set status_step=$1,iiko_pos_id=coalesce($2,iiko_pos_id),updated_at=now() where iiko_order_id=$3 returning order_number,guest_session_id', [snapshot.statusStep, snapshot.posId, snapshot.orderId]);
  const previous = before.rows[0];
  const changed = !previous || Number(previous.status_step) !== snapshot.statusStep || previous.order_status !== snapshot.orderStatus || previous.creation_status !== snapshot.creationStatus || JSON.stringify(previous.item_statuses ?? []) !== JSON.stringify(snapshot.itemStatuses);
  if (changed) {
    const orderNumber = customerOrder.rows[0]?.order_number ?? snapshot.externalNumber ?? null;
    await pool.query(`insert into order_status_history(restaurant_id,order_number,iiko_order_id,status_step,order_status,item_statuses,source) values($1,$2,$3,$4,$5,$6,$7)`, [organizationId, orderNumber, snapshot.orderId, snapshot.statusStep, snapshot.orderStatus, JSON.stringify(snapshot.itemStatuses), webhook ? 'webhook' : 'poll']);
    if (orderNumber) await publishEvent('order_status_changed', 'order', orderNumber, { statusStep: snapshot.statusStep, orderStatus: snapshot.orderStatus, itemStatuses: snapshot.itemStatuses, source: webhook ? 'webhook' : 'poll' }, organizationId);
  }
  return result.rows[0];
};
let iikoAccessToken = '';
let iikoAccessTokenExpiresAt = 0;
let iikoRetryAfter = 0;
const iikoDiscoverySessions = new Map();
const cleanIikoDiscoverySessions = () => {
  const now = Date.now();
  for (const [id, session] of iikoDiscoverySessions) if (session.expiresAt <= now) iikoDiscoverySessions.delete(id);
};
const discoverIikoCredentials = async (config, userId) => {
  const auth = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
  const authBody = await auth.json().catch(() => ({}));
  if (!auth.ok || !authBody.token) throw Object.assign(new Error(authBody.errorDescription ?? 'iiko не принял данные авторизации'), { status: 409 });
  const organizationsResponse = await fetch(`${config.apiBase}/api/1/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authBody.token}` }, body: JSON.stringify({ returnAdditionalInfo: false, includeDisabled: false }) });
  const organizationsBody = await organizationsResponse.json().catch(() => ({}));
  if (!organizationsResponse.ok) throw Object.assign(new Error(organizationsBody.errorDescription ?? 'Не удалось получить рестораны iiko'), { status: 409 });
  const organizations = arrayValue(organizationsBody.organizations).map((item) => ({ id: String(item.id), name: String(item.name ?? item.code ?? 'Ресторан'), code: String(item.code ?? '') }));
  if (!organizations.length) throw Object.assign(new Error('Для этого API-логина не найдено доступных ресторанов'), { status: 409 });
  cleanIikoDiscoverySessions();
  const discoveryToken = crypto.randomBytes(32).toString('base64url');
  const sessionConfig = { ...config, webhookToken: String(config.webhookToken ?? '') || crypto.randomBytes(32).toString('hex') };
  iikoDiscoverySessions.set(discoveryToken, { config: sessionConfig, accessToken: authBody.token, organizations, userId: String(userId ?? ''), expiresAt: Date.now() + 5 * 60_000 });
  return { discoveryToken, organizations, recommendedOrganizationId: organizations.some((item) => item.id === config.organizationId) ? config.organizationId : organizations.length === 1 ? organizations[0].id : '' };
};
const requireIikoDiscoverySession = (token, admin) => {
  cleanIikoDiscoverySessions();
  const session = iikoDiscoverySessions.get(String(token ?? ''));
  if (!session || session.expiresAt <= Date.now() || session.userId !== String(admin.userId ?? '')) throw Object.assign(new Error('Время подключения истекло. Получите список ресторанов заново.'), { status: 401 });
  return session;
};
const iikoDiscoveryCall = async (session, path, body) => {
  const result = await fetch(`${session.config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(payload.errorDescription ?? `Не удалось получить настройки iiko: ${path}`), { status: 409 });
  return payload;
};
const discoverIikoRestaurantOptions = async (session, organizationId) => {
  const id = String(organizationId ?? '');
  const [groupsPayload, menusPayload, typesPayload] = await Promise.all([
    iikoDiscoveryCall(session, '/api/1/terminal_groups', { organizationIds: [id] }),
    iikoDiscoveryCall(session, '/api/2/menu', { organizationIds: [id] }),
    iikoDiscoveryCall(session, '/api/1/deliveries/order_types', { organizationIds: [id] }),
  ]);
  const terminalGroups = arrayValue(groupsPayload.terminalGroups).filter((group) => String(group.organizationId) === id).flatMap((group) => arrayValue(group.items)).map((item) => ({ id: String(item.id), name: String(item.name ?? 'Кассовая группа'), address: String(item.address ?? '') }));
  const externalMenus = arrayValue(menusPayload.externalMenus).map((item) => ({ id: String(item.id), name: String(item.name ?? 'Внешнее меню') }));
  const orderTypes = arrayValue(typesPayload.orderTypes).filter((group) => String(group.organizationId) === id).flatMap((group) => arrayValue(group.items)).filter((item) => !item.isDeleted && item.orderServiceType === 'Common').map((item) => ({ id: String(item.id), name: String(item.name ?? 'Обычный заказ') }));
  if (!terminalGroups.length) throw Object.assign(new Error('У выбранного ресторана нет доступной кассовой группы'), { status: 409 });
  if (!externalMenus.length) throw Object.assign(new Error('У выбранного ресторана нет внешнего меню'), { status: 409 });
  if (!orderTypes.length) throw Object.assign(new Error('У выбранного ресторана нет типа заказа для обслуживания в зале'), { status: 409 });
  const current = session.config;
  return {
    terminalGroups, externalMenus, orderTypes,
    recommendedTerminalGroupId: current.organizationId === id && terminalGroups.some((item) => item.id === current.terminalGroupId) ? current.terminalGroupId : terminalGroups.length === 1 ? terminalGroups[0].id : '',
    recommendedExternalMenuId: current.organizationId === id && externalMenus.some((item) => item.id === current.externalMenuId) ? current.externalMenuId : externalMenus.length === 1 ? externalMenus[0].id : '',
    orderTypeId: orderTypes[0].id,
  };
};
const managedIikoWebhookFilter = {
  tableOrderFilter: {
    orderStatuses: ['New', 'Bill', 'Closed', 'Deleted'],
    itemStatuses: ['Added', 'PrintedNotCooking', 'CookingStarted', 'CookingCompleted', 'Served'],
    errors: true,
  },
  stopListUpdateFilter: { updates: true },
};
const authorizeIikoConfig = async (config) => {
  const result = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok || !payload.token) throw Object.assign(new Error(payload.errorDescription ?? 'iiko не принял данные авторизации для настройки webhook'), { status: 409 });
  return payload.token;
};
const iikoConfigCall = async (config, token, path, body) => {
  const result = await fetch(`${config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(payload.errorDescription ?? `iiko не принял настройку webhook: ${path}`), { status: 409, correlationId: payload.correlationId ?? null });
  return payload;
};
const normalizedWebhookSettings = (settings) => ({
  webHooksUri: String(settings?.webHooksUri ?? ''),
  authToken: String(settings?.authToken ?? ''),
  webHooksFilter: settings?.webHooksFilter ?? {},
});
const sameStringList = (left, right) => Array.isArray(left) && left.length === right.length && right.every((value) => left.includes(value));
const webhookRegistrationMatches = (settings, config) => {
  const current = normalizedWebhookSettings(settings);
  const table = current.webHooksFilter?.tableOrderFilter;
  return current.webHooksUri === publicIikoWebhookUrl
    && current.authToken === config.webhookToken
    && sameStringList(table?.orderStatuses, managedIikoWebhookFilter.tableOrderFilter.orderStatuses)
    && sameStringList(table?.itemStatuses, managedIikoWebhookFilter.tableOrderFilter.itemStatuses)
    && table?.errors === true
    && current.webHooksFilter?.stopListUpdateFilter?.updates === true;
};
const updateIikoWebhookSettings = (config, token, settings) => iikoConfigCall(config, token, '/api/1/webhooks/update_settings', { organizationId: config.organizationId, ...normalizedWebhookSettings(settings) });
const ensureIikoWebhookRegistration = async (config) => {
  const token = await authorizeIikoConfig(config);
  const previous = normalizedWebhookSettings(await iikoConfigCall(config, token, '/api/1/webhooks/settings', { organizationId: config.organizationId }));
  if (webhookRegistrationMatches(previous, config)) return { updated: false, verified: true, previous: null };
  const desired = { webHooksUri: publicIikoWebhookUrl, authToken: config.webhookToken, webHooksFilter: { ...previous.webHooksFilter, ...managedIikoWebhookFilter } };
  let changed = false;
  try {
    await updateIikoWebhookSettings(config, token, desired); changed = true;
    let verified = null;
    for (const delayMs of [0, 400, 1_000, 2_000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      verified = await iikoConfigCall(config, token, '/api/1/webhooks/settings', { organizationId: config.organizationId });
      if (webhookRegistrationMatches(verified, config)) break;
    }
    if (!webhookRegistrationMatches(verified, config)) throw Object.assign(new Error('iiko сохранила webhook не полностью'), { status: 409 });
    return { updated: true, verified: true, previous, token };
  } catch (error) {
    if (changed) await updateIikoWebhookSettings(config, token, previous).catch((restoreError) => console.error('Unable to restore previous iiko webhook settings:', restoreError));
    throw error;
  }
};
const restoreIikoWebhookRegistration = async (config, registration) => {
  if (!registration?.updated || !registration.previous || !registration.token) return;
  await updateIikoWebhookSettings(config, registration.token, registration.previous);
};
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
  if (!result.ok) {
    const correlationId = String(payload.correlationId ?? result.headers.get('x-correlation-id') ?? '');
    console.error('iiko request failed', {
      path,
      status: result.status,
      correlationId: correlationId || undefined,
      error: payload.errorDescription ?? payload.error ?? payload.message ?? 'Unknown iiko error',
    });
    const message = path === '/api/1/order/create'
      ? `iiko не принял заказ${correlationId ? `. Код обращения: ${correlationId}` : ''}`
      : (payload.errorDescription ?? `iiko request failed: ${path}`);
    throw Object.assign(new Error(message), { status: 502, correlationId });
  }
  return payload;
};
const getIikoAccessToken = async () => {
  if (iikoAccessToken && iikoAccessTokenExpiresAt > Date.now()) return iikoAccessToken;
  if (!iikoAppId || !iikoApiLogin || !iikoClientSecret) throw Object.assign(new Error('iiko credentials are not configured'), { status: 503 });
  const result = await fetch(`${iikoApiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: iikoAppId, apiLogin: iikoApiLogin, clientSecret: iikoClientSecret }) });
  const body = await result.json().catch(() => ({}));
  if (!result.ok || !body.token) throw Object.assign(new Error(body.errorDescription ?? 'iiko authorization failed'), { status: 502 });
  iikoAccessToken = body.token;
  iikoAccessTokenExpiresAt = Date.now() + 14 * 60 * 1000;
  return iikoAccessToken;
};
const testIikoConnection = async (config) => {
  const started = Date.now();
  const auth = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
  const authBody = await auth.json().catch(() => ({}));
  if (!auth.ok || !authBody.token) throw Object.assign(new Error(authBody.errorDescription ?? 'iiko не принял данные авторизации'), { status: 409 });
  const call = async (path, body) => {
    const result = await fetch(`${config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authBody.token}` }, body: JSON.stringify(body) });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) throw Object.assign(new Error(payload.errorDescription ?? `Проверка iiko не пройдена: ${path}`), { status: 409 });
    return payload;
  };
  const organizations = await call('/api/1/organizations', { organizationIds: [config.organizationId], returnAdditionalInfo: false, includeDisabled: false });
  if (!arrayValue(organizations.organizations).some((item) => String(item.id) === config.organizationId)) throw Object.assign(new Error('У API-логина нет доступа к выбранной организации'), { status: 409 });
  const menu = await call('/api/2/menu/by_id', { organizationIds: [config.organizationId], externalMenuId: config.externalMenuId, version: 2, language: 'ru', asyncMode: false });
  const menuItems = arrayValue(menu.itemCategories).reduce((sum, category) => sum + arrayValue(category?.items).length, 0);
  if (!menuItems) throw Object.assign(new Error('Выбранное внешнее меню не содержит блюд'), { status: 409 });
  const sections = await call('/api/1/reserve/available_restaurant_sections', { organizationIds: [config.organizationId], terminalGroupIds: [config.terminalGroupId], returnSchema: true });
  const tables = arrayValue(sections.restaurantSections).reduce((sum, section) => sum + arrayValue(section?.tables).length, 0);
  if (!tables) throw Object.assign(new Error('В выбранной терминальной группе не найдены столы'), { status: 409 });
  const orderTypes = await call('/api/1/deliveries/order_types', { organizationIds: [config.organizationId] });
  const orderTypeRows = arrayValue(orderTypes.orderTypes).flatMap((item) => arrayValue(item?.items).length ? item.items : [item]);
  if (!orderTypeRows.some((item) => String(item?.id) === config.orderTypeId)) throw Object.assign(new Error('Выбранный тип заказа недоступен организации'), { status: 409 });
  await call('/api/1/stop_lists', { organizationIds: [config.organizationId], terminalGroupsIds: [config.terminalGroupId], returnSize: true });
  return { organizationName: arrayValue(organizations.organizations).find((item) => String(item.id) === config.organizationId)?.name ?? '', menuItems, tables, orderTypes: orderTypeRows.length, responseMs: Date.now() - started };
};
const defaultItemSize = (item) => arrayValue(item?.itemSizes).find((size) => size?.isDefault) ?? arrayValue(item?.itemSizes)[0] ?? {};
const iikoPrice = (size) => Number(arrayValue(size?.prices).find((price) => String(price?.organizationId) === iikoOrganizationId)?.price ?? arrayValue(size?.prices)[0]?.price ?? 0);
const nutritionHasValues = (nutrition) => ['energy', 'calories', 'proteins', 'protein', 'fats', 'fat', 'carbs', 'carbohydrates'].some((key) => Number(nutrition?.[key] ?? 0) > 0);
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
    const sku = String(item?.sku ?? size?.sku ?? '').trim() || null;
    rows.push([String(item.itemId), sku, String(category?.id ?? ''), String(category?.name ?? 'Без категории'), String(item?.name ?? ''), item?.description ?? null, iikoPrice(size), Number(size?.portionWeightGrams ?? 0), String(size?.measureUnitType ?? ''), JSON.stringify(size?.nutritionPerHundredGrams ?? size?.nutritions?.[0] ?? null), size?.buttonImageUrl ?? null, JSON.stringify(size?.itemModifierGroups ?? []), Boolean(item?.isHidden || size?.isHidden), sortOrder++, Number(menu?.revision ?? 0), JSON.stringify({ item, size })]);
  }
  if (!rows.length) throw Object.assign(new Error('iiko вернул пустое внешнее меню; сохранён предыдущий снимок'), { status: 502 });
  const activeRows = rows.filter((row) => !row[12]);
  const withoutSku = activeRows.filter((row) => !row[1]);
  const skuCounts = new Map();
  activeRows.forEach((row) => { if (row[1]) skuCounts.set(row[1], (skuCounts.get(row[1]) ?? 0) + 1); });
  const duplicateSkus = [...skuCounts].filter(([, count]) => count > 1).map(([sku]) => sku);
  if (withoutSku.length || duplicateSkus.length) {
    throw Object.assign(new Error(`Сезонное меню не опубликовано: ${withoutSku.length} блюд без SKU, ${duplicateSkus.length} повторяющихся SKU`), { status: 409 });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const row of rows) await client.query(`insert into iiko_menu_items(product_id,sku,category_id,category_name,name,description,price_rub,portion_weight_grams,measure_unit,nutrition,image_url,modifier_groups,is_hidden,sort_order,revision,raw_payload)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      on conflict(product_id) do update set sku=excluded.sku,category_id=excluded.category_id,category_name=excluded.category_name,name=excluded.name,description=excluded.description,price_rub=excluded.price_rub,portion_weight_grams=excluded.portion_weight_grams,measure_unit=excluded.measure_unit,nutrition=excluded.nutrition,image_url=excluded.image_url,modifier_groups=excluded.modifier_groups,is_hidden=excluded.is_hidden,sort_order=excluded.sort_order,revision=excluded.revision,raw_payload=excluded.raw_payload,updated_at=now()`, row);
    // An external menu is a complete snapshot. Hide items that disappeared from
    // the current snapshot so switching menu versions cannot leave stale dishes
    // visible in the kiosk. Never mass-hide on an unexpectedly empty response.
    if (rows.length) {
      await client.query(
        'update iiko_menu_items set is_hidden=true,updated_at=now() where not (product_id = any($1::text[]))',
        [rows.map((row) => row[0])],
      );
    }
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
const saveIikoStopLists = async (terminalGroupStopLists, organizationId = iikoOrganizationId, requestedTerminalGroupIds = []) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const targetTerminalGroupIds = new Set([
      ...requestedTerminalGroupIds.map(String),
      ...terminalGroupStopLists.map((group) => String(group?.terminalGroupId ?? '')).filter(Boolean),
    ]);
    // The response is a complete snapshot for every requested terminal group.
    // Clear its previous cache even when iiko returns an empty list; otherwise a
    // removed stop-list item remains unavailable forever in the kiosk.
    for (const terminalGroupId of targetTerminalGroupIds) {
      await client.query('delete from iiko_stop_list_items where organization_id=$1 and terminal_group_id=$2', [organizationId, terminalGroupId]);
    }
    for (const group of terminalGroupStopLists) {
      const terminalGroupId = String(group?.terminalGroupId ?? '');
      if (!terminalGroupId) continue;
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
  const requestedTerminalGroupIds = terminalGroupIds.length
    ? terminalGroupIds.map(String)
    : (iikoTerminalGroupId ? [iikoTerminalGroupId] : []);
  const token = await getIikoAccessToken();
  const result = await fetch(`${iikoApiBase}/api/1/stop_lists`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationIds: [iikoOrganizationId], ...(requestedTerminalGroupIds.length ? { terminalGroupsIds: requestedTerminalGroupIds } : {}), returnSize: true }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw Object.assign(new Error(body.errorDescription ?? 'Unable to get iiko stop list'), { status: 502 });
  const groups = arrayValue(body.terminalGroupStopLists).flatMap((wrapper) => arrayValue(wrapper?.items));
  await saveIikoStopLists(groups, iikoOrganizationId, requestedTerminalGroupIds);
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
  const [localProducts, iikoProducts, banners, terminal, selection, settings] = await Promise.all([
    pool.query('select * from products order by category, sort_order, name'),
    pool.query(`select m.*, p.image as override_image,
      coalesce((select jsonb_agg((select pm.product_id from iiko_menu_items pm where pm.sku=pair.sku and not pm.is_hidden order by pm.updated_at desc limit 1) order by pair.ordinality) from jsonb_array_elements_text(p.pairs_with_skus) with ordinality pair(sku,ordinality)),'[]'::jsonb) as override_pairs_with,
      p.badge as override_badge, p.image_position as override_image_position,
      exists(select 1 from iiko_stop_list_items s where s.organization_id=$1 and s.terminal_group_id=$2 and s.product_id=m.product_id and s.balance <= 0) as stopped
      from iiko_menu_items m left join iiko_product_presentations p on p.restaurant_id=$1 and p.sku=m.sku where not m.is_hidden order by m.category_name,m.sort_order,m.name`, [iikoOrganizationId, iikoTerminalGroupId]),
    pool.query(`select b.*,coalesce((select m.product_id from iiko_menu_items m where m.sku=b.product_sku and not m.is_hidden order by m.updated_at desc limit 1),b.product_id) as product_id from banners b where active=true
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at > now())
      and (impression_limit is null or impressions < impression_limit)
      order by sort_order,id`),
    pool.query('insert into terminals(id) values ($1) on conflict (id) do update set last_seen_at = now() returning *', [terminalId]),
    pool.query('select * from terminal_table_selections where terminal_id=$1', [terminalId]),
    pool.query('select key, value from app_settings'),
  ]);
  const fixedTable = String(terminal.rows[0].table_number ?? '').trim();
  const chosen = selection.rows[0];
  const effectiveTable = fixedTable || chosen?.table_number || '';
  const products = iikoProducts.rowCount ? iikoProducts.rows.map((item) => ({
    id: item.product_id, sku: item.sku ?? '', name: item.name, category: item.category_name, price_rub: Number(item.price_rub), portion: item.portion_weight_grams ? String(Math.round(Number(item.portion_weight_grams))) : '', unit: item.measure_unit === 'GRAM' ? 'г' : item.measure_unit,
    description: item.description, kbju: nutritionHasValues(item.nutrition) ? { calories: String(item.nutrition.energy ?? item.nutrition.calories ?? 0), protein: String(item.nutrition.proteins ?? item.nutrition.protein ?? 0), fat: String(item.nutrition.fats ?? item.nutrition.fat ?? 0), carbs: String(item.nutrition.carbs ?? item.nutrition.carbohydrates ?? 0) } : null,
    image: item.override_image || item.image_url || '', source_url: '', sauce_options: [], addon_options: [], flavor_options: [], size_option: null,
    pairs_with: item.override_pairs_with ?? [], recommendations_note: null, is_available: !item.stopped, badge: item.stopped ? 'СТОП-ЛИСТ' : (item.override_badge ?? ''), image_position: item.override_image_position ?? 'center', allergens: '', spicy: 'none', sort_order: item.sort_order, modifier_groups: publicModifierGroups(item.modifier_groups), iiko: true,
  })) : localProducts.rows;
  const orders = await pool.query('select order_number, items, total, status_step, table_number, created_at from customer_orders where terminal_id = $1 and completed_at is null and created_at > now() - interval \'4 hours\' order by created_at desc', [terminalId]);
  return { products, banners: banners.rows, terminal: { ...terminal.rows[0], table_number: effectiveTable, table_source: fixedTable ? 'admin' : (chosen ? 'guest' : null), table_id: fixedTable ? null : (chosen?.table_id ?? null) }, orders: orders.rows, settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])) };
};

const serviceTypes = new Set(['waiter', 'cutlery', 'bill', 'help']);
const servicePushText = {
  waiter: 'Позвали официанта',
  cutlery: 'Попросили приборы за стол',
  bill: 'Попросили счёт',
  help: 'Нужна помощь за столом',
};
const arrayValue = (value) => Array.isArray(value) ? value : [];
const sauceName = (value) => /^Соус «(.+)»$/u.exec(String(value ?? ''))?.[1] ?? '';

const normalizeOrder = async (input) => {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const ids = [...new Set(input.items.map((line) => String(line?.productId ?? '')).filter(Boolean))];
  if (!ids.length || ids.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const result = await pool.query('select id, name, price_rub, is_available, sauce_options, sauce_addon_price_rub, addon_options, flavor_options from products where id = any($1::text[])', [ids]);
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
    return { key: ['product', product.id, addon, flavor].filter(Boolean).join('|'), productId: product.id, kind: 'product', customName: product.name, customPrice: Number(product.price_rub), ...(addon ? { addon } : {}), ...(flavor ? { flavor } : {}), quantity };
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
    for (const group of arrayValue(product.modifier_groups)) {
      for (const modifier of arrayValue(group?.items)) {
        if (!modifier?.itemId) continue;
        allowedModifiers.set(String(modifier.itemId), {
          item: modifier,
          productGroupId: group?.itemGroupId ? String(group.itemGroupId) : '',
        });
      }
    }
    const modifiers = arrayValue(line.modifiers).map((modifier) => {
      const productId = String(modifier?.productId ?? '');
      const binding = allowedModifiers.get(productId);
      const modifierItem = binding?.item;
      const modifierAmount = Number(modifier?.amount ?? 1);
      if (!modifierItem || !Number.isInteger(modifierAmount) || modifierAmount < 1 || modifierAmount > 20) throw Object.assign(new Error('Некорректная добавка'), { status: 400 });
      return {
        productId,
        amount: modifierAmount,
        name: String(modifierItem.name ?? ''),
        price: iikoPrice(modifierItem),
        ...(binding.productGroupId ? { productGroupId: binding.productGroupId } : {}),
      };
    });
    total += (Number(product.price_rub) + modifiers.reduce((sum, modifier) => sum + modifier.price * modifier.amount, 0)) * amount;
    items.push({ key: `product|${product.product_id}|${modifiers.map((modifier) => modifier.productId).join(',')}`, productId: product.product_id, kind: 'product', customName: product.name, customPrice: Number(product.price_rub), quantity: amount, ...(modifiers.length ? { modifiers } : {}) });
  }
  if (!items.length) throw Object.assign(new Error('В заказе нет блюд'), { status: 400 });
  return {
    items,
    total: Math.round(total),
    promoCode: '',
    iikoItems: items.map((line) => ({
      type: 'Product',
      productId: line.productId,
      amount: line.quantity,
      price: Number(products.get(line.productId)?.price_rub ?? 0),
      ...(line.modifiers?.length ? {
        modifiers: line.modifiers.map((modifier) => ({
          productId: modifier.productId,
          amount: modifier.amount,
          ...(modifier.productGroupId ? { productGroupId: modifier.productGroupId } : {}),
        })),
      } : {}),
    })),
  };
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
const createIikoOrder = async ({ id = crypto.randomUUID(), number, table, items, comment }) => {
  if (!iikoTerminalGroupId || !iikoOrderTypeId) throw Object.assign(new Error('Интеграция iiko ещё не настроена на сервере'), { status: 503 });
  const payload = await iikoRequest('/api/1/order/create', {
    organizationId: iikoOrganizationId,
    terminalGroupId: iikoTerminalGroupId,
    order: {
      id,
      externalNumber: number,
      tableIds: [table.table_id],
      guests: { count: 1 },
      ...(iikoExternalMenuId ? { menuId: iikoExternalMenuId } : {}),
      orderTypeId: iikoOrderTypeId,
      sourceKey: iikoOrderSourceKey,
      items,
      comment: String(comment ?? '').slice(0, 1000),
    },
    createOrderSettings: {
      servicePrint: true,
      transportToFrontTimeout: 30,
      checkStopList: true,
    },
  });
  if (payload?.errorInfo) throw Object.assign(new Error(payload.errorInfo?.message ?? 'iiko не принял заказ'), { status: 409 });
  return { id, response: payload };
};

const waitForIikoCreation = async (orderId, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query('select creation_status,error_info from iiko_orders where order_id=$1', [orderId]);
    const status = String(result.rows[0]?.creation_status ?? '');
    if (status === 'Success' || status === 'Error') return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
};

const readableIikoOrderError = (value) => {
  let error = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof error !== 'string') break;
    try { error = JSON.parse(error); } catch { return error.slice(0, 240); }
  }
  if (!error || typeof error !== 'object') return 'iiko не смог создать заказ';
  const nested = error.description ?? error.message;
  if (typeof nested === 'string') {
    try {
      const parsed = JSON.parse(nested);
      return String(parsed.description ?? parsed.message ?? 'iiko не смог создать заказ').slice(0, 240);
    } catch { return nested.slice(0, 240); }
  }
  return 'iiko не смог создать заказ';
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
  let requestPath = '';
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const path = url.pathname;
    requestPath = path;
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS' && path.startsWith('/api/v1/')) {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' });
      return response.end();
    }
    if (request.method === 'GET' && path === '/api/v1/health') return json(response, 200, { ok: true, service: 'brooklynbowl-kiosk-api', time: new Date().toISOString() });
    if (request.method === 'GET' && path === '/api/v1/health/ready') {
      const database = await pool.query('select now() as now');
      const cache = await pool.query(`select max(updated_at) as menu_updated_at,count(*) filter(where not is_hidden)::int as active_products,(select count(*)::int from products) as local_products from iiko_menu_items`);
      const ready = Number(cache.rows[0].active_products) > 0 || Number(cache.rows[0].local_products) > 0;
      return json(response, ready ? 200 : 503, { ok: ready, database: database.rows[0].now, menu: cache.rows[0], iikoConfigured: Boolean(iikoConnectionMetadata), syncRunning: backgroundSyncRunning, iikoBackoffUntil: iikoRetryAfter ? new Date(iikoRetryAfter).toISOString() : null });
    }
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
      requireAdmin(request);
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
    if (request.method === 'POST' && path.startsWith('/api/v1/banners/') && path.endsWith('/impression')) {
      const id = Number(path.slice('/api/v1/banners/'.length, -'/impression'.length));
      const body = await readBody(request);
      const terminalId = String(body.terminal_id ?? '');
      if (!Number.isInteger(id) || !/^[a-zA-Z0-9_-]{8,80}$/.test(terminalId)) return json(response, 400, { error: 'Некорректный показ баннера' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const banner = await client.query(`select *, active=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now()) and (impression_limit is null or impressions<impression_limit) as eligible from banners where id=$1 for update`, [id]);
        if (!banner.rowCount) { await client.query('rollback'); return json(response, 404, { error: 'Баннер не найден' }); }
        const row = banner.rows[0];
        if (!row.eligible) {
          await client.query('commit');
          return json(response, 200, { counted: false, exhausted: Boolean(row.impression_limit && row.impressions >= row.impression_limit), impressions: Number(row.impressions) });
        }
        const exposure = await client.query('insert into banner_impressions(banner_id,terminal_id,exposure_bucket) values($1,$2,$3) on conflict do nothing returning id', [id, terminalId, Math.floor(Date.now() / 5_000)]);
        let impressions = Number(row.impressions);
        if (exposure.rowCount) {
          const updated = await client.query('update banners set impressions=impressions+1,updated_at=now() where id=$1 returning impressions,impression_limit', [id]);
          impressions = Number(updated.rows[0].impressions);
        }
        await client.query('commit');
        return json(response, 200, { counted: Boolean(exposure.rowCount), exhausted: Boolean(row.impression_limit && impressions >= Number(row.impression_limit)), impressions });
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
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
      const { password, scope, username } = await readBody(request); const requestedScope = scope === 'terminal' ? 'terminal' : 'restaurant';
      const attemptKey = authAttemptKey(request, `admin:${requestedScope}`);
      await assertAuthAllowed(attemptKey);
      let role = requestedScope === 'terminal' ? 'terminal_manager' : 'administrator'; let userId = null; let valid = false;
      if (requestedScope === 'restaurant' && String(username ?? '').trim()) {
        const account = await pool.query('select id,role,password_hash from admin_users where restaurant_id=$1 and lower(username)=lower($2) and is_active=true', [iikoOrganizationId, String(username).trim()]);
        valid = Boolean(account.rowCount && password && passwordMatches(String(password), account.rows[0].password_hash));
        if (valid) { role = account.rows[0].role; userId = account.rows[0].id; }
      } else {
        const expectedHash = requestedScope === 'terminal' ? terminalAdminPasswordHash : adminPasswordHash;
        valid = Boolean(password && sha256(password) === expectedHash);
      }
      if (!valid) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный логин или пароль' }); }
      await clearAuthFailures(attemptKey);
      return json(response, 200, { token: sign({ admin: true, scope: requestedScope, role, userId, exp: Date.now() + 8 * 60 * 60 * 1000 }), scope: requestedScope, role });
    }
    if (request.method === 'POST' && path === '/api/v1/waiter/login') {
      const body = await readBody(request); const pin = String(body.pin ?? '');
      const attemptKey = authAttemptKey(request, 'waiter');
      await assertAuthAllowed(attemptKey);
      const waiterCandidates = await pool.query('select id,display_name,pin_hash from waiter_profiles where restaurant_id=$1 and is_active=true', [iikoOrganizationId]);
      const waiter = waiterCandidates.rows.find((profile) => passwordMatches(pin, profile.pin_hash));
      if (!waiter) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный PIN-код' }); }
      await clearAuthFailures(attemptKey);
      return json(response, 200, { token: sign({ waiterId: waiter.id, role: 'waiter', exp: Date.now() + 12 * 60 * 60 * 1000 }), waiter: { id: waiter.id, name: waiter.display_name } });
    }
    if (request.method === 'GET' && path === '/api/v1/waiter/queue') {
      const waiter = requireWaiter(request);
      const [requests, orders] = await Promise.all([
        pool.query(`select id,table_number,request_type,status,created_at,accepted_by,accepted_at from service_requests where restaurant_id=$1 and status in ('new','accepted','in_progress') and (accepted_by is null or accepted_by=$2) and created_at > now()-interval '8 hours' order by created_at desc`, [iikoOrganizationId, waiter.waiterId]),
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
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/complete')) {
      const waiter = requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/complete'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный вызов' });
      const result = await pool.query(`update service_requests set status='completed',handled_at=now(),completed_at=now(),completed_by=$1 where id=$2 and restaurant_id=$3 and status in ('accepted','in_progress') and accepted_by=$1 returning *`, [waiter.waiterId, id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 409, { error: 'Вызов не найден или назначен другому официанту' });
      await publishEvent('waiter_request_completed', 'service_request', String(id), { waiterId: waiter.waiterId, tableNumber: result.rows[0].table_number });
      await closeGuestSessionIfIdle(result.rows[0].guest_session_id, 'service_completed');
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/start')) {
      const waiter = requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/start'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный вызов' });
      const result = await pool.query(`update service_requests set status='in_progress' where id=$1 and restaurant_id=$2 and status='accepted' and accepted_by=$3 returning *`, [id, iikoOrganizationId, waiter.waiterId]);
      if (!result.rowCount) return json(response, 409, { error: 'Вызов не найден или назначен другому официанту' });
      await publishEvent('waiter_request_in_progress', 'service_request', String(id), { waiterId: waiter.waiterId, tableNumber: result.rows[0].table_number });
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/orders') {
      if (iikoConfigSwitching) return json(response, 503, { error: 'Настройки iiko обновляются. Повторите отправку через несколько секунд.' });
      const body = await readBody(request);
      if (!body.terminal_id) return json(response, 400, { error: 'Некорректный заказ' });
      enforceRequestRate(`order:${requestIp(request)}:${String(body.terminal_id)}`, 10, 5 * 60_000);
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно не принимает заказы' });
      const useIiko = (await pool.query('select count(*)::int as count from iiko_menu_items')).rows[0].count > 0;
      const order = useIiko ? await normalizeIikoOrder(body) : await normalizeOrder(body);
      const table = useIiko ? await effectiveTableForTerminal(terminal.rows[0]) : { table_number: terminal.rows[0].table_number };
      const clientRequestId = String(body.client_request_id ?? '').trim();
      if (clientRequestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) return json(response, 400, { error: 'Некорректный идентификатор отправки' });
      const requestHash = sha256(JSON.stringify({ terminalId: body.terminal_id, table: table.table_number, items: order.items, comment: String(body.comment ?? ''), source: body.source === 'qr' ? 'qr' : 'tablet' }));
      let number = clientRequestId ? `B-${sha256(`${iikoOrganizationId}:${clientRequestId}`).slice(0, 8).toUpperCase()}` : '';
      if (clientRequestId) {
        const existing = await pool.query('select order_number,items,total,status_step,table_number,created_at from customer_orders where restaurant_id=$1 and client_request_id=$2', [iikoOrganizationId, clientRequestId]);
        if (existing.rowCount) return json(response, 200, existing.rows[0]);
        const claimed = await pool.query(`insert into order_requests(restaurant_id,client_request_id,terminal_id,request_hash,order_number) values($1,$2,$3,$4,$5) on conflict do nothing returning *`, [iikoOrganizationId, clientRequestId, String(body.terminal_id), requestHash, number]);
        if (!claimed.rowCount) {
          const prior = await pool.query('select * from order_requests where restaurant_id=$1 and client_request_id=$2', [iikoOrganizationId, clientRequestId]);
          const row = prior.rows[0];
          if (!row || row.request_hash !== requestHash) return json(response, 409, { error: 'Этот идентификатор уже использован для другого состава заказа' });
          if (row.status === 'success') {
            const completed = await pool.query('select order_number,items,total,status_step,table_number,created_at from customer_orders where restaurant_id=$1 and client_request_id=$2', [iikoOrganizationId, clientRequestId]);
            if (completed.rowCount) return json(response, 200, completed.rows[0]);
          }
          const stillProcessing = row.status === 'processing' && new Date(row.updated_at).getTime() > Date.now() - 90_000;
          if (stillProcessing) return json(response, 409, { error: 'Заказ уже отправляется. Подождите несколько секунд и повторите проверку.' });
          await pool.query(`update order_requests set status='processing',error_message=null,updated_at=now() where restaurant_id=$1 and client_request_id=$2`, [iikoOrganizationId, clientRequestId]);
          number = row.order_number || number;
        }
      }
      const sessionId = await getOrCreateGuestSession({ terminalId: String(body.terminal_id), source: body.source === 'qr' ? 'qr' : 'tablet', table, metadata: { clientRequestId: clientRequestId || null } });
      let saved;
      let submittedIikoOrderId = null;
      let initialIikoCreationStatus = '';
      try {
        for (let attempt = 0; attempt < (clientRequestId ? 1 : 5); attempt += 1) {
          if (!number) number = `B-${crypto.randomInt(1000, 10000)}`;
          if (useIiko) {
            const created = await createIikoOrder({ id: clientRequestId ? deterministicUuid(`${iikoOrganizationId}:${clientRequestId}`) : undefined, number, table, items: order.iikoItems, comment: body.comment });
            submittedIikoOrderId = created.id;
            initialIikoCreationStatus = String(created.response?.creationStatus ?? '');
          }
          try {
            saved = await pool.query('insert into customer_orders(order_number,terminal_id,table_number,items,total,comment,promo_code,iiko_order_id,restaurant_id,guest_session_id,source,client_request_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning order_number, items, total, status_step, table_number, created_at', [number, body.terminal_id, table.table_number, JSON.stringify(order.items), order.total, String(body.comment ?? '').slice(0, 1000), order.promoCode, submittedIikoOrderId, iikoOrganizationId, sessionId, body.source === 'qr' ? 'qr' : 'tablet', clientRequestId || null]);
            break;
          } catch (error) {
            if (error.code !== '23505' || clientRequestId || useIiko) throw error;
            number = '';
          }
        }
        if (!saved) throw new Error('Unable to allocate order number');
        if (useIiko && submittedIikoOrderId && initialIikoCreationStatus !== 'Success') {
          const creation = await waitForIikoCreation(submittedIikoOrderId);
          if (creation?.creation_status === 'Error') {
            await pool.query('delete from customer_orders where order_number=$1', [saved.rows[0].order_number]);
            throw Object.assign(new Error(`iiko не создал заказ: ${readableIikoOrderError(creation.error_info)}`), { status: 409 });
          }
        }
        if (clientRequestId) await pool.query(`update order_requests set status='success',order_number=$1,iiko_order_id=$2,updated_at=now() where restaurant_id=$3 and client_request_id=$4`, [saved.rows[0].order_number, submittedIikoOrderId, iikoOrganizationId, clientRequestId]);
      } catch (error) {
        if (clientRequestId) await pool.query(`update order_requests set status='failed',iiko_order_id=coalesce($1,iiko_order_id),error_message=$2,updated_at=now() where restaurant_id=$3 and client_request_id=$4`, [submittedIikoOrderId, String(error.message ?? 'Ошибка отправки').slice(0, 500), iikoOrganizationId, clientRequestId]);
        await closeGuestSessionIfIdle(sessionId, 'order_failed');
        throw error;
      }
      await publishEvent('order_created', 'order', saved.rows[0].order_number, { tableNumber: saved.rows[0].table_number, source: body.source === 'qr' ? 'qr' : 'tablet', total: Number(saved.rows[0].total) });
      void notifyWaiters(`Новый заказ · стол №${saved.rows[0].table_number}`, `Заказ ${saved.rows[0].order_number} на ${saved.rows[0].total} ₽`, { type: 'order', orderNumber: saved.rows[0].order_number, tableNumber: saved.rows[0].table_number });
      return json(response, 201, saved.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/service-requests') {
      const body = await readBody(request);
      const type = String(body.type ?? '');
      if (!body.terminal_id || !serviceTypes.has(type)) return json(response, 400, { error: 'Некорректный запрос' });
      enforceRequestRate(`service:${requestIp(request)}:${String(body.terminal_id)}`, 8, 5 * 60_000);
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно недоступен' });
      const table = await effectiveTableForTerminal(terminal.rows[0]);
      const sessionId = await getOrCreateGuestSession({ terminalId: String(body.terminal_id), table });
      const created = await pool.query('insert into service_requests(terminal_id, table_number, request_type, restaurant_id, guest_session_id) values ($1,$2,$3,$4,$5) returning id', [String(body.terminal_id), table.table_number, type, iikoOrganizationId, sessionId]);
      await publishEvent('waiter_called', 'service_request', String(created.rows[0].id), { tableNumber: table.table_number, type });
      void notifyWaiters(`СТОЛ №${table.table_number}`, servicePushText[type] ?? 'Новый вызов за столом', { type: 'service_request', requestId: created.rows[0].id, tableNumber: table.table_number, requestType: type });
      return json(response, 201, { ok: true });
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/orders/') && path.endsWith('/complete')) {
      const orderNumber = decodeURIComponent(path.slice('/api/v1/orders/'.length, -'/complete'.length));
      const body = await readBody(request);
      if (!body.terminal_id || !orderNumber) return json(response, 400, { error: 'Некорректный заказ' });
      const result = await pool.query('update customer_orders set completed_at = now(), updated_at = now() where order_number = $1 and terminal_id = $2 and completed_at is null returning guest_session_id,table_number', [orderNumber, String(body.terminal_id)]);
      if (!result.rowCount) return json(response, 404, { error: 'Заказ не найден или уже завершён' });
      const terminal = await pool.query('select table_number from terminals where id=$1', [String(body.terminal_id)]);
      const remaining = await pool.query('select count(*)::int as count from customer_orders where terminal_id=$1 and completed_at is null', [String(body.terminal_id)]);
      if (!String(terminal.rows[0]?.table_number ?? '').trim() && !remaining.rows[0].count) await pool.query('delete from terminal_table_selections where terminal_id=$1', [String(body.terminal_id)]);
      await publishEvent('order_completed', 'order', orderNumber, { tableNumber: result.rows[0].table_number, source: 'kiosk' });
      await closeGuestSessionIfIdle(result.rows[0].guest_session_id, 'order_completed');
      return json(response, 204, {});
    }
    if (!path.startsWith('/api/v1/admin/')) return json(response, 404, { error: 'Not found' });
    const admin = requireAdmin(request);
    const terminalOnly = request.method === 'PUT' && path.startsWith('/api/v1/admin/terminals/');
    if (admin.scope === 'terminal' && !terminalOnly) throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
    const hostessAllowed = request.method === 'GET' && path === '/api/v1/admin/orders' || terminalOnly;
    if (admin.role === 'hostess' && !hostessAllowed) throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
    const actor = admin.userId ? `admin-user:${admin.userId}` : admin.scope === 'terminal' ? 'terminal-admin' : 'restaurant-admin';
    if (request.method === 'GET' && path === '/api/v1/admin/state') return json(response, 200, await publicState(url.searchParams.get('terminalId') ?? 'admin-preview'));
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/unlock') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Настройки iiko доступны только администратору' });
      const body = await readBody(request); const password = String(body.password ?? '');
      const attemptKey = authAttemptKey(request, 'iiko-config'); await assertAuthAllowed(attemptKey);
      if (!await verifyAdministratorPassword(admin, password)) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный пароль администратора' }); }
      await clearAuthFailures(attemptKey);
      await audit(actor, 'unlock', 'iiko_connection', 'active', null, { expiresInMinutes: 5 });
      return json(response, 200, { token: sign({ admin: true, configAccess: true, scope: 'restaurant', role: 'administrator', userId: admin.userId ?? null, exp: Date.now() + 5 * 60_000 }), expiresIn: 300 });
    }
    if (request.method === 'GET' && path === '/api/v1/admin/iiko-config') {
      requireIikoConfigAccess(request);
      return json(response, 200, { ...safeIikoConfig(), allowedApiBases: [...allowedIikoApiBases], webhookUrl: publicIikoWebhookUrl });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/discover') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request);
      enforceRequestRate(`iiko-config-discover:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 5, 10 * 60_000);
      const discovered = await discoverIikoCredentials(credentialsForIikoDiscovery(body), configAdmin.userId ?? null);
      await audit(actor, 'discover', 'iiko_connection', 'candidate', null, { organizations: discovered.organizations.map((item) => item.name) });
      return json(response, 200, discovered);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/restaurant-options') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request); const session = requireIikoDiscoverySession(body.discoveryToken, configAdmin);
      const organizationId = String(body.organizationId ?? '');
      if (!session.organizations.some((item) => item.id === organizationId)) return json(response, 400, { error: 'Выбранный ресторан недоступен этому API-логину' });
      const options = await discoverIikoRestaurantOptions(session, organizationId);
      session.options = { organizationId, ...options };
      return json(response, 200, options);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/test') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request);
      const session = body.discoveryToken ? requireIikoDiscoverySession(body.discoveryToken, configAdmin) : null;
      const candidate = session ? configFromIikoDiscovery(session, body) : candidateIikoConfig(body);
      enforceRequestRate(`iiko-config-test:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 5, 10 * 60_000);
      const result = await testIikoConnection(candidate);
      await audit(actor, 'test', 'iiko_connection', 'candidate', null, { ...result, organizationId: candidate.organizationId, terminalGroupId: candidate.terminalGroupId, externalMenuId: candidate.externalMenuId });
      return json(response, 200, { result, testToken: sign({ configTest: true, configHash: iikoConfigHash(candidate), userId: configAdmin.userId ?? null, result, exp: Date.now() + 5 * 60_000 }) });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/apply') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request);
      const session = body.discoveryToken ? requireIikoDiscoverySession(body.discoveryToken, configAdmin) : null;
      const candidate = session ? configFromIikoDiscovery(session, body) : candidateIikoConfig(body);
      enforceRequestRate(`iiko-config-apply:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 3, 10 * 60_000);
      const tested = verify(body.testToken);
      if (!tested?.configTest || tested.configHash !== iikoConfigHash(candidate) || String(tested.userId ?? '') !== String(configAdmin.userId ?? '')) return json(response, 409, { error: 'Сначала проверьте именно эту конфигурацию ещё раз' });
      const previousRow = iikoConnectionMetadata; const previousConfig = previousRow ? configFromRow(previousRow) : runtimeIikoConfig(); const before = safeIikoConfig(previousRow);
      const encrypted = encryptIikoCredentials({ appId: candidate.appId, apiLogin: candidate.apiLogin, clientSecret: candidate.clientSecret, webhookToken: candidate.webhookToken });
      iikoConfigSwitching = true; let restoreOk = true; let webhookRegistration = null;
      try {
        const saved = await pool.query(`insert into iiko_connection_settings(id,api_base,organization_id,terminal_group_id,external_menu_id,order_type_id,order_source_key,credentials_ciphertext,credentials_iv,credentials_tag,configured_by,last_test_at,last_test_details)
          values('active',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
          on conflict(id) do update set api_base=excluded.api_base,organization_id=excluded.organization_id,terminal_group_id=excluded.terminal_group_id,external_menu_id=excluded.external_menu_id,order_type_id=excluded.order_type_id,order_source_key=excluded.order_source_key,
          credentials_ciphertext=excluded.credentials_ciphertext,credentials_iv=excluded.credentials_iv,credentials_tag=excluded.credentials_tag,configured_by=excluded.configured_by,last_test_at=excluded.last_test_at,last_test_details=excluded.last_test_details,updated_at=now() returning *`,
        [candidate.apiBase,candidate.organizationId,candidate.terminalGroupId,candidate.externalMenuId,candidate.orderTypeId,candidate.orderSourceKey,encrypted.ciphertext,encrypted.iv,encrypted.tag,actor,JSON.stringify(tested.result ?? {})]);
        iikoConnectionMetadata = saved.rows[0]; applyRuntimeIikoConfig(candidate);
        webhookRegistration = await ensureIikoWebhookRegistration(candidate);
        const [menuCount, tableCount] = await Promise.all([syncIikoMenu(), syncIikoTables()]);
        await fetchIikoStopLists([candidate.terminalGroupId]);
        const after = safeIikoConfig(saved.rows[0]); await audit(actor, 'activate', 'iiko_connection', 'active', before, after);
        await publishEvent('iiko_connection_changed', 'iiko_connection', 'active', { actor, organizationId: candidate.organizationId, menuCount, tableCount, webhookRegistered: true, webhookUpdated: webhookRegistration.updated }, candidate.organizationId);
        if (body.discoveryToken) iikoDiscoverySessions.delete(String(body.discoveryToken));
        return json(response, 200, { config: after, sync: { menuItems: menuCount, tables: tableCount }, webhook: { registered: true, updated: webhookRegistration.updated } });
      } catch (error) {
        try { await restoreIikoWebhookRegistration(candidate, webhookRegistration); }
        catch (restoreError) { restoreOk = false; console.error('Unable to restore previous iiko webhook registration:', restoreError); }
        try {
          if (previousRow) await pool.query(`update iiko_connection_settings set api_base=$1,organization_id=$2,terminal_group_id=$3,external_menu_id=$4,order_type_id=$5,order_source_key=$6,credentials_ciphertext=$7,credentials_iv=$8,credentials_tag=$9,configured_by=$10,last_test_at=$11,last_test_details=$12,updated_at=$13 where id='active'`,
            [previousRow.api_base,previousRow.organization_id,previousRow.terminal_group_id,previousRow.external_menu_id,previousRow.order_type_id,previousRow.order_source_key,previousRow.credentials_ciphertext,previousRow.credentials_iv,previousRow.credentials_tag,previousRow.configured_by,previousRow.last_test_at,previousRow.last_test_details,previousRow.updated_at]);
          else await pool.query("delete from iiko_connection_settings where id='active'");
          iikoConnectionMetadata = previousRow; applyRuntimeIikoConfig(previousConfig);
          if (previousConfig.appId && previousConfig.apiLogin && previousConfig.clientSecret && previousConfig.organizationId) await Promise.all([syncIikoMenu(), syncIikoTables(), fetchIikoStopLists([previousConfig.terminalGroupId])]);
        } catch (restoreError) { restoreOk = false; console.error('Unable to restore previous iiko configuration:', restoreError); }
        throw error;
      } finally { iikoConfigSwitching = !restoreOk; }
    }
    if (request.method === 'GET' && path === '/api/v1/admin/orders') {
      const filter = url.searchParams.get('filter') === 'all' ? 'all' : 'active';
      const result = await pool.query(`select o.order_number,o.iiko_order_id,o.iiko_pos_id,o.table_number,coalesce(t.label,'') as terminal_label,o.items,o.total,o.status_step,
        case when o.completed_at is not null then 'completed' when io.creation_status='Error' then 'error' when o.status_step>=4 then 'served' else 'active' end as status,
        io.creation_status,o.source,o.created_at,o.updated_at,o.completed_at,
        coalesce((select jsonb_agg(jsonb_build_object('event_type',e.event_type,'payload',e.payload,'created_at',e.created_at) order by e.created_at) from app_events e where e.restaurant_id=o.restaurant_id and e.aggregate_type='order' and e.aggregate_id=o.order_number),'[]'::jsonb) as history
        from customer_orders o left join terminals t on t.id=o.terminal_id left join iiko_orders io on io.order_id=o.iiko_order_id
        where o.restaurant_id=$1 and ($2='all' or o.completed_at is null) and o.created_at>now()-interval '30 days' order by o.created_at desc limit 250`, [iikoOrganizationId, filter]);
      return json(response, 200, result.rows);
    }
    if (request.method === 'GET' && path === '/api/v1/admin/diagnostics') {
      const started = Date.now();
      const [menu, orderErrors, failedRequests, webhook, incidents] = await Promise.all([
        pool.query(`select max(updated_at) as updated_at,count(*) filter(where not is_hidden)::int as active_products from iiko_menu_items`),
        pool.query(`select count(*)::int as errors_24h,max(updated_at) as last_error_at from iiko_orders where creation_status='Error' and updated_at>now()-interval '24 hours'`),
        pool.query(`select count(*)::int as errors_24h,max(updated_at) as last_error_at from order_requests where status='failed' and updated_at>now()-interval '24 hours'`),
        pool.query(`select max(received_at) as last_event_at,count(*) filter(where received_at>now()-interval '24 hours')::int as events_24h from iiko_webhook_events`),
        pool.query(`select component,severity,message,context,created_at from monitoring_events where created_at>now()-interval '24 hours' order by created_at desc limit 30`),
      ]);
      let disk = { ok: false, usedPercent: null };
      try {
        const stat = await fs.statfs('/');
        const blocks = Number(stat.blocks); const available = Number(stat.bavail);
        const usedPercent = blocks > 0 ? Math.round((1 - available / blocks) * 1000) / 10 : 0;
        disk = { ok: usedPercent < 85, usedPercent };
      } catch (error) { await recordMonitoringEvent('disk', error.message, {}, 'warning'); }
      const recent = incidents.rows;
      const webhookErrors = recent.filter((item) => item.component === 'webhook').length;
      const syncErrors = recent.filter((item) => item.component === 'iiko_sync').length;
      const iikoOrderErrors = Number(orderErrors.rows[0].errors_24h) + Number(failedRequests.rows[0].errors_24h);
      return json(response, 200, {
        generated_at: new Date().toISOString(),
        api: { ok: true, uptime_seconds: Math.round(process.uptime()), started_at: new Date(Date.now() - process.uptime() * 1000).toISOString() },
        database: { ok: true, latency_ms: Date.now() - started },
        disk,
        menu: { active_products: Number(menu.rows[0].active_products), updated_at: menu.rows[0].updated_at },
        iiko_orders: { ok: iikoOrderErrors === 0, errors_24h: iikoOrderErrors, last_error_at: orderErrors.rows[0].last_error_at ?? failedRequests.rows[0].last_error_at },
        webhook: { ok: webhookErrors === 0, errors_24h: webhookErrors, events_24h: Number(webhook.rows[0].events_24h), last_event_at: webhook.rows[0].last_event_at },
        iiko_sync: { ok: syncErrors === 0 && Date.now() >= iikoRetryAfter, errors_24h: syncErrors, backoff_until: iikoRetryAfter ? new Date(iikoRetryAfter).toISOString() : null },
        incidents: recent,
      });
    }
    if (request.method === 'GET' && path === '/api/v1/admin/waiters') {
      const result = await pool.query('select id,display_name,is_active,created_at from waiter_profiles where restaurant_id=$1 order by display_name', [iikoOrganizationId]); return json(response, 200, result.rows);
    }
    if (request.method === 'GET' && path === '/api/v1/admin/users') {
      const result = await pool.query('select id,username,display_name,role,is_active,created_at from admin_users where restaurant_id=$1 order by display_name', [iikoOrganizationId]);
      return json(response, 200, result.rows);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/users') {
      const body = await readBody(request); const username=String(body.username??'').trim(); const name=String(body.name??'').trim(); const password=String(body.password??''); const role=body.role==='hostess'?'hostess':'administrator';
      if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username) || !name || password.length<8) return json(response,400,{error:'Логин: 3–40 символов; пароль: минимум 8 символов'});
      try { const id=crypto.randomUUID(); const result=await pool.query('insert into admin_users(id,restaurant_id,username,display_name,role,password_hash) values($1,$2,$3,$4,$5,$6) returning id,username,display_name,role,is_active,created_at',[id,iikoOrganizationId,username,name,role,passwordHash(password)]); await audit(actor,'create','admin_user',id,null,result.rows[0]); return json(response,201,result.rows[0]); }
      catch(error){ if(error.code==='23505') return json(response,409,{error:'Такой логин уже существует'}); throw error; }
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/users/')) {
      const id=decodeURIComponent(path.slice('/api/v1/admin/users/'.length)); const body=await readBody(request); const password=String(body.password??''); const role=body.role==='hostess'?'hostess':'administrator';
      if (password && password.length<8) return json(response,400,{error:'Пароль должен содержать минимум 8 символов'});
      const result=await pool.query(`update admin_users set role=$1,is_active=$2,password_hash=case when $3='' then password_hash else $4 end,updated_at=now() where id=$5 and restaurant_id=$6 returning id,username,display_name,role,is_active,created_at`,[role,body.is_active!==false,password,password?passwordHash(password):'',id,iikoOrganizationId]);
      if(!result.rowCount)return json(response,404,{error:'Пользователь не найден'}); await audit(actor,'update','admin_user',id,null,result.rows[0]); return json(response,200,result.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/waiters') {
      const body = await readBody(request); const name=String(body.name??'').trim(); const pin=String(body.pin??'');
      if (!name || !/^\d{4,8}$/.test(pin)) return json(response,400,{error:'Укажите имя и PIN из 4–8 цифр'});
      const id=crypto.randomUUID(); const result=await pool.query('insert into waiter_profiles(id,restaurant_id,display_name,pin_hash) values($1,$2,$3,$4) returning id,display_name,is_active,created_at',[id,iikoOrganizationId,name,passwordHash(pin)]);
      await audit(actor,'create','waiter',id,null,result.rows[0]); return json(response,201,result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/waiters/')) {
      const id=decodeURIComponent(path.slice('/api/v1/admin/waiters/'.length)); const body=await readBody(request); const pin=String(body.pin ?? '');
      if (pin && !/^\d{4,8}$/.test(pin)) return json(response,400,{error:'PIN должен содержать 4–8 цифр'});
      const result=await pool.query(`update waiter_profiles set is_active=$1,pin_hash=case when $2='' then pin_hash else $3 end,updated_at=now() where id=$4 and restaurant_id=$5 returning id,display_name,is_active,created_at`,[body.is_active !== false,pin,pin ? passwordHash(pin) : '',id,iikoOrganizationId]);
      if (!result.rowCount) return json(response,404,{error:'Официант не найден'}); return json(response,200,result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/iiko-products/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/iiko-products/'.length)); const body = await readBody(request);
      const exists = await pool.query('select product_id,sku from iiko_menu_items where product_id=$1 and not is_hidden', [id]);
      if (!exists.rowCount) return json(response, 404, { error: 'Блюдо iiko не найдено' });
      const sku = String(exists.rows[0].sku ?? '');
      if (!sku) return json(response, 409, { error: 'У блюда не заполнен SKU в iiko' });
      const pairIds = arrayValue(body.pairs_with).map(String);
      const pairRows = pairIds.length ? await pool.query('select product_id,sku from iiko_menu_items where product_id=any($1::text[]) and not is_hidden and sku is not null', [pairIds]) : { rows: [] };
      if (pairRows.rows.length !== new Set(pairIds).size) return json(response, 409, { error: 'У одного из рекомендованных блюд отсутствует SKU' });
      const skuById = new Map(pairRows.rows.map((row) => [row.product_id, row.sku]));
      const pairSkus = pairIds.map((pairId) => skuById.get(pairId)).filter(Boolean);
      const before = await pool.query('select * from iiko_product_presentations where restaurant_id=$1 and sku=$2', [iikoOrganizationId, sku]);
      const result = await pool.query(`insert into iiko_product_presentations(restaurant_id,sku,image,image_position,badge,pairs_with_skus) values($1,$2,$3,$4,$5,$6)
        on conflict(restaurant_id,sku) do update set image=excluded.image,image_position=excluded.image_position,badge=excluded.badge,pairs_with_skus=excluded.pairs_with_skus,updated_at=now() returning *`, [iikoOrganizationId, sku, String(body.image ?? ''), String(body.image_position ?? 'center'), String(body.badge ?? ''), JSON.stringify(pairSkus)]);
      if (before.rows[0]?.image && before.rows[0].image !== result.rows[0].image) await removeUploadedProduct(before.rows[0].image);
      await audit(actor, 'update', 'iiko_product_presentation', sku, null, result.rows[0]); return json(response, 200, { ...result.rows[0], pairs_with: pairIds });
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
    if (request.method === 'GET' && path === '/api/v1/admin/banners') {
      const result = await pool.query(`select b.*,coalesce((select m.product_id from iiko_menu_items m where m.sku=b.product_sku and not m.is_hidden order by m.updated_at desc limit 1),b.product_id) as product_id from banners b order by b.sort_order,b.id`);
      return json(response, 200, result.rows);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/products/upload') {
      const url = await saveImageUpload(await readBody(request, 12_000_000), productUploadDir, productPublicPath);
      return json(response, 201, { url });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/banners/upload') {
      const url = await saveImageUpload(await readBody(request, 12_000_000), bannerUploadDir, bannerPublicPath);
      return json(response, 201, { url });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/banners') {
      const value = bannerPayload(await readBody(request));
      const productSku = await ensureBannerProduct(value.productId);
      const result = await pool.query('insert into banners(name,image_url,product_id,product_sku,kind,active,starts_at,ends_at,impression_limit,sort_order) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *', [value.name, value.imageUrl, value.productId, productSku, value.kind, value.active, value.startsAt, value.endsAt, value.impressionLimit, value.sortOrder]);
      await audit(actor, 'create', 'banner', result.rows[0].id, null, result.rows[0]);
      return json(response, 201, result.rows[0]);
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/admin/banners/') && path.endsWith('/reset-impressions')) {
      const id = Number(path.slice('/api/v1/admin/banners/'.length, -'/reset-impressions'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный баннер' });
      const before = await pool.query('select * from banners where id=$1', [id]);
      if (!before.rowCount) return json(response, 404, { error: 'Баннер не найден' });
      const result = await pool.query('update banners set impressions=0,updated_at=now() where id=$1 returning *', [id]);
      await pool.query('delete from banner_impressions where banner_id=$1', [id]);
      await audit(actor, 'reset_impressions', 'banner', id, before.rows[0], result.rows[0]);
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/banners/')) {
      const id = Number(path.slice('/api/v1/admin/banners/'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный баннер' });
      const value = bannerPayload(await readBody(request));
      const productSku = await ensureBannerProduct(value.productId);
      const before = await pool.query('select * from banners where id=$1', [id]);
      if (!before.rowCount) return json(response, 404, { error: 'Баннер не найден' });
      const result = await pool.query('update banners set name=$1,image_url=$2,product_id=$3,product_sku=$4,kind=$5,active=$6,starts_at=$7,ends_at=$8,impression_limit=$9,sort_order=$10,updated_at=now() where id=$11 returning *', [value.name, value.imageUrl, value.productId, productSku, value.kind, value.active, value.startsAt, value.endsAt, value.impressionLimit, value.sortOrder, id]);
      if (before.rows[0].image_url !== value.imageUrl) await removeUploadedBanner(before.rows[0].image_url);
      await audit(actor, 'update', 'banner', id, before.rows[0], result.rows[0]);
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/admin/banners/')) {
      const id = Number(path.slice('/api/v1/admin/banners/'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный баннер' });
      const removed = await pool.query('delete from banners where id=$1 returning *', [id]);
      if (!removed.rowCount) return json(response, 404, { error: 'Баннер не найден' });
      await removeUploadedBanner(removed.rows[0].image_url);
      await audit(actor, 'delete', 'banner', id, removed.rows[0], null);
      return json(response, 204, {});
    }
    if (request.method === 'GET' && path === '/api/v1/admin/audit') {
      const result = await pool.query('select * from audit_log order by created_at desc limit 100');
      return json(response, 200, result.rows);
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.status ?? 500;
    const errorContext = { status, code: error.code ?? null, correlationId: error.correlationId ?? null };
    if (requestPath === '/api/v1/iiko/webhook' && status >= 400) await recordMonitoringEvent('webhook', error.message, errorContext);
    else if (request.method === 'POST' && requestPath === '/api/v1/orders' && (status >= 500 || error.correlationId || /iiko/i.test(error.message ?? ''))) await recordMonitoringEvent('iiko_order', error.message, errorContext);
    else if (['ECONNREFUSED', 'ECONNRESET', '57P01', '57P02', '57P03'].includes(String(error.code ?? ''))) await recordMonitoringEvent('database', error.message, errorContext, 'critical');
    if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
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
  if (!iikoAppId || !iikoApiLogin || !iikoClientSecret || !iikoOrganizationId) return;
  backgroundSyncRunning = true;
  try {
    const results = await Promise.allSettled([syncIikoMenu(), syncIikoTables(), fetchIikoStopLists(iikoTerminalGroupId ? [iikoTerminalGroupId] : [])]);
    for (const result of results.filter((item) => item.status === 'rejected')) {
      const message = result.reason?.message ?? String(result.reason);
      console.warn('iiko cache sync:', message);
      await recordMonitoringEvent('iiko_sync', message, {}, 'warning');
    }
    await syncActiveIikoOrders();
  } catch (error) { console.warn('iiko background sync:', error.message); await recordMonitoringEvent('iiko_sync', error.message, {}, 'warning'); }
  finally { backgroundSyncRunning = false; }
};

await loadStoredIikoConfig();
server.listen(port, '127.0.0.1', () => {
  console.log(`Zakaz API listening on ${port}`);
  setTimeout(() => { void backgroundSync(); }, 3_000);
  setTimeout(() => {
    const config = runtimeIikoConfig();
    if (!config.appId || !config.organizationId || !config.webhookToken) return;
    void ensureIikoWebhookRegistration(config)
      .then((result) => { if (result.updated) console.log('iiko webhook registration updated and verified'); })
      .catch(async (error) => { console.warn('iiko webhook registration:', error.message); await recordMonitoringEvent('webhook', `Автоматическая регистрация webhook: ${error.message}`, { correlationId: error.correlationId ?? null }, 'warning'); });
  }, 6_000);
  // No tablet makes these calls. Menu/tables/stop-list are refreshed in one
  // controlled server task; active orders use webhooks first and this fallback.
  setInterval(() => { void backgroundSync(); }, 10 * 60 * 1_000).unref();
  setInterval(() => { void syncActiveIikoOrders().catch((error) => console.warn('iiko order sync:', error.message)); }, 2 * 60 * 1_000).unref();
});
