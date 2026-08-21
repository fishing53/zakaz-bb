import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import pathModule from 'node:path';
import { URL } from 'node:url';
import pg from 'pg';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { createIikoMenuSnapshot, deterministicUuid, iikoItemStatuses, iikoStatusStep, isDatabaseBackupFileName, isIikoOrderSettled, normalizeIikoStopListGroups, validateMenuPublication, visibleCatalogItems } from './core.mjs';
import { BridgeConnectionRegistry, normalizeBridgeEmployee, validateEmployeeSnapshot } from './iiko-front-bridge.mjs';

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
const publicIikoWebhookUrl = process.env.IIKO_WEBHOOK_URL || 'https://order.brooklynbowl.ru/api/v1/iiko/webhook';
let iikoTerminalGroupId = process.env.IIKO_TERMINAL_GROUP_ID ?? '';
let iikoExternalMenuId = process.env.IIKO_EXTERNAL_MENU_ID ?? '';
let iikoOrderTypeId = process.env.IIKO_ORDER_TYPE_ID ?? '';
let iikoOrderSourceKey = process.env.IIKO_ORDER_SOURCE_KEY || 'BrooklynBowl Kiosk';
let iikoAppId = process.env.IIKO_APP_ID ?? '';
let iikoApiLogin = process.env.IIKO_API_LOGIN ?? '';
let iikoClientSecret = process.env.IIKO_CLIENT_SECRET ?? '';
const iikoConfigEncryptionKeyHex = process.env.IIKO_CONFIG_ENCRYPTION_KEY ?? '';
const catalogSchemaRevision = '4';
const otaManifestPath = process.env.OTA_MANIFEST_PATH ?? '/var/www/bb-kiosk/ota/manifest.json';
const waiterOtaManifestPath = process.env.WAITER_OTA_MANIFEST_PATH ?? '/var/www/bb-kiosk/ota/waiter/manifest.json';
const applicationDownloadDir = process.env.APPLICATION_DOWNLOAD_DIR ?? '/var/www/bb-kiosk/downloads';
const bannerUploadDir = process.env.BANNER_UPLOAD_DIR ?? '/var/www/bb-kiosk/uploads/banners';
const bannerPublicPath = process.env.BANNER_PUBLIC_PATH ?? '/uploads/banners';
const productUploadDir = process.env.PRODUCT_UPLOAD_DIR ?? '/var/www/bb-kiosk/uploads/products';
const productPublicPath = process.env.PRODUCT_PUBLIC_PATH ?? '/uploads/products';
const backupDir = process.env.BB_KIOSK_BACKUP_DIR ?? process.env.ZAKAZ_BACKUP_DIR ?? '/var/backups/bb-kiosk-postgres';
const qualityReportPath = process.env.QUALITY_REPORT_PATH ?? '/opt/bb-kiosk-api/quality-report.json';
const publicAppUrl = (process.env.PUBLIC_APP_URL || 'https://order.brooklynbowl.ru').replace(/\/$/, '');
const allowedOrigins = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'https://order.brooklynbowl.ru',
  // Compatibility for APK versions released before the domain migration.
  'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai',
]);
const bridgeConnections = new BridgeConnectionRegistry();

if (!process.env.DATABASE_URL || !tokenSecret || !adminPasswordHash || !/^[a-f0-9]{64}$/i.test(iikoConfigEncryptionKeyHex)) throw new Error('DATABASE_URL, TOKEN_SECRET, ADMIN_PASSWORD_HASH and a 32-byte IIKO_CONFIG_ENCRYPTION_KEY are required');
if (!/^https:\/\/[^\s]+$/i.test(publicIikoWebhookUrl)) throw new Error('IIKO_WEBHOOK_URL must be a public HTTPS URL');
const iikoConfigEncryptionKey = Buffer.from(iikoConfigEncryptionKeyHex, 'hex');

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
const htmlText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
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
  const organizationId = String(body.organizationId ?? ''); const terminalGroupId = String(body.terminalGroupId ?? ''); const externalMenuId = String(body.externalMenuId ?? ''); const orderTypeId = String(body.orderTypeId ?? '');
  if (!options || options.organizationId !== organizationId) throw Object.assign(new Error('Сначала выберите ресторан и получите его параметры'), { status: 409 });
  if (!options.terminalGroups.some((item) => item.id === terminalGroupId)) throw Object.assign(new Error('Выберите доступную кассовую группу'), { status: 400 });
  if (!options.externalMenus.some((item) => item.id === externalMenuId)) throw Object.assign(new Error('Выберите доступное внешнее меню'), { status: 400 });
  if (!options.orderTypes.some((item) => item.id === orderTypeId)) throw Object.assign(new Error('Выберите доступный тип заказа'), { status: 400 });
  const existingWebhook = String(session.config.webhookToken ?? '');
  return validateIikoConfig({ ...session.config, organizationId, terminalGroupId, externalMenuId, orderTypeId, orderSourceKey: 'BrooklynBowl Kiosk', webhookToken: existingWebhook });
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
const qrToken = (row) => {
  const value = `${row.id}.${Number(row.token_version)}`;
  const signature = crypto.createHmac('sha256', tokenSecret).update(`table-qr:${value}`).digest('base64url');
  return `${value}.${signature}`;
};
const verifyQrToken = (value) => {
  const [id, rawVersion, signature, ...rest] = String(value ?? '').split('.');
  if (rest.length || !/^[0-9a-f-]{36}$/i.test(id ?? '') || !/^\d{1,9}$/.test(rawVersion ?? '') || !signature) return null;
  const unsigned = `${id}.${rawVersion}`;
  const expected = crypto.createHmac('sha256', tokenSecret).update(`table-qr:${unsigned}`).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
  return { id, version: Number(rawVersion) };
};
const qrPublicUrl = (row) => `${publicAppUrl}/?qr=${encodeURIComponent(qrToken(row))}#/menu`;
const publicQrCode = async (row) => {
  const publicUrl = qrPublicUrl(row);
  const qrSvg = await QRCode.toString(publicUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  return {
    id: row.id, table_id: row.table_id, table_number: row.table_number, table_name: row.table_name,
    section_name: row.section_name, is_active: row.is_active, scans_count: Number(row.scans_count),
    last_scanned_at: row.last_scanned_at, created_at: row.created_at, updated_at: row.updated_at,
    public_url: publicUrl, qr_svg: qrSvg,
  };
};
const applicationArtifacts = {
  kiosk: { name: 'BB Kiosk', filename: 'BB-Kiosk-latest.apk' },
  waiter: { name: 'BB Waiter', filename: 'BB-Waiter-latest.apk' },
};
const applicationDownloadToken = (row) => {
  const signature = crypto.createHmac('sha256', tokenSecret).update(`application-download:${row.id}`).digest('base64url');
  return `${row.id}.${signature}`;
};
const verifyApplicationDownloadToken = (value) => {
  const [id, signature, ...rest] = String(value ?? '').split('.');
  if (rest.length || !/^[0-9a-f-]{36}$/i.test(id ?? '') || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(`application-download:${id}`).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
  return id;
};
const applicationArtifact = async (kind) => {
  const definition = applicationArtifacts[kind];
  if (!definition) return null;
  const filePath = pathModule.join(applicationDownloadDir, definition.filename);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { ...definition, filePath, size: stat.size };
  } catch { return null; }
};
const applicationVersion = async (kind) => {
  try {
    const manifest = JSON.parse(await fs.readFile(pathModule.join(applicationDownloadDir, 'manifest.json'), 'utf8'));
    return String(manifest?.[kind]?.version ?? manifest?.version ?? '').slice(0, 80) || 'Актуальная сборка';
  } catch { return 'Актуальная сборка'; }
};
const publicApplicationDownload = async (row) => {
  const artifact = await applicationArtifact(row.app_kind);
  const expired = row.status === 'issued' && new Date(row.expires_at).getTime() <= Date.now();
  const status = expired ? 'expired' : row.status;
  const version = status === 'issued' ? await applicationVersion(row.app_kind) : row.version;
  const publicUrl = status === 'issued' && artifact ? `${publicAppUrl}/api/v1/apps/install/${encodeURIComponent(applicationDownloadToken(row))}` : null;
  const qrSvg = publicUrl ? await QRCode.toString(publicUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } }) : null;
  return {
    id: row.id, app_kind: row.app_kind, app_name: applicationArtifacts[row.app_kind]?.name ?? row.app_kind,
    label: row.label, status, version, artifact_available: Boolean(artifact), artifact_size: artifact?.size ?? 0,
    expires_at: row.expires_at, downloaded_at: row.downloaded_at, installed_at: row.installed_at,
    revoked_at: row.revoked_at, created_at: row.created_at, public_url: publicUrl, qr_svg: qrSvg,
  };
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
const requireWaiter = async (request) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = verify(token);
  if (!payload?.waiterId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const active = await pool.query('select display_name from waiter_profiles where id=$1 and restaurant_id=$2 and is_active=true', [payload.waiterId, iikoOrganizationId]);
  if (!active.rowCount) throw Object.assign(new Error('Доступ сотрудника отключён'), { status: 403 });
  return { ...payload, waiterName: active.rows[0].display_name };
};
const audit = (actor, action, entity, entityId, before, after) => pool.query(
  'insert into audit_log(actor, action, entity, entity_id, before_data, after_data) values ($1,$2,$3,$4,$5,$6)',
  [actor, action, entity, entityId, before ?? null, after ?? null],
);
const publishEvent = (eventType, aggregateType, aggregateId, payload, restaurantId = iikoOrganizationId) => pool.query(
  'insert into app_events(restaurant_id,event_type,aggregate_type,aggregate_id,payload) values($1,$2,$3,$4,$5)',
  [restaurantId, eventType, aggregateType, aggregateId, JSON.stringify(payload)],
);
const telegramConfig = async () => {
  const result = await pool.query("select * from notification_settings where id='active'");
  const row = result.rows[0];
  if (!row?.token_ciphertext) return { row, token: '' };
  try {
    const value = decryptIikoCredentials({ credentials_ciphertext: row.token_ciphertext, credentials_iv: row.token_iv, credentials_tag: row.token_tag });
    return { row, token: String(value.token ?? '') };
  } catch (error) { console.warn('Unable to decrypt Telegram token:', error.message); return { row, token: '' }; }
};
const sendTelegramMessage = async (text, { force = false } = {}) => {
  const config = await telegramConfig();
  if (!config.row?.enabled && !force) return false;
  if (!config.token || !config.row?.chat_id) throw new Error('Telegram не настроен');
  const result = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.row.chat_id, text: `BrooklynBowl Kiosk\n\n${text}`, disable_web_page_preview: true }),
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok || payload.ok === false) {
    const message = String(payload.description ?? `Telegram HTTP ${result.status}`).slice(0, 500);
    await pool.query("update notification_settings set last_error=$1,updated_at=now() where id='active'", [message]);
    throw new Error(message);
  }
  await pool.query("update notification_settings set last_success_at=now(),last_error=null,updated_at=now() where id='active'");
  return true;
};
const notifyTelegramAlert = async (key, message, recovered = false) => {
  try {
    const current = await pool.query('select * from notification_alerts where alert_key=$1', [String(key)]);
    const row = current.rows[0];
    if (recovered) {
      if (!row?.is_open) return;
      await sendTelegramMessage(`✅ Работа восстановлена\n${message}`);
      await pool.query(`insert into notification_alerts(alert_key,is_open,last_message,recovered_at,updated_at) values($1,false,$2,now(),now()) on conflict(alert_key) do update set is_open=false,last_message=excluded.last_message,recovered_at=now(),updated_at=now()`, [String(key), String(message)]);
      return;
    }
    if (row?.is_open && row.last_sent_at && Date.now() - new Date(row.last_sent_at).getTime() < 6 * 60 * 60_000) return;
    await sendTelegramMessage(`🔴 Требуется внимание\n${message}`);
    await pool.query(`insert into notification_alerts(alert_key,is_open,last_message,last_sent_at,updated_at) values($1,true,$2,now(),now()) on conflict(alert_key) do update set is_open=true,last_message=excluded.last_message,last_sent_at=now(),updated_at=now()`, [String(key), String(message)]);
  } catch (error) { console.warn('Telegram alert:', error.message); }
};
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
const notifyWaiters = async (title, body, data = {}, waiterId = null) => {
  try {
    const messaging = await firebaseMessaging(); if (!messaging) return;
    const tokens = await pool.query(`select d.token from waiter_devices d join waiter_profiles w on w.id=d.waiter_id
      where w.restaurant_id=$1 and w.is_active=true and d.is_active=true and ($2::text is null or w.id=$2)`, [iikoOrganizationId, waiterId]);
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
  if (isIikoOrderSettled(eventInfo?.order)) {
    // Do this only once. In particular, statusStep=4/Served must never enter
    // this branch: it is a guest-visible serving stage, not a closed check.
    const completed = await pool.query(`update customer_orders set completed_at=now(),updated_at=now()
      where iiko_order_id=$1 and completed_at is null
      returning order_number,guest_session_id,terminal_id,table_number,source,is_demo`, [snapshot.orderId]);
    if (completed.rowCount) {
      const order = completed.rows[0];
      if (order.guest_session_id) {
        await pool.query(`update service_requests set status='completed',handled_at=coalesce(handled_at,now()),completed_at=coalesce(completed_at,now())
          where guest_session_id=$1 and status in ('new','accepted','in_progress')`, [order.guest_session_id]);
      }
      const remaining = await pool.query('select count(*)::int as count from customer_orders where terminal_id=$1 and is_demo=$2 and completed_at is null', [order.terminal_id, order.is_demo]);
      const terminal = await pool.query('select table_number from terminals where id=$1', [order.terminal_id]);
      const hasFixedTable = Boolean(String(terminal.rows[0]?.table_number ?? '').trim());
      if (!String(order.terminal_id).startsWith('qr_') && !hasFixedTable && !remaining.rows[0].count) {
        await pool.query('delete from terminal_table_selections where terminal_id=$1', [order.terminal_id]);
      }
      if (!order.is_demo) await publishEvent('order_completed', 'order', order.order_number, { tableNumber: order.table_number, source: order.source, reason: 'iiko_check_closed' }, organizationId);
      await closeGuestSessionIfIdle(order.guest_session_id, 'iiko_check_closed');
    }
  }
  return result.rows[0];
};
let iikoAccessToken = '';
let iikoAccessTokenExpiresAt = 0;
let iikoAccessTokenTask = null;
let iikoRetryAfter = 0;
const iikoRetryAfterByGroup = new Map();
const iikoRequestWindows = new Map();
const iikoRestrictionGroup = (path) => ({
  '/api/v2/access_token': 'Authorization',
  '/api/1/organizations': 'Data: dictionaries',
  '/api/1/terminal_groups': 'Data: dictionaries',
  '/api/1/deliveries/order_types': 'Data: dictionaries',
  '/api/1/discounts': 'Data: dictionaries',
  '/api/1/terminal_groups/is_alive': 'POS: availability',
  '/api/2/menu': 'Data: menu',
  '/api/2/menu/by_id': 'Data: menu',
  '/api/1/reserve/available_restaurant_sections': 'Orders: preparing',
  '/api/1/stop_lists': 'Data: stoplists',
  '/api/1/order/create': 'Orders: creating',
  '/api/1/order/by_id': 'Orders: receiving',
  '/api/1/webhooks/settings': 'Organizations: settings',
  '/api/1/webhooks/update_settings': 'WebHooks: settings',
}[path] ?? `Other:${path}`);
// Numeric quotas are assigned to an API login in iikoWeb and are not published
// as one universal table. These deliberately conservative local ceilings keep
// BB Kiosk below the assigned quotas; business order creation remains roomy.
const iikoLocalBudgets = new Map([
  ['Authorization', 8],
  ['Data: dictionaries', 12],
  ['POS: availability', 6],
  ['Data: menu', 6],
  ['Orders: preparing', 6],
  ['Data: stoplists', 8],
  ['Orders: receiving', 8],
  ['Organizations: settings', 3],
  ['WebHooks: settings', 1],
  ['Orders: creating', 120],
]);
const iikoRetryDelay = (response, fallbackSeconds = 60) => {
  const raw = String(response.headers.get('retry-after') ?? '').trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.max(30_000, seconds * 1_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(30_000, date - Date.now());
  return fallbackSeconds * 1_000;
};
const registerIikoRateLimit = (response, group) => {
  const delay = iikoRetryDelay(response);
  iikoRetryAfter = Math.max(iikoRetryAfter, Date.now() + delay);
  iikoRetryAfterByGroup.set(group, Date.now() + delay);
  return Math.ceil(delay / 1_000);
};
const reserveIikoRequest = (path) => {
  const group = iikoRestrictionGroup(path);
  const remoteRetryAt = Number(iikoRetryAfterByGroup.get(group) ?? 0);
  if (Date.now() < remoteRetryAt) {
    const retryAfter = Math.max(1, Math.ceil((remoteRetryAt - Date.now()) / 1_000));
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter });
  }
  const windowMs = 10 * 60_000; const now = Date.now();
  const recent = arrayValue(iikoRequestWindows.get(group)).filter((timestamp) => timestamp > now - windowMs);
  const budget = Number(iikoLocalBudgets.get(group) ?? 10);
  if (recent.length >= budget) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1_000));
    iikoRequestWindows.set(group, recent);
    throw Object.assign(new Error(`Безопасный лимит iiko для группы «${group}» исчерпан. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter });
  }
  recent.push(now); iikoRequestWindows.set(group, recent);
  return group;
};
const iikoDiscoverySessions = new Map();
const cleanIikoDiscoverySessions = () => {
  const now = Date.now();
  for (const [id, session] of iikoDiscoverySessions) if (session.expiresAt <= now) iikoDiscoverySessions.delete(id);
};
const discoverIikoCredentials = async (config, userId) => {
  const authGroup = reserveIikoRequest('/api/v2/access_token');
  const auth = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
  const authBody = await auth.json().catch(() => ({}));
  if (auth.status === 429) {
    const retryAfter = registerIikoRateLimit(auth, authGroup);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: authBody.correlationId ?? null });
  }
  if (!auth.ok || !authBody.token) throw Object.assign(new Error(authBody.errorDescription ?? 'iiko не принял данные авторизации'), { status: 409 });
  const organizationsGroup = reserveIikoRequest('/api/1/organizations');
  const organizationsResponse = await fetch(`${config.apiBase}/api/1/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authBody.token}` }, body: JSON.stringify({ returnAdditionalInfo: false, includeDisabled: false }) });
  const organizationsBody = await organizationsResponse.json().catch(() => ({}));
  if (organizationsResponse.status === 429) {
    const retryAfter = registerIikoRateLimit(organizationsResponse, organizationsGroup);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: organizationsBody.correlationId ?? null });
  }
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
  const group = reserveIikoRequest(path);
  const result = await fetch(`${session.config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const retryAfter = registerIikoRateLimit(result, group);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: payload.correlationId ?? null });
  }
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
    orderTypeId: current.organizationId === id && orderTypes.some((item) => item.id === current.orderTypeId) ? current.orderTypeId : orderTypes[0].id,
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
  const group = reserveIikoRequest('/api/v2/access_token');
  const result = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
  const payload = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const retryAfter = registerIikoRateLimit(result, group);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: payload.correlationId ?? null });
  }
  if (!result.ok || !payload.token) throw Object.assign(new Error(payload.errorDescription ?? 'iiko не принял данные авторизации для настройки webhook'), { status: 409 });
  return payload.token;
};
const iikoConfigCall = async (config, token, path, body) => {
  const group = reserveIikoRequest(path);
  const result = await fetch(`${config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const retryAfter = registerIikoRateLimit(result, group);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: payload.correlationId ?? null });
  }
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
const iikoWebhookEnsureTasks = new Map();
const iikoWebhookVerifiedUntil = new Map();
const iikoWebhookUpdatedAt = new Map();
const ensureIikoWebhookRegistration = (config, existingToken = '') => {
  const key = `${config.apiBase}|${config.organizationId}|${config.apiLogin}`;
  if (Number(iikoWebhookVerifiedUntil.get(key) ?? 0) > Date.now()) return Promise.resolve({ updated: false, verified: true });
  if (iikoWebhookEnsureTasks.has(key)) return iikoWebhookEnsureTasks.get(key);
  const task = (async () => {
    const token = existingToken || await authorizeIikoConfig(config);
    const current = normalizedWebhookSettings(await iikoConfigCall(config, token, '/api/1/webhooks/settings', { organizationId: config.organizationId }));
    if (webhookRegistrationMatches(current, config)) {
      iikoWebhookVerifiedUntil.set(key, Date.now() + 10 * 60_000);
      return { updated: false, verified: true };
    }
    const lastUpdate = Number(iikoWebhookUpdatedAt.get(key) ?? 0);
    if (lastUpdate && Date.now() - lastUpdate < 10 * 60_000) {
      const retryAfter = Math.ceil((lastUpdate + 10 * 60_000 - Date.now()) / 1_000);
      throw Object.assign(new Error(`Настройки webhook уже изменялись. Повторите через ${retryAfter} сек.`), { status: 429, retryAfter });
    }
    const desired = { webHooksUri: publicIikoWebhookUrl, authToken: config.webhookToken, webHooksFilter: { ...current.webHooksFilter, ...managedIikoWebhookFilter } };
    await updateIikoWebhookSettings(config, token, desired);
    iikoWebhookUpdatedAt.set(key, Date.now());
    // update_settings returning 200 is the acknowledgement. Do not poll the
    // settings endpoint repeatedly: iiko applies a separate quota per method.
    iikoWebhookVerifiedUntil.set(key, Date.now() + 10 * 60_000);
    return { updated: true, verified: true };
  })().finally(() => iikoWebhookEnsureTasks.delete(key));
  iikoWebhookEnsureTasks.set(key, task);
  return task;
};
const iikoRequest = async (path, body) => {
  const group = reserveIikoRequest(path);
  const token = await getIikoAccessToken();
  const result = await fetch(`${iikoApiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await result.json().catch(() => ({}));
  if (result.status === 429) {
    const retryAfter = registerIikoRateLimit(result, group);
    throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: payload.correlationId ?? null });
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
let iikoDiscountCache = { restaurantId: '', expiresAt: 0, items: [] };
const iikoDiscountOptions = async (force = false) => {
  if (!force && iikoDiscountCache.restaurantId === iikoOrganizationId && iikoDiscountCache.expiresAt > Date.now()) return iikoDiscountCache.items;
  if (!iikoOrganizationId) return [];
  const payload = await iikoRequest('/api/1/discounts', { organizationIds: [iikoOrganizationId] });
  const wrappers = Array.isArray(payload?.discounts) ? payload.discounts : [];
  const items = wrappers.flatMap((wrapper) => Array.isArray(wrapper?.items) ? wrapper.items : [])
    .filter((item) => !item?.isDeleted && item?.isManual && !item?.isAutomatic && !item?.isCategorisedDiscount)
    .map((item) => {
      const percent = Math.max(0, Number(item.percent ?? 0));
      const fixed = Math.max(0, Number(item.sum ?? 0));
      return {
        id: String(item.id ?? ''),
        name: String(item.name ?? 'Скидка iiko').trim(),
        discountType: percent > 0 ? 'percent' : 'fixed',
        value: percent > 0 ? percent : Math.round(fixed),
        minOrderTotal: Math.max(0, Math.round(Number(item.minOrderSum ?? 0))),
      };
    })
    .filter((item) => /^[0-9a-f-]{36}$/i.test(item.id) && item.value > 0);
  iikoDiscountCache = { restaurantId: iikoOrganizationId, expiresAt: Date.now() + 5 * 60_000, items };
  return items;
};
const resolvePromotion = async (rawCode, subtotal) => {
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!code) return null;
  const result = await pool.query(`select * from promotions where restaurant_id=$1 and upper(code)=upper($2) and active=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now()) and (usage_limit is null or uses_count<usage_limit) limit 1`, [iikoOrganizationId, code]);
  if (!result.rowCount) throw Object.assign(new Error('Промокод не найден или срок его действия закончился'), { status: 400 });
  const row = result.rows[0];
  const safeSubtotal = Math.max(0, Math.round(Number(subtotal ?? 0)));
  if (safeSubtotal < Number(row.min_order_total)) throw Object.assign(new Error(`Промокод действует от ${Number(row.min_order_total)} ₽`), { status: 400 });
  const value = Number(row.value);
  const discount = Math.min(safeSubtotal, row.discount_type === 'percent' ? Math.round(safeSubtotal * value / 100) : Math.round(value));
  return { id: String(row.id), code: row.code, name: row.name, discountType: row.discount_type, value, discount, iikoDiscountTypeId: row.iiko_discount_type_id };
};
const promotionInput = async (body) => {
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const iikoDiscountTypeId = String(body.iiko_discount_type_id ?? '').trim();
  const startsAt = body.starts_at ? new Date(body.starts_at) : null;
  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  const usageLimit = body.usage_limit === null || body.usage_limit === undefined || body.usage_limit === '' ? null : Number(body.usage_limit);
  if (!/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9_-]{2,31}$/u.test(code)) throw Object.assign(new Error('Код: от 3 до 32 символов, только буквы, цифры, «-» и «_»'), { status: 400 });
  if (!name || name.length > 120) throw Object.assign(new Error('Укажите название акции'), { status: 400 });
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) throw Object.assign(new Error('Проверьте период действия промокода'), { status: 400 });
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) throw Object.assign(new Error('Лимит должен быть положительным целым числом'), { status: 400 });
  const discount = (await iikoDiscountOptions()).find((item) => item.id === iikoDiscountTypeId);
  if (!discount) throw Object.assign(new Error('Выберите доступную ручную скидку iiko'), { status: 400 });
  return { code, name, iikoDiscountTypeId, iikoDiscountName: discount.name, discountType: discount.discountType, value: discount.value, minOrderTotal: discount.minOrderTotal, active: body.active !== false, startsAt, endsAt, usageLimit };
};
const getIikoAccessToken = async () => {
  if (iikoAccessToken && iikoAccessTokenExpiresAt > Date.now()) return iikoAccessToken;
  if (iikoAccessTokenTask) return iikoAccessTokenTask;
  if (!iikoAppId || !iikoApiLogin || !iikoClientSecret) throw Object.assign(new Error('iiko credentials are not configured'), { status: 503 });
  const authGroup = reserveIikoRequest('/api/v2/access_token');
  iikoAccessTokenTask = (async () => {
    const result = await fetch(`${iikoApiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: iikoAppId, apiLogin: iikoApiLogin, clientSecret: iikoClientSecret }) });
    const body = await result.json().catch(() => ({}));
    if (result.status === 429) {
      const retryAfter = registerIikoRateLimit(result, authGroup);
      throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: body.correlationId ?? null });
    }
    if (!result.ok || !body.token) throw Object.assign(new Error(body.errorDescription ?? 'iiko authorization failed'), { status: 502 });
    iikoAccessToken = body.token;
    iikoAccessTokenExpiresAt = Date.now() + 14 * 60 * 1000;
    return iikoAccessToken;
  })().finally(() => { iikoAccessTokenTask = null; });
  return iikoAccessTokenTask;
};
const testIikoConnection = async (config, existingToken = '') => {
  const started = Date.now();
  let accessToken = existingToken;
  if (!accessToken) {
    const authGroup = reserveIikoRequest('/api/v2/access_token');
    const auth = await fetch(`${config.apiBase}/api/v2/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: config.appId, apiLogin: config.apiLogin, clientSecret: config.clientSecret }) });
    const authBody = await auth.json().catch(() => ({}));
    if (auth.status === 429) {
      const retryAfter = registerIikoRateLimit(auth, authGroup);
      throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: authBody.correlationId ?? null });
    }
    if (!auth.ok || !authBody.token) throw Object.assign(new Error(authBody.errorDescription ?? 'iiko не принял данные авторизации'), { status: 409 });
    accessToken = authBody.token;
  }
  const call = async (path, body) => {
    const group = reserveIikoRequest(path);
    const result = await fetch(`${config.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) });
    const payload = await result.json().catch(() => ({}));
    if (result.status === 429) {
      const retryAfter = registerIikoRateLimit(result, group);
      throw Object.assign(new Error(`iiko временно ограничил запросы. Повторите через ${retryAfter} сек.`), { status: 503, retryAfter, correlationId: payload.correlationId ?? null });
    }
    if (!result.ok) throw Object.assign(new Error(payload.errorDescription ?? `Проверка iiko не пройдена: ${path}`), { status: 409 });
    return payload;
  };
  const organizations = await call('/api/1/organizations', { organizationIds: [config.organizationId], returnAdditionalInfo: false, includeDisabled: false });
  if (!arrayValue(organizations.organizations).some((item) => String(item.id) === config.organizationId)) throw Object.assign(new Error('У API-логина нет доступа к выбранной организации'), { status: 409 });
  const menu = await call('/api/2/menu/by_id', { organizationIds: [config.organizationId], externalMenuId: config.externalMenuId, version: 2, language: 'ru', asyncMode: false });
  const menuItems = assertIikoMenuIsPublishable(menu);
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
const iikoPrice = (size) => Number(arrayValue(size?.prices).find((price) => String(price?.organizationId) === iikoOrganizationId)?.price ?? arrayValue(size?.prices)[0]?.price ?? 0);
const assertIikoMenuIsPublishable = (menu) => {
  const entries = createIikoMenuSnapshot(menu).products;
  const publication = validateMenuPublication(entries);
  if (publication.ok) return entries.length;
  const visible = entries.filter((item) => !item.isHidden);
  const missing = visible.filter((item) => !item.sku).map((item) => item.name);
  const duplicates = publication.duplicateSkus.map((sku) => `${sku}: ${visible.filter((item) => item.sku === sku).map((item) => `${item.name} [${item.category}; ID ${item.productId}]`).join(' / ')}`);
  const details = [missing.length ? `Без SKU: ${missing.join(', ')}` : '', duplicates.length ? `Повторяется SKU: ${duplicates.join('; ')}` : ''].filter(Boolean).join('. ');
  throw Object.assign(new Error(`Внешнее меню iiko не готово к публикации. ${details}`), { status: 409 });
};
const nutritionHasValues = (nutrition) => ['energy', 'calories', 'proteins', 'protein', 'fats', 'fat', 'carbs', 'carbohydrates'].some((key) => Number(nutrition?.[key] ?? 0) > 0);
const modifierRestrictions = (value) => Array.isArray(value) ? (value[0] ?? {}) : value && typeof value === 'object' ? value : {};
const allergenNames = (value) => [...new Map(arrayValue(value)
  .filter((item) => typeof item === 'string' || !item?.isDeleted)
  .map((item) => {
    const name = String(typeof item === 'string' ? item : (item?.name ?? item?.code ?? '')).trim();
    return [name.toLocaleLowerCase('ru-RU'), name];
  })
  .filter(([, name]) => name)).values()];
const allergenText = (value) => allergenNames(value).join(', ');
const modifierImageNameKey = (value) => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter((part) => part && part !== 'соус').sort().join('-');
const publicModifierGroups = (groups, stoppedProductIds = new Set(), modifierImages = new Map()) => arrayValue(groups).map((group) => ({
  name: String(group?.name ?? 'Дополнения'), minQuantity: Number(group?.restrictions?.minQuantity ?? 0), maxQuantity: Number(group?.restrictions?.maxQuantity ?? 99), freeQuantity: Number(group?.restrictions?.freeQuantity ?? 0),
  items: arrayValue(group?.items).filter((item) => item?.itemId && !item?.isHidden && !stoppedProductIds.has(String(item.itemId))).map((item) => {
    const restrictions = modifierRestrictions(item?.restrictions);
    const groupMaximum = Number(group?.restrictions?.maxQuantity ?? 20) || 20;
    const itemMaximum = Number(restrictions.maxQuantity ?? 0) || groupMaximum;
    const name = String(item.name ?? '');
    return { productId: String(item.itemId), name, price: iikoPrice(item), image: String(modifierImages.get(String(item.itemId)) || modifierImages.get(`name:${modifierImageNameKey(name)}`) || item.buttonImageUrl || ''), allergens: allergenText(item.allergenGroups), defaultQuantity: Number(restrictions.byDefault ?? 0), minQuantity: Number(restrictions.minQuantity ?? 0), maxQuantity: Math.min(20, itemMaximum) };
  }),
})).filter((group) => group.items.length);
const syncIikoMenu = async () => {
  if (!iikoExternalMenuId) return 0;
  const menu = await iikoRequest('/api/2/menu/by_id', { organizationIds: [iikoOrganizationId], externalMenuId: iikoExternalMenuId, version: 2, language: 'ru', asyncMode: false });
  const snapshot = createIikoMenuSnapshot(menu);
  const rows = snapshot.products.map((record) => [record.productId, record.sku || null, record.categoryId, record.category, record.name, record.item?.description ?? null, iikoPrice(record.size), Number(record.size?.portionWeightGrams ?? 0), String(record.size?.measureUnitType ?? ''), JSON.stringify(record.size?.nutritionPerHundredGrams ?? record.size?.nutritions?.[0] ?? null), record.size?.buttonImageUrl ?? null, JSON.stringify(record.size?.itemModifierGroups ?? []), record.isHidden, record.sortOrder, Number(menu?.revision ?? 0), JSON.stringify({ item: record.item, size: record.size, categories: record.categories })]);
  if (!rows.length) throw Object.assign(new Error('iiko вернул пустое внешнее меню; сохранён предыдущий снимок'), { status: 502 });
  assertIikoMenuIsPublishable(menu);
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
    // Categories and placements are a full external-menu snapshot as well.
    // Replacing them transactionally preserves both category order and the
    // independent order of a product inside every category.
    await client.query('delete from iiko_menu_categories');
    for (const category of snapshot.categories) {
      await client.query(`insert into iiko_menu_categories(category_id,name,sort_order,revision,raw_payload)
        values($1,$2,$3,$4,$5)`, [category.id, category.name, category.sortOrder, Number(menu?.revision ?? 0), JSON.stringify(category.raw ?? {})]);
      for (const placement of category.items) {
        await client.query(`insert into iiko_menu_category_items(category_id,product_id,sort_order)
          values($1,$2,$3)`, [category.id, placement.productId, placement.sortOrder]);
      }
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
const fetchIikoOrders = async (orderIds) => {
  const uniqueIds = [...new Set(arrayValue(orderIds).map(String).filter(Boolean))].slice(0, 100);
  if (!uniqueIds.length) return [];
  const body = await iikoRequest('/api/1/order/by_id', { organizationIds: [iikoOrganizationId], orderIds: uniqueIds });
  const orders = arrayValue(body.orders);
  return Promise.all(orders.map((order) => saveIikoOrder(order, { organizationId: iikoOrganizationId })));
};
const fetchIikoOrder = async (orderId) => {
  const orders = await fetchIikoOrders([orderId]);
  if (!orders.length) throw Object.assign(new Error('iiko order not found'), { status: 404 });
  return orders[0];
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
let iikoStopListSyncTask = null;
const loadIikoStopLists = async (terminalGroupIds = []) => {
  const requestedTerminalGroupIds = terminalGroupIds.length
    ? terminalGroupIds.map(String)
    : (iikoTerminalGroupId ? [iikoTerminalGroupId] : []);
  const body = await iikoRequest('/api/1/stop_lists', { organizationIds: [iikoOrganizationId], ...(requestedTerminalGroupIds.length ? { terminalGroupsIds: requestedTerminalGroupIds } : {}), returnSize: true });
  const groups = normalizeIikoStopListGroups(body);
  await saveIikoStopLists(groups, iikoOrganizationId, requestedTerminalGroupIds);
  return groups;
};
const fetchIikoStopLists = (terminalGroupIds = []) => {
  if (!iikoStopListSyncTask) {
    iikoStopListSyncTask = loadIikoStopLists(terminalGroupIds).finally(() => { iikoStopListSyncTask = null; });
  }
  return iikoStopListSyncTask;
};
const catalogRevision = () => pool.query(`select concat($3::text, ':',
  coalesce((select max(updated_at)::text from iiko_menu_items),''), ':',
  coalesce((select max(updated_at)::text from iiko_product_presentations where restaurant_id=$1),''), ':',
  coalesce((select max(updated_at)::text from iiko_modifier_presentations where restaurant_id=$1),''), ':',
  coalesce((select md5(coalesce(string_agg(concat_ws(':',product_id,size_id,balance::text),',' order by product_id,size_id),''))
    from iiko_stop_list_items where organization_id=$1 and terminal_group_id=$2),'')
) as revision`, [iikoOrganizationId, iikoTerminalGroupId, catalogSchemaRevision]);
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
  const [localProducts, iikoProducts, iikoCategories, iikoCategoryItems, stopList, modifierPresentations, banners, terminal, selection, settings, revision] = await Promise.all([
    pool.query('select * from products order by category, sort_order, name'),
    pool.query(`select m.*, p.image as override_image,
      coalesce((select jsonb_agg((select pm.product_id from iiko_menu_items pm where pm.sku=pair.sku and not pm.is_hidden order by pm.updated_at desc limit 1) order by pair.ordinality) from jsonb_array_elements_text(p.pairs_with_skus) with ordinality pair(sku,ordinality)),'[]'::jsonb) as override_pairs_with,
      p.badge as override_badge, p.image_position as override_image_position, p.composition as override_composition
      from iiko_menu_items m left join iiko_product_presentations p on p.restaurant_id=$1 and p.sku=m.sku where not m.is_hidden order by m.sort_order,m.name`, [iikoOrganizationId]),
    pool.query('select category_id,name,sort_order from iiko_menu_categories order by sort_order,category_id'),
    pool.query('select category_id,product_id,sort_order from iiko_menu_category_items order by category_id,sort_order,product_id'),
    pool.query(`select product_id as "productId",balance from iiko_stop_list_items where organization_id=$1 and terminal_group_id=$2`, [iikoOrganizationId, iikoTerminalGroupId]),
    pool.query('select modifier_id,name,image from iiko_modifier_presentations where restaurant_id=$1', [iikoOrganizationId]),
    pool.query(`select b.*,coalesce((select m.product_id from iiko_menu_items m where m.sku=b.product_sku and not m.is_hidden order by m.updated_at desc limit 1),b.product_id) as product_id from banners b where active=true
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at > now())
      and (impression_limit is null or impressions < impression_limit)
      order by sort_order,id`),
    pool.query('insert into terminals(id) values ($1) on conflict (id) do update set last_seen_at = now() returning *', [terminalId]),
    pool.query('select * from terminal_table_selections where terminal_id=$1', [terminalId]),
    pool.query('select key, value from app_settings'),
    catalogRevision(),
  ]);
  const fixedTable = String(terminal.rows[0].table_number ?? '').trim();
  const fixedTableId = String(terminal.rows[0].table_id ?? '').trim();
  const chosen = selection.rows[0];
  const effectiveTable = fixedTable || chosen?.table_number || '';
  const demoMode = terminal.rows[0].demo_mode === true;
  const visibleIikoProducts = visibleCatalogItems(iikoProducts.rows, stopList.rows);
  const stoppedProductIds = new Set(stopList.rows.filter((item) => Number(item.balance) <= 0).map((item) => String(item.productId)));
  const modifierImages = new Map(iikoProducts.rows.flatMap((item) => {
    const image = String(item.override_image || item.image_url || '');
    return image ? [[String(item.product_id), image], [`name:${modifierImageNameKey(item.name)}`, image]] : [];
  }));
  for (const item of modifierPresentations.rows) {
    if (item.image) modifierImages.set(String(item.modifier_id), String(item.image));
  }
  const products = demoMode ? localProducts.rows.map((item) => ({ ...item, category_ids: [`local:${item.category}`], sauce_options: [], modifier_groups: demoModifierGroups(item) })) : iikoProducts.rowCount ? visibleIikoProducts.map((item) => ({
    id: item.product_id, sku: item.sku ?? '', name: item.name, category: item.category_name, categories: arrayValue(item.raw_payload?.categories).map((category) => String(category?.name ?? '')).filter(Boolean), category_ids: arrayValue(item.raw_payload?.categories).map((category) => String(category?.id ?? '')).filter(Boolean), price_rub: Number(item.price_rub), portion: item.portion_weight_grams ? String(Math.round(Number(item.portion_weight_grams))) : '', unit: item.measure_unit === 'GRAM' ? 'г' : item.measure_unit,
    description: item.description, composition: item.override_composition ?? '', kbju: nutritionHasValues(item.nutrition) ? { calories: String(item.nutrition.energy ?? item.nutrition.calories ?? 0), protein: String(item.nutrition.proteins ?? item.nutrition.protein ?? 0), fat: String(item.nutrition.fats ?? item.nutrition.fat ?? 0), carbs: String(item.nutrition.carbs ?? item.nutrition.carbohydrates ?? 0) } : null,
    image: item.override_image || item.image_url || '', source_url: '', sauce_options: [], addon_options: [], flavor_options: [], size_option: null,
    pairs_with: arrayValue(item.override_pairs_with).filter((id) => id && !stoppedProductIds.has(String(id))), recommendations_note: null, is_available: true, badge: item.override_badge ?? '', image_position: item.override_image_position ?? 'center', allergens: allergenText(item.raw_payload?.item?.allergens), spicy: 'none', sort_order: item.sort_order, modifier_groups: publicModifierGroups(item.modifier_groups, stoppedProductIds, modifierImages), iiko: true,
  })) : localProducts.rows.map((item) => ({ ...item, category_ids: [`local:${item.category}`] }));
  const visibleProductIds = new Set(products.map((item) => String(item.id)));
  const fallbackCategories = [];
  for (const product of products) {
    const names = arrayValue(product.categories).length ? product.categories : [product.category];
    const ids = arrayValue(product.category_ids).length ? product.category_ids : names.map((name) => `local:${name}`);
    names.forEach((name, index) => {
      const id = String(ids[index] ?? `local:${name}`);
      let category = fallbackCategories.find((item) => item.id === id);
      if (!category) { category = { id, name: String(name), productIds: [] }; fallbackCategories.push(category); }
      if (!category.productIds.includes(String(product.id))) category.productIds.push(String(product.id));
    });
  }
  const categories = !demoMode && iikoProducts.rowCount && iikoCategories.rowCount ? iikoCategories.rows.map((category) => ({
    id: String(category.category_id),
    name: String(category.name),
    productIds: iikoCategoryItems.rows.filter((item) => item.category_id === category.category_id && visibleProductIds.has(String(item.product_id))).map((item) => String(item.product_id)),
  })).filter((category) => category.productIds.length) : fallbackCategories;
  if (demoMode) await pool.query(`update customer_orders set status_step=least(4,floor(extract(epoch from now()-created_at)/5)::int),updated_at=now()
    where terminal_id=$1 and is_demo=true and completed_at is null and status_step<4`, [terminalId]);
  const orders = await pool.query('select order_number, items, total, status_step, table_number, created_at from customer_orders where terminal_id = $1 and is_demo=$2 and completed_at is null and created_at > now() - interval \'4 hours\' order by created_at desc', [terminalId, demoMode]);
  const publicBanners = demoMode ? localProducts.rows.slice(0, 3).map((item, index) => ({ id: `demo-${index}`, name: item.name, image_url: item.image, product_id: item.id, kind: 'restaurant', active: true, starts_at: null, ends_at: null, impression_limit: null, impressions: 0, sort_order: index })) : banners.rows.filter((item) => !item.product_id || !stoppedProductIds.has(String(item.product_id)));
  return { products, categories, banners: publicBanners, terminal: { ...terminal.rows[0], table_number: effectiveTable, table_source: fixedTable ? 'admin' : (chosen ? (chosen.source === 'qr' ? 'qr' : 'guest') : null), table_id: fixedTable ? (fixedTableId || null) : (chosen?.table_id ?? null) }, orders: orders.rows, settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])), catalogRevision: String(revision.rows[0]?.revision ?? '') };
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
const demoModifierId = (productId, name) => deterministicUuid(`demo-modifier:${productId}:${name}`);
const demoSauceImages = new Map([
  ['айоли', '/images/sauces/aioli.webp'], ['брусничный', '/images/sauces/lingonberry.webp'], ['горчичный', '/images/sauces/mustard.webp'],
  ['йогуртовый', '/images/sauces/yogurt.webp'], ['кетчуп', '/images/sauces/ketchup.webp'], ['кисло-сладкий', '/images/sauces/sweet-sour.webp'],
  ['майонез', '/images/sauces/mayonnaise.webp'], ['песто', '/images/sauces/pesto.webp'], ['руй', '/images/sauces/rouille.webp'],
  ['сладкий-чили', '/images/sauces/sweet-chili.webp'], ['чили-сладкий', '/images/sauces/sweet-chili.webp'], ['сметана', '/images/sauces/sour-cream.webp'],
  ['bbq', '/images/sauces/barbecue.webp'], ['гриль', '/images/sauces/grill.webp'], ['сырный', '/images/sauces/cheese.webp'],
  ['тартар', '/images/sauces/tartar.webp'], ['цезарь', '/images/sauces/caesar.webp'], ['чесночный', '/images/sauces/garlic.webp'],
  ['чипотле', '/images/sauces/chipotle.webp'], ['шашлычный', '/images/sauces/shashlik.webp'],
]);
const demoModifierGroups = (product) => {
  const sauces = arrayValue(product.sauce_options).map((name) => String(name).trim()).filter(Boolean);
  if (!sauces.length) return [];
  const price = Math.max(0, Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0);
  return [{
    name: 'Соусы', minQuantity: 0, maxQuantity: sauces.length, freeQuantity: 0,
    items: sauces.map((name) => ({ productId: demoModifierId(product.id, name), name, price, image: demoSauceImages.get(modifierImageNameKey(name)) || '/images/sauce-fallback.webp', defaultQuantity: 0, minQuantity: 0, maxQuantity: 1 })),
  }];
};

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
    const allowedModifiers = new Map(arrayValue(product.sauce_options).map((name) => {
      const normalizedName = String(name).trim();
      return [demoModifierId(product.id, normalizedName), normalizedName];
    }));
    const modifierPrice = Math.max(0, Number.parseInt(product.sauce_addon_price_rub ?? '0', 10) || 0);
    const modifiers = arrayValue(line.modifiers).map((modifier) => {
      const productId = String(modifier?.productId ?? '');
      const name = allowedModifiers.get(productId);
      const amount = Number(modifier?.amount ?? 1);
      if (!name || !Number.isInteger(amount) || amount !== 1) throw Object.assign(new Error('Некорректная добавка'), { status: 400 });
      return { productId, name, amount, price: modifierPrice, image: '/images/sauce-fallback.webp', maxQuantity: 1 };
    });
    const itemPrice = Number(product.price_rub) + modifiers.reduce((sum, modifier) => sum + modifier.price * modifier.amount, 0);
    subtotal += itemPrice * quantity;
    return { key: ['product', product.id, addon, flavor, ...modifiers.map((modifier) => modifier.productId)].filter(Boolean).join('|'), productId: product.id, kind: 'product', customName: product.name, customPrice: Number(product.price_rub), ...(addon ? { addon } : {}), ...(flavor ? { flavor } : {}), ...(modifiers.length ? { modifiers } : {}), quantity };
  });
  const promotion = await resolvePromotion(input.promo_code, subtotal);
  return { items, total: Math.max(0, subtotal - (promotion?.discount ?? 0)), promoCode: promotion?.code ?? '', promotion };
};
const normalizeIikoOrder = async (input) => {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) throw Object.assign(new Error('Некорректный состав заказа'), { status: 400 });
  const ids = [...new Set(input.items.filter((line) => line?.kind !== 'sauce').map((line) => String(line?.productId ?? '')).filter(Boolean))];
  const result = await pool.query(`select m.*, exists(select 1 from iiko_stop_list_items s where s.organization_id=$1 and s.terminal_group_id=$2 and s.product_id=m.product_id and s.balance<=0) as stopped from iiko_menu_items m where m.product_id = any($3::text[]) and not m.is_hidden`, [iikoOrganizationId, iikoTerminalGroupId, ids]);
  const products = new Map(result.rows.map((item) => [item.product_id, item]));
  if (products.size !== ids.length) throw Object.assign(new Error('Одно из блюд больше недоступно'), { status: 409 });
  const modifierImageRows = await pool.query(`select m.product_id,m.name,coalesce(mp.image,p.image,m.image_url,'') as image
    from iiko_menu_items m left join iiko_product_presentations p on p.restaurant_id=$1 and p.sku=m.sku
    left join iiko_modifier_presentations mp on mp.restaurant_id=$1 and mp.modifier_id=m.product_id
    where coalesce(mp.image,p.image,m.image_url,'') <> ''`, [iikoOrganizationId]);
  const dedicatedModifierImages = await pool.query('select modifier_id,name,image from iiko_modifier_presentations where restaurant_id=$1 and image<>\'\'', [iikoOrganizationId]);
  const modifierImages = new Map(modifierImageRows.rows.flatMap((item) => {
    const image = String(item.image ?? '');
    return [[String(item.product_id), image], [`name:${modifierImageNameKey(item.name)}`, image]];
  }));
  for (const item of dedicatedModifierImages.rows) modifierImages.set(String(item.modifier_id), String(item.image));
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
          maxQuantity: Math.min(20, Number(modifierRestrictions(modifier.restrictions).maxQuantity ?? 0) || Number(group?.restrictions?.maxQuantity ?? 20) || 20),
        });
      }
    }
    const modifiers = arrayValue(line.modifiers).map((modifier) => {
      const productId = String(modifier?.productId ?? '');
      const binding = allowedModifiers.get(productId);
      const modifierItem = binding?.item;
      const modifierAmount = Number(modifier?.amount ?? 1);
      if (!modifierItem || !Number.isInteger(modifierAmount) || modifierAmount < 1 || modifierAmount > binding.maxQuantity) throw Object.assign(new Error('Некорректное количество добавки'), { status: 400 });
      return {
        productId,
        amount: modifierAmount,
        name: String(modifierItem.name ?? ''),
        price: iikoPrice(modifierItem),
        image: String(modifierImages.get(productId) || modifierImages.get(`name:${modifierImageNameKey(modifierItem.name)}`) || modifierItem.buttonImageUrl || '/images/sauce-fallback.webp'),
        maxQuantity: binding.maxQuantity,
        ...(binding.productGroupId ? { productGroupId: binding.productGroupId } : {}),
      };
    });
    total += (Number(product.price_rub) + modifiers.reduce((sum, modifier) => sum + modifier.price * modifier.amount, 0)) * amount;
    items.push({ key: `product|${product.product_id}|${modifiers.map((modifier) => modifier.productId).join(',')}`, productId: product.product_id, kind: 'product', customName: product.name, customPrice: Number(product.price_rub), quantity: amount, ...(modifiers.length ? { modifiers } : {}) });
  }
  if (!items.length) throw Object.assign(new Error('В заказе нет блюд'), { status: 400 });
  const subtotal = Math.round(total);
  const promotion = await resolvePromotion(input.promo_code, subtotal);
  return {
    items,
    total: Math.max(0, subtotal - (promotion?.discount ?? 0)),
    promoCode: promotion?.code ?? '',
    promotion,
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
    const fixedId = String(terminal.table_id ?? '').trim();
    const table = fixedId
      ? await pool.query('select * from iiko_tables where terminal_group_id=$1 and table_id=$2 limit 1', [iikoTerminalGroupId, fixedId])
      : await pool.query('select * from iiko_tables where terminal_group_id=$1 and table_number=$2 limit 1', [iikoTerminalGroupId, fixed]);
    if (!table.rowCount) throw Object.assign(new Error('Стол из настроек терминала не найден в iiko'), { status: 409 });
    return table.rows[0];
  }
  const selection = await pool.query(`select s.*,q.is_active as qr_active,q.restaurant_id as qr_restaurant_id
    from terminal_table_selections s left join table_qr_codes q on q.id=s.qr_code_id where s.terminal_id=$1`, [terminal.id]);
  if (!selection.rowCount) throw Object.assign(new Error('Перед заказом выберите стол'), { status: 409 });
  if (String(terminal.id).startsWith('qr_') && (selection.rows[0].source !== 'qr' || selection.rows[0].qr_active !== true || selection.rows[0].qr_restaurant_id !== iikoOrganizationId)) {
    throw Object.assign(new Error('QR-код этого стола больше не активен'), { status: 409 });
  }
  return selection.rows[0];
};
const createIikoOrder = async ({ id = crypto.randomUUID(), number, table, items, comment, promotion = null, servicePrint = true, sourceKey = iikoOrderSourceKey }) => {
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
      sourceKey,
      items,
      ...(promotion ? { discountsInfo: { discounts: [{ type: 'RMS', discountTypeId: promotion.iikoDiscountTypeId }] } } : {}),
      comment: String(comment ?? '').slice(0, 1000),
    },
    createOrderSettings: {
      servicePrint,
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

const backupState = async () => {
  try {
    const files = (await fs.readdir(backupDir)).filter(isDatabaseBackupFileName).sort().reverse();
    if (!files.length) return { status: 'failed', last_at: null, age_hours: null, file: null };
    const file = files[0]; const stat = await fs.stat(pathModule.join(backupDir, file));
    const ageHours = Math.round((Date.now() - stat.mtimeMs) / 36_000) / 100;
    return { status: ageHours <= 36 ? 'passed' : ageHours <= 48 ? 'warning' : 'failed', last_at: stat.mtime.toISOString(), age_hours: ageHours, file };
  } catch { return { status: 'failed', last_at: null, age_hours: null, file: null }; }
};
const automatedQualityState = async () => {
  try {
    const report = JSON.parse(await fs.readFile(qualityReportPath, 'utf8'));
    return { status: report.status ?? 'unknown', commit: report.commit ?? null, passed: Number(report.passed ?? 0), failed: Number(report.failed ?? 0), duration_ms: report.durationMs ?? null, created_at: report.createdAt ?? null };
  } catch { return { status: 'unknown', commit: null, passed: 0, failed: 0, duration_ms: null, created_at: null }; }
};
const publicTelegramSettings = async () => {
  const config = await telegramConfig(); const chat = String(config.row?.chat_id ?? '');
  return { configured: Boolean(config.token && chat), enabled: config.row?.enabled === true, chat_id_masked: chat ? `${chat.slice(0, Math.min(4, chat.length))}${chat.length > 4 ? '••••' : ''}` : '', last_test_at: config.row?.last_test_at ?? null, last_success_at: config.row?.last_success_at ?? null, last_error: config.row?.last_error ?? null };
};
const latestSafeRun = async () => {
  const result = await pool.query("select status,passed,failed,summary,created_at from quality_runs where kind='safe' order by created_at desc limit 1");
  const row = result.rows[0];
  return row ? { status: row.status, passed: Number(row.passed), failed: Number(row.failed), created_at: row.created_at, checks: row.summary?.checks ?? [] } : { status: 'unknown', passed: 0, failed: 0, created_at: null, checks: [] };
};
const latestExtendedRun = async (kind) => {
  const result = await pool.query('select status,summary,created_at from quality_runs where kind=$1 order by created_at desc limit 1', [kind]); const row = result.rows[0];
  return row ? { status: row.status, created_at: row.created_at, detail: String(row.summary?.detail ?? '') } : { status: 'unknown', created_at: null, detail: kind === 'smoke' ? 'Запускается только с явным подтверждением' : 'Ещё не запускался' };
};
const securityOverview = async () => {
  const [telegram, automated, safeRun, smoke, load, backup] = await Promise.all([publicTelegramSettings(), automatedQualityState(), latestSafeRun(), latestExtendedRun('smoke'), latestExtendedRun('load'), backupState()]);
  return { generated_at: new Date().toISOString(), telegram, automated, safe_run: { status: safeRun.status, passed: safeRun.passed, failed: safeRun.failed, created_at: safeRun.created_at }, smoke, load, checks: safeRun.checks, backup };
};
const runSafeChecks = async () => {
  const started = Date.now(); const checks = [];
  const check = async (id, name, task, warning = false) => {
    try { const detail = await task(); checks.push({ id, name, status: 'passed', detail: String(detail) }); }
    catch (error) { checks.push({ id, name, status: warning ? 'warning' : 'failed', detail: String(error.message ?? error) }); }
  };
  await check('api', 'API приложения', async () => `Процесс работает · uptime ${Math.floor(process.uptime() / 60)} мин`);
  await check('database', 'База данных', async () => { const startedAt = Date.now(); await pool.query('select 1'); return `Ответ ${Date.now() - startedAt} мс`; });
  await check('disk', 'Диск сервера', async () => {
    const stat = await fs.statfs('/');
    const usedPercent = Math.round((1 - Number(stat.bavail) / Number(stat.blocks)) * 100);
    if (usedPercent >= 85) throw new Error(`Заполнено ${usedPercent}%`);
    return `Заполнено ${usedPercent}%`;
  });
  await check('menu', 'Меню и SKU', async () => {
    const result = await pool.query('select product_id,sku,is_hidden,updated_at from iiko_menu_items');
    const publication = validateMenuPublication(result.rows.map((row) => ({ sku: row.sku, isHidden: row.is_hidden })));
    if (!publication.ok || !publication.visible) throw new Error(publication.visible ? `${publication.missingSku} без SKU, ${publication.duplicateSkus.length} дублей` : 'Нет активного меню');
    const newest = Math.max(...result.rows.map((row) => new Date(row.updated_at).getTime()).filter(Number.isFinite));
    const ageMinutes = newest ? Math.floor((Date.now() - newest) / 60_000) : 999999;
    if (ageMinutes >= 30) throw new Error(`Снимок меню не обновлялся ${ageMinutes} мин`);
    return `${publication.visible} позиций, SKU корректны · обновлено ${ageMinutes} мин назад`;
  });
  await check('tables', 'Столы iiko', async () => { const result = await pool.query('select count(*)::int as count from iiko_tables where organization_id=$1 and terminal_group_id=$2', [iikoOrganizationId, iikoTerminalGroupId]); if (!result.rows[0].count) throw new Error('Столы не загружены'); return `${result.rows[0].count} столов`; });
  await check('stop-list', 'Стоп-лист', async () => { const result = await pool.query('select count(*)::int as count,max(updated_at) as updated_at from iiko_stop_list_items where organization_id=$1', [iikoOrganizationId]); return `${result.rows[0].count} ограничений, снимок читается`; });
  await check('orders', 'Заказы и повторы', async () => { const result = await pool.query("select count(*)::int as count from order_requests where status='failed' and updated_at>now()-interval '24 hours'"); if (result.rows[0].count) throw new Error(`${result.rows[0].count} ошибок за сутки`); return 'Ошибок отправки за сутки нет'; });
  await check('webhook', 'Webhook iiko', async () => { const result = await pool.query('select max(received_at) as at from iiko_webhook_events'); return result.rows[0].at ? `Последнее событие ${new Date(result.rows[0].at).toLocaleString('ru-RU')}` : 'Webhook настроен, событий ещё не было'; }, true);
  await check('backup', 'Резервная копия', async () => { const backup = await backupState(); if (backup.status === 'failed') throw new Error('Свежая копия не найдена'); return `${backup.file}, ${backup.age_hours} ч. назад`; });
  await check('telegram', 'Telegram', async () => { const value = await publicTelegramSettings(); if (!value.configured || !value.enabled) throw new Error('Уведомления не подключены'); return 'Подключён и включён'; }, true);
  const failed = checks.filter((item) => item.status === 'failed').length; const warnings = checks.filter((item) => item.status === 'warning').length; const status = failed ? 'failed' : warnings ? 'warning' : 'passed';
  await pool.query('insert into quality_runs(kind,status,duration_ms,passed,failed,summary) values($1,$2,$3,$4,$5,$6)', ['safe', status, Date.now() - started, checks.filter((item) => item.status === 'passed').length, failed, JSON.stringify({ checks, warnings })]);
  return securityOverview();
};
const runInternalLoadTest = async () => {
  const started = Date.now(); const clients = 50; const requestsPerClient = 10; let failed = 0;
  await Promise.all(Array.from({ length: clients }, async () => {
    for (let index = 0; index < requestsPerClient; index += 1) {
      try { await pool.query(index % 2 ? 'select count(*) from iiko_menu_items where not is_hidden' : 'select count(*) from terminals where is_active=true'); }
      catch { failed += 1; }
    }
  }));
  const duration = Date.now() - started; const detail = `${clients} клиентов · ${clients * requestsPerClient} запросов · ${duration} мс`;
  const status = failed ? 'failed' : duration > 10_000 ? 'warning' : 'passed';
  await pool.query('insert into quality_runs(kind,status,duration_ms,passed,failed,summary) values($1,$2,$3,$4,$5,$6)', ['load', status, duration, clients * requestsPerClient - failed, failed, JSON.stringify({ detail, clients, requests: clients * requestsPerClient })]);
  if (failed) void notifyTelegramAlert('load', `Нагрузочная проверка: ${failed} ошибок из ${clients * requestsPerClient}`);
  return securityOverview();
};
const runIikoSmokeTest = async (tableId, productId) => {
  const table = await pool.query('select * from iiko_tables where table_id=$1 and organization_id=$2 and terminal_group_id=$3', [tableId, iikoOrganizationId, iikoTerminalGroupId]);
  const product = await pool.query('select product_id,name,price_rub from iiko_menu_items where product_id=$1 and not is_hidden', [productId]);
  if (!table.rowCount || !product.rowCount) throw Object.assign(new Error('Тестовый стол или блюдо отсутствуют в актуальных данных iiko'), { status: 409 });
  const number = `TEST-${Date.now().toString(36).toUpperCase()}`; const started = Date.now();
  try {
    const result = await createIikoOrder({ number, table: table.rows[0], items: [{ type: 'Product', productId, amount: 1, price: Number(product.rows[0].price_rub) }], comment: 'АВТОТЕСТ — НЕ ГОТОВИТЬ', servicePrint: false, sourceKey: 'BrooklynBowl Smoke Test' });
    const detail = `${number} · ${product.rows[0].name} · печать кухни отключена`;
    await pool.query('insert into quality_runs(kind,status,duration_ms,passed,failed,summary) values($1,$2,$3,1,0,$4)', ['smoke', 'passed', Date.now() - started, JSON.stringify({ detail, iikoOrderId: result.id, tableId, productId })]);
    return securityOverview();
  } catch (error) {
    await pool.query('insert into quality_runs(kind,status,duration_ms,passed,failed,summary) values($1,$2,$3,0,1,$4)', ['smoke', 'failed', Date.now() - started, JSON.stringify({ detail: String(error.message ?? error), tableId, productId })]);
    void notifyTelegramAlert('smoke', `Smoke-тест iiko не пройден: ${error.message ?? error}`); throw error;
  }
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

const iikoFrontOverview = async () => {
  const [bridges, employees] = await Promise.all([
    pool.query(`select id,installation_id,display_name,is_active,version,api_version,module_id,terminal_id,last_seen_at,last_sync_at,created_at
      from iiko_front_bridges where restaurant_id=$1 order by created_at desc`, [iikoOrganizationId]),
    pool.query(`select employee_id,display_name,first_name,middle_name,last_name,role_ids,role_names,is_active,app_access_enabled,last_synced_at
      from iiko_employees where restaurant_id=$1 order by is_active desc,display_name`, [iikoOrganizationId]),
  ]);
  return {
    bridges: bridges.rows.map((bridge) => ({ ...bridge, connected: bridgeConnections.connectedForRestaurant(iikoOrganizationId).some((connection) => connection.bridgeId === bridge.id) })),
    employees: employees.rows,
  };
};

const saveIikoEmployee = async (employee, appAccessEnabled = null) => {
  const normalized = normalizeBridgeEmployee(employee);
  const result = await pool.query(`insert into iiko_employees(restaurant_id,employee_id,display_name,first_name,middle_name,last_name,role_ids,role_names,is_active,app_access_enabled)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,false))
    on conflict(restaurant_id,employee_id) do update set display_name=excluded.display_name,first_name=excluded.first_name,middle_name=excluded.middle_name,last_name=excluded.last_name,
      role_ids=excluded.role_ids,role_names=excluded.role_names,is_active=excluded.is_active,last_synced_at=now(),updated_at=now()
    returning *`, [iikoOrganizationId, normalized.id, normalized.displayName, normalized.firstName, normalized.middleName, normalized.lastName, JSON.stringify(normalized.roleIds), JSON.stringify(normalized.roleNames), normalized.isActive, appAccessEnabled]);
  return result.rows[0];
};

const syncIikoEmployees = async (bridgeId, values) => {
  const employees = validateEmployeeSnapshot(values);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const employee of employees) {
      await client.query(`insert into iiko_employees(restaurant_id,employee_id,display_name,first_name,middle_name,last_name,role_ids,role_names,is_active)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict(restaurant_id,employee_id) do update set display_name=excluded.display_name,first_name=excluded.first_name,middle_name=excluded.middle_name,last_name=excluded.last_name,
          role_ids=excluded.role_ids,role_names=excluded.role_names,is_active=excluded.is_active,last_synced_at=now(),updated_at=now()`, [iikoOrganizationId, employee.id, employee.displayName, employee.firstName, employee.middleName, employee.lastName, JSON.stringify(employee.roleIds), JSON.stringify(employee.roleNames), employee.isActive]);
    }
    const ids = employees.map((employee) => employee.id);
    await client.query(`update iiko_employees set is_active=false,updated_at=now() where restaurant_id=$1 and not(employee_id=any($2::text[]))`, [iikoOrganizationId, ids]);
    await client.query(`update waiter_profiles w set is_active=e.is_active and e.app_access_enabled,display_name=e.display_name,updated_at=now()
      from iiko_employees e where w.restaurant_id=e.restaurant_id and w.iiko_employee_id=e.employee_id and e.restaurant_id=$1`, [iikoOrganizationId]);
    await client.query('update iiko_front_bridges set last_sync_at=now(),last_seen_at=now(),updated_at=now() where id=$1 and restaurant_id=$2', [bridgeId, iikoOrganizationId]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  return employees.length;
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
    if (request.method === 'GET' && path === '/api/v1/catalog/revision') {
      const result = await catalogRevision();
      return json(response, 200, { revision: String(result.rows[0]?.revision ?? '') });
    }
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
        if (String(event?.organizationId ?? '') !== iikoOrganizationId) continue;
        const eventType = String(event?.eventType ?? '');
        if (eventType !== 'TableOrderUpdate' && eventType !== 'TableOrderError' && eventType !== 'StopListUpdate') continue;
        await pool.query('insert into iiko_webhook_events(event_type,organization_id,correlation_id,event_time,payload) values ($1,$2,$3,$4,$5)', [eventType, event.organizationId ?? null, event.correlationId ?? null, event.eventTime ?? null, JSON.stringify(event)]);
        if (event?.eventInfo?.id) await saveIikoOrder(event.eventInfo, { organizationId: event.organizationId ?? iikoOrganizationId, eventType, webhook: true });
        if (eventType === 'StopListUpdate') {
          const terminalGroupIds = arrayValue(event?.eventInfo?.terminalGroupsStopListsUpdates).map((item) => String(item?.id ?? '')).filter(Boolean);
          // Return 200 without waiting for another Cloud API round trip. Slow
          // webhook responses are retried by iiko and can create request bursts.
          void fetchIikoStopLists(terminalGroupIds).catch(async (error) => {
            console.warn('iiko stop-list webhook sync:', error.message);
            await recordMonitoringEvent('webhook', `Стоп-лист: ${error.message}`, { terminalGroupIds }, 'warning');
          });
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
    if (request.method === 'POST' && path === '/api/v1/ota/waiter/update') {
      try {
        const manifest = JSON.parse(await fs.readFile(waiterOtaManifestPath, 'utf8'));
        if (typeof manifest.version !== 'string' || typeof manifest.url !== 'string') throw new Error('Invalid manifest');
        return json(response, 200, manifest);
      } catch {
        return json(response, 200, { version: 'builtin' });
      }
    }
    if (request.method === 'GET' && path.startsWith('/api/v1/apps/install/')) {
      const rawToken = decodeURIComponent(path.slice('/api/v1/apps/install/'.length));
      const id = verifyApplicationDownloadToken(rawToken);
      if (!id) return json(response, 404, { error: 'Ссылка недействительна' });
      const result = await pool.query('select * from application_download_issues where id=$1 and restaurant_id=$2', [id, iikoOrganizationId]);
      const row = result.rows[0];
      const artifact = row ? await applicationArtifact(row.app_kind) : null;
      const available = row?.status === 'issued' && new Date(row.expires_at).getTime() > Date.now() && artifact;
      const appName = applicationArtifacts[row?.app_kind]?.name ?? 'BB Kiosk';
      const safeAppName = htmlText(appName);
      const safeVersion = htmlText(row ? await applicationVersion(row.app_kind) : 'актуальная');
      response.writeHead(available ? 200 : 410, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeAppName}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#000;color:#fff;font-family:Arial,sans-serif}.card{width:min(100%,460px);padding:32px;border-radius:28px;background:#191919;text-align:center}b{display:block;margin-bottom:8px;color:#f33430;font-size:12px;letter-spacing:.16em}h1{margin:0 0 12px;font-size:42px}p{margin:0 0 24px;color:#aaa;line-height:1.5}.button{display:block;width:100%;padding:18px;border-radius:16px;background:#f33430;color:#fff;text-decoration:none;font-weight:800;text-transform:uppercase}</style></head><body><main class="card"><b>ПРИЛОЖЕНИЕ</b><h1>${safeAppName}</h1>${available ? `<p>Версия ${safeVersion}. Ссылка сработает один раз и после скачивания будет заменена.</p><a class="button" href="/api/v1/apps/download/${encodeURIComponent(rawToken)}">Скачать APK</a>` : '<p>Эта ссылка уже использована, отозвана или истекла. Попросите администратора показать новый QR-код.</p>'}</main></body></html>`);
      return;
    }
    if (request.method === 'GET' && path.startsWith('/api/v1/apps/download/')) {
      const rawToken = decodeURIComponent(path.slice('/api/v1/apps/download/'.length));
      const id = verifyApplicationDownloadToken(rawToken);
      if (!id) return json(response, 404, { error: 'Ссылка недействительна' });
      const ipHash = sha256(requestIp(request));
      const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 500);
      const client = await pool.connect();
      let row;
      try {
        await client.query('begin');
        const found = await client.query('select * from application_download_issues where id=$1 and restaurant_id=$2 for update', [id, iikoOrganizationId]);
        row = found.rows[0];
        if (!row) { await client.query('rollback'); return json(response, 404, { error: 'Ссылка недействительна' }); }
        const expired = new Date(row.expires_at).getTime() <= Date.now();
        if (row.status === 'issued' && expired) {
          await client.query("update application_download_issues set status='expired',updated_at=now() where id=$1", [id]);
          await client.query('commit');
          return json(response, 410, { error: 'Срок действия ссылки истёк' });
        }
        const retryWindow = row.status === 'downloaded' && row.download_ip_hash === ipHash && row.download_user_agent === userAgent && Date.now() - new Date(row.downloaded_at).getTime() < 15 * 60_000;
        if (row.status !== 'issued' && !retryWindow) { await client.query('rollback'); return json(response, 410, { error: 'Ссылка уже использована' }); }
        const artifact = await applicationArtifact(row.app_kind);
        if (!artifact) { await client.query('rollback'); return json(response, 503, { error: 'Сборка приложения пока недоступна' }); }
        if (row.status === 'issued') {
          const currentVersion = await applicationVersion(row.app_kind);
          await client.query("update application_download_issues set status='downloaded',version=$1,downloaded_at=now(),download_ip_hash=$2,download_user_agent=$3,updated_at=now() where id=$4", [currentVersion, ipHash, userAgent, id]);
          const duration = Math.max(60 * 60_000, Math.min(7 * 24 * 60 * 60_000, new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()));
          await client.query(`insert into application_download_issues(id,restaurant_id,app_kind,label,status,version,expires_at,created_by)
            values($1,$2,$3,$4,'issued',$5,$6,'automatic-rotation')`, [crypto.randomUUID(), iikoOrganizationId, row.app_kind, row.label, currentVersion, new Date(Date.now() + duration)]);
        }
        await client.query('commit');
        response.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': artifact.size,
          'Content-Disposition': `attachment; filename="${artifact.filename}"`, 'Cache-Control': 'no-store',
        });
        createReadStream(artifact.filePath).on('error', () => response.destroy()).pipe(response);
        return;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    }
    if (request.method === 'POST' && path === '/api/v1/qr/resolve') {
      const body = await readBody(request);
      const parsed = verifyQrToken(body.token);
      const deviceId = String(body.device_id ?? '');
      if (!parsed || !/^[a-zA-Z0-9_-]{8,80}$/.test(deviceId)) return json(response, 400, { error: 'QR-код повреждён или имеет неверный формат' });
      enforceRequestRate(`qr-resolve:${requestIp(request)}:${parsed.id}`, 30, 5 * 60_000);
      const code = await pool.query(`select * from table_qr_codes where id=$1 and restaurant_id=$2 and token_version=$3 and is_active=true`, [parsed.id, iikoOrganizationId, parsed.version]);
      if (!code.rowCount) return json(response, 410, { error: 'Этот QR-код больше не активен. Попросите сотрудника ресторана заменить его.' });
      const table = await pool.query(`select * from iiko_tables where table_id=$1 and organization_id=$2 and terminal_group_id=$3`, [code.rows[0].table_id, iikoOrganizationId, iikoTerminalGroupId]);
      if (!table.rowCount) return json(response, 409, { error: 'Стол из QR-кода не найден в актуальной схеме iiko' });
      const selected = table.rows[0];
      const qrTerminalId = `qr_${sha256(`${iikoOrganizationId}:${parsed.id}:${deviceId}`).slice(0, 48)}`;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`insert into terminals(id,label,is_active) values($1,$2,true)
          on conflict(id) do update set label=excluded.label,is_active=true,last_seen_at=now(),updated_at=now()`, [qrTerminalId, `QR · Стол №${selected.table_number}`]);
        await client.query(`insert into terminal_table_selections(terminal_id,table_id,table_number,table_name,source,qr_code_id) values($1,$2,$3,$4,'qr',$5)
          on conflict(terminal_id) do update set table_id=excluded.table_id,table_number=excluded.table_number,table_name=excluded.table_name,source='qr',qr_code_id=excluded.qr_code_id,selected_at=now(),updated_at=now()`, [qrTerminalId, selected.table_id, selected.table_number, selected.table_name, parsed.id]);
        await client.query(`update table_qr_codes set scans_count=scans_count+1,last_scanned_at=now(),table_number=$1,table_name=$2,section_name=$3,updated_at=now() where id=$4`, [selected.table_number, selected.table_name, selected.section_name, parsed.id]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
      await publishEvent('qr_session_opened', 'table_qr', parsed.id, { tableNumber: selected.table_number, terminalId: qrTerminalId });
      return json(response, 200, { terminal_id: qrTerminalId, source: 'qr', table: { table_id: selected.table_id, table_number: selected.table_number, table_name: selected.table_name, section_name: selected.section_name } });
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
    if (request.method === 'POST' && path === '/api/v1/promotions/validate') {
      enforceRequestRate(`promotion:${requestIp(request)}`, 30, 60_000);
      const body = await readBody(request);
      const promotion = await resolvePromotion(body.code, body.subtotal);
      if (!promotion) return json(response, 400, { error: 'Введите промокод' });
      return json(response, 200, { code: promotion.code, name: promotion.name, discountType: promotion.discountType, value: promotion.value, discount: promotion.discount });
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
    if (request.method === 'POST' && path === '/api/v1/iiko-front/pair') {
      enforceRequestRate(`iiko-front-pair:${requestIp(request)}`, 10, 10 * 60_000);
      const body = await readBody(request);
      const code = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const installationId = String(body.installationId ?? '').trim();
      if (!/^[A-Z0-9]{8}$/.test(code) || !/^[a-zA-Z0-9._-]{8,160}$/.test(installationId)) return json(response, 400, { error: 'Проверьте код сопряжения и ID установки' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const pairing = await client.query(`select * from iiko_front_pairing_codes where code_hash=$1 and used_at is null and expires_at>now() for update`, [sha256(code)]);
        if (!pairing.rowCount) { await client.query('rollback'); return json(response, 401, { error: 'Код сопряжения неверен или истёк' }); }
        const token = crypto.randomBytes(32).toString('base64url');
        const id = crypto.randomUUID();
        const bridge = await client.query(`insert into iiko_front_bridges(id,restaurant_id,installation_id,display_name,token_hash,version,api_version,module_id,terminal_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict(restaurant_id,installation_id) do update set display_name=excluded.display_name,token_hash=excluded.token_hash,version=excluded.version,
            api_version=excluded.api_version,module_id=excluded.module_id,terminal_id=excluded.terminal_id,is_active=true,updated_at=now()
          returning id`, [id, pairing.rows[0].restaurant_id, installationId, String(body.displayName ?? 'iikoFront').trim().slice(0, 160) || 'iikoFront', sha256(token), String(body.version ?? '').slice(0, 40), String(body.apiVersion ?? 'V8').slice(0, 20), Number.isInteger(Number(body.moduleId)) ? Number(body.moduleId) : null, String(body.terminalId ?? '').slice(0, 160)]);
        await client.query('update iiko_front_pairing_codes set used_at=now() where id=$1', [pairing.rows[0].id]);
        await client.query('commit');
        return json(response, 201, { bridgeId: bridge.rows[0].id, token, websocketUrl: `${publicAppUrl.replace(/^http/, 'ws')}/api/v1/iiko-front/connect` });
      } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
      finally { client.release(); }
    }
    if (request.method === 'POST' && path === '/api/v1/waiter/login') {
      const body = await readBody(request); const pin = String(body.pin ?? '');
      const attemptKey = authAttemptKey(request, 'waiter');
      await assertAuthAllowed(attemptKey);
      if (!/^\d{4,12}$/.test(pin)) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный PIN-код' }); }
      const paired = await pool.query('select exists(select 1 from iiko_front_bridges where restaurant_id=$1 and is_active=true) as configured', [iikoOrganizationId]);
      let waiter;
      if (paired.rows[0].configured) {
        const auth = await bridgeConnections.requestAuthentication(iikoOrganizationId, pin);
        if (!auth.ok) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный PIN-код' }); }
        const employee = await saveIikoEmployee(auth.employee);
        if (!employee.is_active || !employee.app_access_enabled) { await recordAuthFailure(attemptKey); return json(response, 403, { error: 'Доступ к приложению не выдан. Обратитесь к администратору' }); }
        const waiterResult = await pool.query(`insert into waiter_profiles(id,restaurant_id,display_name,iiko_employee_id,auth_source,is_active,pin_hash)
          values($1,$2,$3,$4,'iiko',$5,null) on conflict(restaurant_id,iiko_employee_id) where iiko_employee_id is not null
          do update set display_name=excluded.display_name,is_active=excluded.is_active,pin_hash=null,auth_source='iiko',updated_at=now()
          returning id,display_name`, [crypto.randomUUID(), iikoOrganizationId, employee.display_name, employee.employee_id, employee.app_access_enabled && employee.is_active]);
        waiter = waiterResult.rows[0];
      } else {
        const waiterCandidates = await pool.query("select id,display_name,pin_hash from waiter_profiles where restaurant_id=$1 and is_active=true and auth_source='local'", [iikoOrganizationId]);
        waiter = waiterCandidates.rows.find((profile) => passwordMatches(pin, profile.pin_hash));
      }
      if (!waiter) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный PIN-код' }); }
      await clearAuthFailures(attemptKey);
      return json(response, 200, { token: sign({ waiterId: waiter.id, role: 'waiter', exp: Date.now() + 12 * 60 * 60 * 1000 }), waiter: { id: waiter.id, name: waiter.display_name } });
    }
    if (request.method === 'GET' && path === '/api/v1/waiter/queue') {
      const waiter = await requireWaiter(request);
      const [requests, orders] = await Promise.all([
        pool.query(`select id,table_number,request_type,status,created_at,accepted_by,accepted_at from service_requests
          where restaurant_id=$1 and status in ('new','accepted','in_progress') and (assigned_waiter_id is null or assigned_waiter_id=$2)
            and (accepted_by is null or accepted_by=$2) and created_at > now()-interval '8 hours' order by created_at desc`, [iikoOrganizationId, waiter.waiterId]),
        pool.query(`select order_number,table_number,items,total,comment,status_step,created_at,source from customer_orders
          where restaurant_id=$1 and is_demo=false and completed_at is null and (assigned_waiter_id is null or assigned_waiter_id=$2)
            and created_at > now()-interval '8 hours' order by created_at desc`, [iikoOrganizationId, waiter.waiterId]),
      ]);
      return json(response, 200, { requests: requests.rows, orders: orders.rows, waiter: { id: waiter.waiterId, name: waiter.waiterName }, serverTime: new Date().toISOString() });
    }
    if (request.method === 'POST' && path === '/api/v1/waiter/devices') {
      const waiter = await requireWaiter(request); const body = await readBody(request); const deviceToken = String(body.token ?? '');
      if (deviceToken.length < 32 || deviceToken.length > 4096) return json(response, 400, { error: 'Некорректный токен устройства' });
      await pool.query(`insert into waiter_devices(waiter_id,token,platform) values($1,$2,$3) on conflict(token) do update set waiter_id=excluded.waiter_id,platform=excluded.platform,is_active=true,last_seen_at=now()`, [waiter.waiterId, deviceToken, String(body.platform ?? 'android')]);
      return json(response, 204, {});
    }
    if (request.method === 'DELETE' && path === '/api/v1/waiter/devices') {
      const waiter = await requireWaiter(request); const body = await readBody(request); const deviceToken = String(body.token ?? '');
      if (deviceToken) await pool.query('update waiter_devices set is_active=false,last_seen_at=now() where waiter_id=$1 and token=$2', [waiter.waiterId, deviceToken]);
      return json(response, 204, {});
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/accept')) {
      const waiter = await requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/accept'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный вызов' });
      const result = await pool.query(`update service_requests set status='accepted',accepted_by=$1,accepted_at=now()
        where id=$2 and restaurant_id=$3 and status='new' and (assigned_waiter_id is null or assigned_waiter_id=$1) returning *`, [waiter.waiterId, id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 409, { error: 'Этот вызов уже принял другой официант' });
      await publishEvent('waiter_request_accepted', 'service_request', String(id), { waiterId: waiter.waiterId, tableNumber: result.rows[0].table_number });
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/complete')) {
      const waiter = await requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/complete'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный вызов' });
      const result = await pool.query(`update service_requests set status='completed',handled_at=now(),completed_at=now(),completed_by=$1 where id=$2 and restaurant_id=$3 and status in ('accepted','in_progress') and accepted_by=$1 returning *`, [waiter.waiterId, id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 409, { error: 'Вызов не найден или назначен другому официанту' });
      await publishEvent('waiter_request_completed', 'service_request', String(id), { waiterId: waiter.waiterId, tableNumber: result.rows[0].table_number });
      await closeGuestSessionIfIdle(result.rows[0].guest_session_id, 'service_completed');
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/waiter/requests/') && path.endsWith('/start')) {
      const waiter = await requireWaiter(request); const id = Number(path.slice('/api/v1/waiter/requests/'.length, -'/start'.length));
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
      const demoMode = terminal.rows[0].demo_mode === true;
      const orderSource = String(body.terminal_id).startsWith('qr_') ? 'qr' : 'tablet';
      const useIiko = !demoMode && (await pool.query('select count(*)::int as count from iiko_menu_items')).rows[0].count > 0;
      const order = useIiko ? await normalizeIikoOrder(body) : await normalizeOrder(body);
      const table = useIiko || demoMode ? await effectiveTableForTerminal(terminal.rows[0]) : { table_number: terminal.rows[0].table_number };
      const clientRequestId = String(body.client_request_id ?? '').trim();
      if (clientRequestId && !/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) return json(response, 400, { error: 'Некорректный идентификатор отправки' });
      const requestHash = sha256(JSON.stringify({ terminalId: body.terminal_id, table: table.table_number, items: order.items, comment: String(body.comment ?? ''), promoCode: order.promoCode, source: orderSource }));
      let number = clientRequestId ? `${demoMode ? 'D' : 'B'}-${sha256(`${iikoOrganizationId}:${clientRequestId}`).slice(0, 8).toUpperCase()}` : '';
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
      const sessionId = await getOrCreateGuestSession({ terminalId: String(body.terminal_id), source: orderSource, table, metadata: { clientRequestId: clientRequestId || null } });
      let saved;
      let submittedIikoOrderId = null;
      let initialIikoCreationStatus = '';
      try {
        for (let attempt = 0; attempt < (clientRequestId ? 1 : 5); attempt += 1) {
          if (!number) number = `${demoMode ? 'D' : 'B'}-${crypto.randomInt(1000, 10000)}`;
          if (useIiko) {
            const created = await createIikoOrder({ id: clientRequestId ? deterministicUuid(`${iikoOrganizationId}:${clientRequestId}`) : undefined, number, table, items: order.iikoItems, comment: body.comment, promotion: order.promotion });
            submittedIikoOrderId = created.id;
            initialIikoCreationStatus = String(created.response?.creationStatus ?? '');
          }
          try {
            saved = await pool.query('insert into customer_orders(order_number,terminal_id,table_number,items,total,comment,promo_code,iiko_order_id,restaurant_id,guest_session_id,source,client_request_id,is_demo,assigned_waiter_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning order_number, items, total, status_step, table_number, created_at', [number, body.terminal_id, table.table_number, JSON.stringify(order.items), order.total, String(body.comment ?? '').slice(0, 1000), order.promoCode, submittedIikoOrderId, iikoOrganizationId, sessionId, orderSource, clientRequestId || null, demoMode, terminal.rows[0].waiter_id ?? null]);
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
        if (!demoMode && order.promotion?.id) await pool.query('update promotions set uses_count=uses_count+1,updated_at=now() where id=$1', [order.promotion.id]);
        if (clientRequestId) await pool.query(`update order_requests set status='success',order_number=$1,iiko_order_id=$2,updated_at=now() where restaurant_id=$3 and client_request_id=$4`, [saved.rows[0].order_number, submittedIikoOrderId, iikoOrganizationId, clientRequestId]);
      } catch (error) {
        if (clientRequestId) await pool.query(`update order_requests set status='failed',iiko_order_id=coalesce($1,iiko_order_id),error_message=$2,updated_at=now() where restaurant_id=$3 and client_request_id=$4`, [submittedIikoOrderId, String(error.message ?? 'Ошибка отправки').slice(0, 500), iikoOrganizationId, clientRequestId]);
        await closeGuestSessionIfIdle(sessionId, 'order_failed');
        throw error;
      }
      if (!demoMode) {
        await publishEvent('order_created', 'order', saved.rows[0].order_number, { tableNumber: saved.rows[0].table_number, source: orderSource, total: Number(saved.rows[0].total) });
        void notifyWaiters(`Новый заказ · стол №${saved.rows[0].table_number}`, `Заказ ${saved.rows[0].order_number} на ${saved.rows[0].total} ₽`, { type: 'order', orderNumber: saved.rows[0].order_number, tableNumber: saved.rows[0].table_number }, terminal.rows[0].waiter_id ?? null);
      }
      return json(response, 201, saved.rows[0]);
    }
    if (request.method === 'POST' && path === '/api/v1/service-requests') {
      const body = await readBody(request);
      const type = String(body.type ?? '');
      if (!body.terminal_id || !serviceTypes.has(type)) return json(response, 400, { error: 'Некорректный запрос' });
      // Each request type has its own small anti-spam bucket. Asking for a
      // waiter must not block a later request for cutlery or the bill.
      enforceRequestRate(`service:${requestIp(request)}:${String(body.terminal_id)}:${type}`, 3, 5 * 60_000);
      const terminal = await pool.query('select * from terminals where id = $1 and is_active = true', [String(body.terminal_id)]);
      if (!terminal.rowCount) return json(response, 409, { error: 'Терминал временно недоступен' });
      if (terminal.rows[0].demo_mode === true) return json(response, 201, { ok: true, demo: true });
      const table = await effectiveTableForTerminal(terminal.rows[0]);
      const requestSource = String(body.terminal_id).startsWith('qr_') ? 'qr' : 'tablet';
      const sessionId = await getOrCreateGuestSession({ terminalId: String(body.terminal_id), source: requestSource, table });
      const duplicate = await pool.query(`select id from service_requests
        where terminal_id=$1 and request_type=$2 and status in ('new','accepted','in_progress')
          and created_at > now()-interval '30 seconds' order by created_at desc limit 1`, [String(body.terminal_id), type]);
      if (duplicate.rowCount) return json(response, 200, { ok: true, duplicate: true });
      const created = await pool.query('insert into service_requests(terminal_id, table_number, request_type, restaurant_id, guest_session_id, assigned_waiter_id) values ($1,$2,$3,$4,$5,$6) returning id', [String(body.terminal_id), table.table_number, type, iikoOrganizationId, sessionId, terminal.rows[0].waiter_id ?? null]);
      await publishEvent('waiter_called', 'service_request', String(created.rows[0].id), { tableNumber: table.table_number, type });
      void notifyWaiters(`СТОЛ №${table.table_number}`, servicePushText[type] ?? 'Новый вызов за столом', { type: 'service_request', requestId: created.rows[0].id, tableNumber: table.table_number, requestType: type }, terminal.rows[0].waiter_id ?? null);
      return json(response, 201, { ok: true });
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/orders/') && path.endsWith('/complete')) {
      const orderNumber = decodeURIComponent(path.slice('/api/v1/orders/'.length, -'/complete'.length));
      const body = await readBody(request);
      if (!body.terminal_id || !orderNumber) return json(response, 400, { error: 'Некорректный заказ' });
      const result = await pool.query('update customer_orders set completed_at = now(), updated_at = now() where order_number = $1 and terminal_id = $2 and completed_at is null returning guest_session_id,table_number,source,is_demo', [orderNumber, String(body.terminal_id)]);
      if (!result.rowCount) return json(response, 404, { error: 'Заказ не найден или уже завершён' });
      const terminal = await pool.query('select table_number from terminals where id=$1', [String(body.terminal_id)]);
      const remaining = await pool.query('select count(*)::int as count from customer_orders where terminal_id=$1 and is_demo=$2 and completed_at is null', [String(body.terminal_id), result.rows[0].is_demo]);
      if (!String(body.terminal_id).startsWith('qr_') && !String(terminal.rows[0]?.table_number ?? '').trim() && !remaining.rows[0].count) await pool.query('delete from terminal_table_selections where terminal_id=$1', [String(body.terminal_id)]);
      if (!result.rows[0].is_demo) await publishEvent('order_completed', 'order', orderNumber, { tableNumber: result.rows[0].table_number, source: result.rows[0].source });
      await closeGuestSessionIfIdle(result.rows[0].guest_session_id, 'order_completed');
      return json(response, 204, {});
    }
    if (!path.startsWith('/api/v1/admin/')) return json(response, 404, { error: 'Not found' });
    const admin = requireAdmin(request);
    const terminalOnly = request.method === 'PUT' && path.startsWith('/api/v1/admin/terminals/');
    const terminalAllowed = terminalOnly || request.method === 'GET' && path === '/api/v1/admin/waiters';
    if (admin.scope === 'terminal' && !terminalAllowed) throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
    const hostessAllowed = request.method === 'GET' && path === '/api/v1/admin/orders' || terminalOnly;
    if (admin.role === 'hostess' && !hostessAllowed) throw Object.assign(new Error('Недостаточно прав'), { status: 403 });
    const actor = admin.userId ? `admin-user:${admin.userId}` : admin.scope === 'terminal' ? 'terminal-admin' : 'restaurant-admin';
    if (request.method === 'GET' && path === '/api/v1/admin/application-downloads') {
      await pool.query("update application_download_issues set status='expired',updated_at=now() where restaurant_id=$1 and status='issued' and expires_at<=now()", [iikoOrganizationId]);
      const rows = await pool.query('select * from application_download_issues where restaurant_id=$1 order by created_at desc limit 100', [iikoOrganizationId]);
      return json(response, 200, await Promise.all(rows.rows.map(publicApplicationDownload)));
    }
    if (request.method === 'POST' && path === '/api/v1/admin/application-downloads') {
      const body = await readBody(request);
      const appKind = String(body.app_kind ?? '');
      const label = String(body.label ?? '').trim().slice(0, 120);
      const expiresInHours = Number(body.expires_in_hours ?? 24);
      if (!applicationArtifacts[appKind]) return json(response, 400, { error: 'Выберите приложение' });
      if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) return json(response, 400, { error: 'Срок действия должен быть от 1 часа до 7 дней' });
      const artifact = await applicationArtifact(appKind);
      if (!artifact) return json(response, 409, { error: 'APK ещё не опубликован на сервере' });
      const version = await applicationVersion(appKind);
      const client = await pool.connect();
      let created;
      try {
        await client.query('begin');
        await client.query("update application_download_issues set status='expired',updated_at=now() where restaurant_id=$1 and status='issued' and expires_at<=now()", [iikoOrganizationId]);
        await client.query("update application_download_issues set status='revoked',revoked_at=now(),updated_at=now() where restaurant_id=$1 and app_kind=$2 and status='issued'", [iikoOrganizationId, appKind]);
        created = await client.query(`insert into application_download_issues(id,restaurant_id,app_kind,label,status,version,expires_at,created_by)
          values($1,$2,$3,$4,'issued',$5,now()+($6::text||' hours')::interval,$7) returning *`, [crypto.randomUUID(), iikoOrganizationId, appKind, label || applicationArtifacts[appKind].name, version, expiresInHours, actor]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally { client.release(); }
      await audit(actor, 'issue', 'application_download', created.rows[0].id, null, { appKind, label, version, expiresInHours });
      return json(response, 201, await publicApplicationDownload(created.rows[0]));
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/application-downloads/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/application-downloads/'.length));
      const body = await readBody(request); const nextStatus = String(body.status ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || !['installed', 'revoked'].includes(nextStatus)) return json(response, 400, { error: 'Некорректное действие' });
      const before = await pool.query('select * from application_download_issues where id=$1 and restaurant_id=$2', [id, iikoOrganizationId]);
      if (!before.rowCount) return json(response, 404, { error: 'Выдача не найдена' });
      if (nextStatus === 'installed' && before.rows[0].status !== 'downloaded') return json(response, 409, { error: 'Сначала APK должен быть скачан' });
      if (nextStatus === 'revoked' && before.rows[0].status !== 'issued') return json(response, 409, { error: 'Отозвать можно только активный QR-код' });
      const result = await pool.query(`update application_download_issues set status=$1,
        installed_at=case when $1='installed' then now() else installed_at end,
        revoked_at=case when $1='revoked' then now() else revoked_at end,updated_at=now()
        where id=$2 and restaurant_id=$3 returning *`, [nextStatus, id, iikoOrganizationId]);
      await audit(actor, nextStatus, 'application_download', id, before.rows[0], result.rows[0]);
      return json(response, 200, await publicApplicationDownload(result.rows[0]));
    }
    if (request.method === 'GET' && path === '/api/v1/admin/qr-codes') {
      const rows = await pool.query(`select q.*,coalesce(t.table_number,q.table_number) as table_number,coalesce(t.table_name,q.table_name) as table_name,coalesce(t.section_name,q.section_name) as section_name
        from table_qr_codes q left join iiko_tables t on t.table_id=q.table_id and t.organization_id=q.restaurant_id and t.terminal_group_id=$2
        where q.restaurant_id=$1 order by coalesce(t.section_name,q.section_name),coalesce(t.table_number,q.table_number),q.created_at`, [iikoOrganizationId, iikoTerminalGroupId]);
      return json(response, 200, await Promise.all(rows.rows.map(publicQrCode)));
    }
    if (request.method === 'POST' && path === '/api/v1/admin/qr-codes/generate-all') {
      const tables = await pool.query('select * from iiko_tables where organization_id=$1 and terminal_group_id=$2 order by section_name,table_number', [iikoOrganizationId, iikoTerminalGroupId]);
      for (const table of tables.rows) {
        await pool.query(`insert into table_qr_codes(id,restaurant_id,table_id,table_number,table_name,section_name) values($1,$2,$3,$4,$5,$6)
          on conflict(restaurant_id,table_id) do update set table_number=excluded.table_number,table_name=excluded.table_name,section_name=excluded.section_name,updated_at=now()`, [crypto.randomUUID(), iikoOrganizationId, table.table_id, table.table_number, table.table_name, table.section_name]);
      }
      await audit(actor, 'generate_all', 'table_qr', iikoOrganizationId, null, { affected: tables.rowCount });
      const rows = await pool.query('select * from table_qr_codes where restaurant_id=$1 order by section_name,table_number', [iikoOrganizationId]);
      return json(response, 201, await Promise.all(rows.rows.map(publicQrCode)));
    }
    if (request.method === 'POST' && path === '/api/v1/admin/qr-codes') {
      const body = await readBody(request); const tableId = String(body.table_id ?? '');
      const table = await pool.query('select * from iiko_tables where table_id=$1 and organization_id=$2 and terminal_group_id=$3', [tableId, iikoOrganizationId, iikoTerminalGroupId]);
      if (!table.rowCount) return json(response, 409, { error: 'Выбранный стол не найден в актуальной схеме iiko' });
      const selected = table.rows[0];
      const existing = await pool.query('select * from table_qr_codes where restaurant_id=$1 and table_id=$2', [iikoOrganizationId, tableId]);
      if (existing.rowCount) return json(response, 409, { error: 'Для этого стола QR-код уже создан' });
      const result = await pool.query(`insert into table_qr_codes(id,restaurant_id,table_id,table_number,table_name,section_name) values($1,$2,$3,$4,$5,$6) returning *`, [crypto.randomUUID(), iikoOrganizationId, selected.table_id, selected.table_number, selected.table_name, selected.section_name]);
      await audit(actor, 'create', 'table_qr', result.rows[0].id, null, result.rows[0]);
      return json(response, 201, await publicQrCode(result.rows[0]));
    }
    if (request.method === 'POST' && path.startsWith('/api/v1/admin/qr-codes/') && path.endsWith('/regenerate')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/qr-codes/'.length, -'/regenerate'.length));
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(response, 400, { error: 'Некорректный QR-код' });
      const before = await pool.query('select * from table_qr_codes where id=$1 and restaurant_id=$2', [id, iikoOrganizationId]);
      if (!before.rowCount) return json(response, 404, { error: 'QR-код не найден' });
      const result = await pool.query('update table_qr_codes set token_version=token_version+1,is_active=true,updated_at=now() where id=$1 and restaurant_id=$2 returning *', [id, iikoOrganizationId]);
      await audit(actor, 'regenerate', 'table_qr', id, before.rows[0], result.rows[0]);
      return json(response, 200, await publicQrCode(result.rows[0]));
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/qr-codes/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/qr-codes/'.length)); const body = await readBody(request);
      if (!/^[0-9a-f-]{36}$/i.test(id) || typeof body.is_active !== 'boolean') return json(response, 400, { error: 'Некорректный QR-код' });
      const before = await pool.query('select * from table_qr_codes where id=$1 and restaurant_id=$2', [id, iikoOrganizationId]);
      if (!before.rowCount) return json(response, 404, { error: 'QR-код не найден' });
      const result = await pool.query('update table_qr_codes set is_active=$1,updated_at=now() where id=$2 and restaurant_id=$3 returning *', [body.is_active, id, iikoOrganizationId]);
      await audit(actor, body.is_active ? 'activate' : 'deactivate', 'table_qr', id, before.rows[0], result.rows[0]);
      return json(response, 200, await publicQrCode(result.rows[0]));
    }
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
      enforceRequestRate(`iiko-config-discover:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 2, 10 * 60_000);
      const discovered = await discoverIikoCredentials(credentialsForIikoDiscovery(body), configAdmin.userId ?? null);
      await audit(actor, 'discover', 'iiko_connection', 'candidate', null, { organizations: discovered.organizations.map((item) => item.name) });
      return json(response, 200, discovered);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/restaurant-options') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request); const session = requireIikoDiscoverySession(body.discoveryToken, configAdmin);
      enforceRequestRate(`iiko-config-options:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 2, 10 * 60_000);
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
      enforceRequestRate(`iiko-config-test:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 2, 10 * 60_000);
      const result = await testIikoConnection(candidate, session?.accessToken ?? '');
      await audit(actor, 'test', 'iiko_connection', 'candidate', null, { ...result, organizationId: candidate.organizationId, terminalGroupId: candidate.terminalGroupId, externalMenuId: candidate.externalMenuId });
      return json(response, 200, { result, testToken: sign({ configTest: true, configHash: iikoConfigHash(candidate), userId: configAdmin.userId ?? null, result, exp: Date.now() + 5 * 60_000 }) });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-config/apply') {
      const configAdmin = requireIikoConfigAccess(request); const body = await readBody(request);
      const session = body.discoveryToken ? requireIikoDiscoverySession(body.discoveryToken, configAdmin) : null;
      const candidate = session ? configFromIikoDiscovery(session, body) : candidateIikoConfig(body);
      enforceRequestRate(`iiko-config-apply:${requestIp(request)}:${String(configAdmin.userId ?? 'master')}`, 1, 10 * 60_000);
      const tested = verify(body.testToken);
      if (!tested?.configTest || tested.configHash !== iikoConfigHash(candidate) || String(tested.userId ?? '') !== String(configAdmin.userId ?? '')) return json(response, 409, { error: 'Сначала проверьте именно эту конфигурацию ещё раз' });
      const previousRow = iikoConnectionMetadata; const previousConfig = previousRow ? configFromRow(previousRow) : runtimeIikoConfig(); const before = safeIikoConfig(previousRow);
      const encrypted = encryptIikoCredentials({ appId: candidate.appId, apiLogin: candidate.apiLogin, clientSecret: candidate.clientSecret, webhookToken: candidate.webhookToken });
      iikoConfigSwitching = true; let restoreOk = true;
      try {
        const saved = await pool.query(`insert into iiko_connection_settings(id,api_base,organization_id,terminal_group_id,external_menu_id,order_type_id,order_source_key,credentials_ciphertext,credentials_iv,credentials_tag,configured_by,last_test_at,last_test_details)
          values('active',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
          on conflict(id) do update set api_base=excluded.api_base,organization_id=excluded.organization_id,terminal_group_id=excluded.terminal_group_id,external_menu_id=excluded.external_menu_id,order_type_id=excluded.order_type_id,order_source_key=excluded.order_source_key,
          credentials_ciphertext=excluded.credentials_ciphertext,credentials_iv=excluded.credentials_iv,credentials_tag=excluded.credentials_tag,configured_by=excluded.configured_by,last_test_at=excluded.last_test_at,last_test_details=excluded.last_test_details,updated_at=now() returning *`,
        [candidate.apiBase,candidate.organizationId,candidate.terminalGroupId,candidate.externalMenuId,candidate.orderTypeId,candidate.orderSourceKey,encrypted.ciphertext,encrypted.iv,encrypted.tag,actor,JSON.stringify(tested.result ?? {})]);
        iikoConnectionMetadata = saved.rows[0]; applyRuntimeIikoConfig(candidate);
        if (session?.accessToken) {
          iikoAccessToken = session.accessToken;
          iikoAccessTokenExpiresAt = Date.now() + 5 * 60_000;
        }
        const [menuCount, tableCount] = await Promise.all([syncIikoMenu(), syncIikoTables()]);
        await fetchIikoStopLists([candidate.terminalGroupId]);
        const webhookRegistration = await ensureIikoWebhookRegistration(candidate, session?.accessToken ?? '');
        const after = safeIikoConfig(saved.rows[0]); await audit(actor, 'activate', 'iiko_connection', 'active', before, after);
        await publishEvent('iiko_connection_changed', 'iiko_connection', 'active', { actor, organizationId: candidate.organizationId, menuCount, tableCount, webhookRegistered: true, webhookUpdated: webhookRegistration.updated }, candidate.organizationId);
        if (body.discoveryToken) iikoDiscoverySessions.delete(String(body.discoveryToken));
        return json(response, 200, { config: after, sync: { menuItems: menuCount, tables: tableCount }, webhook: { registered: true, updated: webhookRegistration.updated } });
      } catch (error) {
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
        where o.restaurant_id=$1 and o.is_demo=false and ($2='all' or o.completed_at is null) and o.created_at>now()-interval '30 days' order by o.created_at desc limit 250`, [iikoOrganizationId, filter]);
      return json(response, 200, result.rows);
    }
    if (request.method === 'GET' && path === '/api/v1/admin/security') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      return json(response, 200, await securityOverview());
    }
    if (request.method === 'POST' && path === '/api/v1/admin/security/run') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      enforceRequestRate(`security-run:${requestIp(request)}:${String(admin.userId ?? 'master')}`, 6, 10 * 60_000);
      const result = await runSafeChecks(); await audit(actor, 'run', 'security_checks', 'safe', null, { status: result.safe_run.status, passed: result.safe_run.passed, failed: result.safe_run.failed });
      return json(response, 200, result);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/security/load') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      enforceRequestRate(`security-load:${requestIp(request)}:${String(admin.userId ?? 'master')}`, 2, 60 * 60_000);
      const result = await runInternalLoadTest(); await audit(actor, 'run', 'security_checks', 'load', null, { status: result.load.status, detail: result.load.detail });
      return json(response, 200, result);
    }
    if (request.method === 'POST' && path === '/api/v1/admin/security/smoke') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      const body = await readBody(request);
      if (body.confirmation !== 'СОЗДАТЬ ТЕСТОВЫЙ ЗАКАЗ') return json(response, 400, { error: 'Требуется явное подтверждение тестового заказа' });
      enforceRequestRate(`security-smoke:${requestIp(request)}:${String(admin.userId ?? 'master')}`, 2, 60 * 60_000);
      const result = await runIikoSmokeTest(String(body.table_id ?? ''), String(body.product_id ?? '')); await audit(actor, 'run', 'security_checks', 'smoke', null, { status: result.smoke.status, detail: result.smoke.detail });
      return json(response, 200, result);
    }
    if (request.method === 'PUT' && path === '/api/v1/admin/security/telegram') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      const body = await readBody(request); const password = String(body.password ?? '');
      const attemptKey = authAttemptKey(request, 'telegram-config'); await assertAuthAllowed(attemptKey);
      if (!await verifyAdministratorPassword(admin, password)) { await recordAuthFailure(attemptKey); return json(response, 401, { error: 'Неверный пароль администратора' }); }
      await clearAuthFailures(attemptKey);
      const current = await telegramConfig(); const token = String(body.token ?? '').trim() || current.token; const chatId = String(body.chat_id ?? '').trim() || String(current.row?.chat_id ?? '');
      if (!/^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(token)) return json(response, 400, { error: 'Проверьте токен бота Telegram' });
      if (!/^-?\d{5,20}$/.test(chatId)) return json(response, 400, { error: 'Chat ID должен состоять из цифр' });
      const encrypted = encryptIikoCredentials({ token });
      await pool.query(`insert into notification_settings(id,enabled,chat_id,token_ciphertext,token_iv,token_tag,configured_by) values('active',$1,$2,$3,$4,$5,$6)
        on conflict(id) do update set enabled=excluded.enabled,chat_id=excluded.chat_id,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,token_tag=excluded.token_tag,configured_by=excluded.configured_by,last_error=null,updated_at=now()`, [body.enabled !== false, chatId, encrypted.ciphertext, encrypted.iv, encrypted.tag, actor]);
      await audit(actor, 'configure', 'telegram_notifications', 'active', { configured: Boolean(current.token), enabled: current.row?.enabled === true }, { configured: true, enabled: body.enabled !== false, chatId: `${chatId.slice(0, 4)}••••` });
      return json(response, 200, await securityOverview());
    }
    if (request.method === 'POST' && path === '/api/v1/admin/security/telegram/test') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      enforceRequestRate(`telegram-test:${requestIp(request)}:${String(admin.userId ?? 'master')}`, 5, 10 * 60_000);
      await sendTelegramMessage('✅ Тестовое уведомление доставлено. Оповещения системы работают.', { force: true });
      await pool.query("update notification_settings set last_test_at=now() where id='active'"); await audit(actor, 'test', 'telegram_notifications', 'active', null, { delivered: true });
      return json(response, 200, { ok: true });
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
      const result = await pool.query(`select id,display_name,is_active,auth_source,iiko_employee_id,created_at from waiter_profiles
        where restaurant_id=$1 and ($2::boolean=false or is_active=true) order by display_name`, [iikoOrganizationId, admin.scope === 'terminal']); return json(response, 200, result.rows);
    }
    if (request.method === 'GET' && path === '/api/v1/admin/iiko-front') return json(response, 200, await iikoFrontOverview());
    if (request.method === 'POST' && path === '/api/v1/admin/iiko-front/pairing-code') {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const raw = Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
      await pool.query('delete from iiko_front_pairing_codes where restaurant_id=$1 and (used_at is not null or expires_at<=now())', [iikoOrganizationId]);
      await pool.query('insert into iiko_front_pairing_codes(id,restaurant_id,code_hash,expires_at,created_by) values($1,$2,$3,now()+interval \'15 minutes\',$4)', [crypto.randomUUID(), iikoOrganizationId, sha256(raw), actor]);
      await audit(actor, 'create', 'iiko_front_pairing_code', 'one-time', null, { expiresInMinutes: 15 });
      return json(response, 201, { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/admin/iiko-front/bridges/')) {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      const id = decodeURIComponent(path.slice('/api/v1/admin/iiko-front/bridges/'.length));
      const result = await pool.query('update iiko_front_bridges set is_active=false,updated_at=now() where id=$1 and restaurant_id=$2 returning id', [id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 404, { error: 'Подключение не найдено' });
      await pool.query(`update waiter_profiles set is_active=false,updated_at=now() where restaurant_id=$1 and auth_source='iiko'
        and not exists(select 1 from iiko_front_bridges where restaurant_id=$1 and is_active=true)`, [iikoOrganizationId]);
      bridgeConnections.disconnect(id);
      await audit(actor, 'revoke', 'iiko_front_bridge', id, null, { active: false });
      return json(response, 204, {});
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/iiko-employees/') && path.endsWith('/access')) {
      if (admin.role !== 'administrator') return json(response, 403, { error: 'Раздел доступен только администратору' });
      const employeeId = decodeURIComponent(path.slice('/api/v1/admin/iiko-employees/'.length, -'/access'.length));
      const body = await readBody(request);
      const result = await pool.query(`update iiko_employees set app_access_enabled=$1,updated_at=now() where restaurant_id=$2 and employee_id=$3 returning *`, [body.enabled === true, iikoOrganizationId, employeeId]);
      if (!result.rowCount) return json(response, 404, { error: 'Сотрудник iiko не найден' });
      await pool.query(`insert into waiter_profiles(id,restaurant_id,display_name,iiko_employee_id,auth_source,is_active,pin_hash)
        values($1,$2,$3,$4,'iiko',$5,null) on conflict(restaurant_id,iiko_employee_id) where iiko_employee_id is not null
        do update set display_name=excluded.display_name,is_active=excluded.is_active,pin_hash=null,auth_source='iiko',updated_at=now()`, [crypto.randomUUID(), iikoOrganizationId, result.rows[0].display_name, employeeId, body.enabled === true && result.rows[0].is_active]);
      await audit(actor, 'update', 'iiko_employee_access', employeeId, null, { enabled: body.enabled === true });
      return json(response, 200, result.rows[0]);
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
      const id=crypto.randomUUID(); const result=await pool.query("insert into waiter_profiles(id,restaurant_id,display_name,pin_hash,auth_source) values($1,$2,$3,$4,'local') returning id,display_name,is_active,auth_source,iiko_employee_id,created_at",[id,iikoOrganizationId,name,passwordHash(pin)]);
      await audit(actor,'create','waiter',id,null,result.rows[0]); return json(response,201,result.rows[0]);
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/waiters/')) {
      const id=decodeURIComponent(path.slice('/api/v1/admin/waiters/'.length)); const body=await readBody(request); const pin=String(body.pin ?? '');
      if (pin && !/^\d{4,8}$/.test(pin)) return json(response,400,{error:'PIN должен содержать 4–8 цифр'});
      const result=await pool.query(`update waiter_profiles set is_active=$1,pin_hash=case when $2='' then pin_hash else $3 end,updated_at=now() where id=$4 and restaurant_id=$5 and auth_source='local' returning id,display_name,is_active,auth_source,iiko_employee_id,created_at`,[body.is_active !== false,pin,pin ? passwordHash(pin) : '',id,iikoOrganizationId]);
      if (!result.rowCount) return json(response,404,{error:'Официант не найден'}); return json(response,200,result.rows[0]);
    }
    if ((request.method === 'PUT' || request.method === 'DELETE') && path.startsWith('/api/v1/admin/iiko-modifiers/')) {
      const id = decodeURIComponent(path.slice('/api/v1/admin/iiko-modifiers/'.length));
      if (!id || id.length > 160) return json(response, 400, { error: 'Некорректный модификатор' });
      const menuRows = await pool.query('select modifier_groups from iiko_menu_items where not is_hidden');
      let modifierName = '';
      for (const menuItem of menuRows.rows) {
        for (const group of arrayValue(menuItem.modifier_groups)) {
          const modifier = arrayValue(group?.items).find((item) => String(item?.itemId ?? '') === id);
          if (modifier) { modifierName = String(modifier.name ?? '').trim(); break; }
        }
        if (modifierName) break;
      }
      if (!modifierName) return json(response, 404, { error: 'Модификатор не найден в актуальном меню iiko' });
      const before = await pool.query('select * from iiko_modifier_presentations where restaurant_id=$1 and modifier_id=$2', [iikoOrganizationId, id]);
      if (request.method === 'DELETE') {
        await pool.query('delete from iiko_modifier_presentations where restaurant_id=$1 and modifier_id=$2', [iikoOrganizationId, id]);
        if (before.rows[0]?.image) await removeUploadedProduct(before.rows[0].image);
        await audit(actor, 'delete', 'iiko_modifier_presentation', id, before.rows[0] ?? null, null);
        return json(response, 204, {});
      }
      const body = await readBody(request);
      const image = String(body.image ?? '').trim();
      if (!image || (!image.startsWith(`${productPublicPath}/`) && !image.startsWith('/images/') && !/^https:\/\//i.test(image))) return json(response, 400, { error: 'Загрузите изображение модификатора' });
      const result = await pool.query(`insert into iiko_modifier_presentations(restaurant_id,modifier_id,name,image) values($1,$2,$3,$4)
        on conflict(restaurant_id,modifier_id) do update set name=excluded.name,image=excluded.image,updated_at=now() returning *`, [iikoOrganizationId, id, modifierName, image]);
      if (before.rows[0]?.image && before.rows[0].image !== image) await removeUploadedProduct(before.rows[0].image);
      await audit(actor, 'update', 'iiko_modifier_presentation', id, before.rows[0] ?? null, result.rows[0]);
      return json(response, 200, result.rows[0]);
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
      const result = await pool.query(`insert into iiko_product_presentations(restaurant_id,sku,image,image_position,badge,composition,pairs_with_skus) values($1,$2,$3,$4,$5,$6,$7)
        on conflict(restaurant_id,sku) do update set image=excluded.image,image_position=excluded.image_position,badge=excluded.badge,composition=excluded.composition,pairs_with_skus=excluded.pairs_with_skus,updated_at=now() returning *`, [iikoOrganizationId, sku, String(body.image ?? ''), String(body.image_position ?? 'center'), String(body.badge ?? ''), String(body.composition ?? '').trim(), JSON.stringify(pairSkus)]);
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
      const requestedTableId = String(body.table_id ?? '').trim();
      const legacyTableNumber = String(body.table_number ?? '').trim();
      const waiterFieldPresent = Object.prototype.hasOwnProperty.call(body, 'waiter_id');
      const requestedWaiterId = String(waiterFieldPresent ? body.waiter_id ?? '' : before.rows[0]?.waiter_id ?? '').trim();
      let selectedTable = null;
      let selectedWaiter = null;
      if (requestedTableId) {
        const table = await pool.query('select table_id,table_number from iiko_tables where table_id=$1 and terminal_group_id=$2', [requestedTableId, iikoTerminalGroupId]);
        if (!table.rowCount) return json(response, 409, { error: 'Выбранного стола больше нет в актуальной схеме iiko' });
        selectedTable = table.rows[0];
      } else if (legacyTableNumber) {
        const table = await pool.query('select table_id,table_number from iiko_tables where table_number=$1 and terminal_group_id=$2 order by section_name limit 1', [legacyTableNumber, iikoTerminalGroupId]);
        if (!table.rowCount) return json(response, 409, { error: 'Стол не найден в актуальной схеме iiko' });
        selectedTable = table.rows[0];
      }
      if (requestedWaiterId) {
        const waiter = await pool.query('select id,display_name from waiter_profiles where id=$1 and restaurant_id=$2 and is_active=true', [requestedWaiterId, iikoOrganizationId]);
        if (!waiter.rowCount) return json(response, 409, { error: 'Выбранный официант больше не доступен' });
        selectedWaiter = waiter.rows[0];
      }
      const result = await pool.query('insert into terminals(id, label, table_id, table_number, waiter_id, is_active, demo_mode, idle_seconds) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do update set label = excluded.label, table_id = excluded.table_id, table_number = excluded.table_number, waiter_id = excluded.waiter_id, is_active = excluded.is_active, demo_mode = excluded.demo_mode, idle_seconds = excluded.idle_seconds, updated_at = now() returning *', [id, String(body.label ?? ''), selectedTable?.table_id ?? null, selectedTable?.table_number ?? '', selectedWaiter?.id ?? null, body.is_active !== false, body.demo_mode === true, Math.max(15, Number(body.idle_seconds ?? 45))]);
      await pool.query('delete from terminal_table_selections where terminal_id=$1', [id]);
      await audit(actor, 'update', 'terminal', id, before.rows[0] ?? null, result.rows[0]);
      return json(response, 200, { ...result.rows[0], table_source: result.rows[0].table_number ? 'admin' : null });
    }
    if (request.method === 'GET' && path === '/api/v1/admin/banners') {
      const result = await pool.query(`select b.*,coalesce((select m.product_id from iiko_menu_items m where m.sku=b.product_sku and not m.is_hidden order by m.updated_at desc limit 1),b.product_id) as product_id from banners b order by b.sort_order,b.id`);
      return json(response, 200, result.rows);
    }
    if (request.method === 'GET' && path === '/api/v1/admin/promotions') {
      const [result, discounts] = await Promise.all([
        pool.query('select * from promotions where restaurant_id=$1 order by active desc,created_at desc', [iikoOrganizationId]),
        iikoDiscountOptions(url.searchParams.get('refresh') === '1'),
      ]);
      return json(response, 200, { promotions: result.rows, iikoDiscounts: discounts });
    }
    if (request.method === 'POST' && path === '/api/v1/admin/promotions') {
      const value = await promotionInput(await readBody(request));
      try {
        const result = await pool.query(`insert into promotions(restaurant_id,code,name,iiko_discount_type_id,iiko_discount_name,discount_type,value,min_order_total,active,starts_at,ends_at,usage_limit) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, [iikoOrganizationId, value.code, value.name, value.iikoDiscountTypeId, value.iikoDiscountName, value.discountType, value.value, value.minOrderTotal, value.active, value.startsAt, value.endsAt, value.usageLimit]);
        await audit(actor, 'create', 'promotion', String(result.rows[0].id), null, result.rows[0]);
        return json(response, 201, result.rows[0]);
      } catch (error) {
        if (error.code === '23505') return json(response, 409, { error: 'Такой промокод уже существует' });
        throw error;
      }
    }
    if (request.method === 'PUT' && path.startsWith('/api/v1/admin/promotions/')) {
      const id = Number(path.slice('/api/v1/admin/promotions/'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный промокод' });
      const body = await readBody(request);
      const before = await pool.query('select * from promotions where id=$1 and restaurant_id=$2', [id, iikoOrganizationId]);
      if (!before.rowCount) return json(response, 404, { error: 'Промокод не найден' });
      const result = await pool.query('update promotions set active=$1,updated_at=now() where id=$2 and restaurant_id=$3 returning *', [body.active === true, id, iikoOrganizationId]);
      await audit(actor, 'update', 'promotion', String(id), before.rows[0], result.rows[0]);
      return json(response, 200, result.rows[0]);
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/admin/promotions/')) {
      const id = Number(path.slice('/api/v1/admin/promotions/'.length));
      if (!Number.isInteger(id)) return json(response, 400, { error: 'Некорректный промокод' });
      const result = await pool.query('delete from promotions where id=$1 and restaurant_id=$2 returning *', [id, iikoOrganizationId]);
      if (!result.rowCount) return json(response, 404, { error: 'Промокод не найден' });
      await audit(actor, 'delete', 'promotion', String(id), result.rows[0], null);
      return json(response, 204, {});
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
let activeIikoOrderSyncTask = null;
const loadActiveIikoOrders = async () => {
  const active = await pool.query(`select o.iiko_order_id from customer_orders o
    left join iiko_orders io on io.order_id=o.iiko_order_id
    where o.iiko_order_id is not null and o.completed_at is null
      and o.updated_at > now() - interval '8 hours' and coalesce(io.creation_status,'') <> 'Error'
    limit 30`);
  await fetchIikoOrders(active.rows.map((row) => row.iiko_order_id));
};
const syncActiveIikoOrders = () => {
  if (!activeIikoOrderSyncTask) activeIikoOrderSyncTask = loadActiveIikoOrders().finally(() => { activeIikoOrderSyncTask = null; });
  return activeIikoOrderSyncTask;
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

const bridgeWebSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
bridgeWebSockets.on('connection', (socket, _request, bridge) => {
  const connection = { bridgeId: bridge.id, restaurantId: bridge.restaurant_id, socket, connectedAt: Date.now() };
  bridgeConnections.register(connection);
  let messageQueue = Promise.resolve();
  socket.on('message', (payload) => {
    messageQueue = messageQueue.then(async () => {
      let message;
      try { message = JSON.parse(payload.toString('utf8')); }
      catch { return socket.close(1007, 'Invalid JSON'); }
      if (message.type === 'heartbeat') {
        await pool.query('update iiko_front_bridges set last_seen_at=now(),updated_at=now() where id=$1', [bridge.id]);
        socket.send(JSON.stringify({ type: 'heartbeat_ack', serverTime: new Date().toISOString() }));
        return;
      }
      if (message.type === 'hello') {
        await pool.query(`update iiko_front_bridges set display_name=$1,version=$2,api_version=$3,module_id=$4,terminal_id=$5,last_seen_at=now(),updated_at=now() where id=$6`, [String(message.displayName ?? bridge.display_name).slice(0, 160), String(message.version ?? '').slice(0, 40), String(message.apiVersion ?? '').slice(0, 20), Number.isInteger(Number(message.moduleId)) ? Number(message.moduleId) : null, String(message.terminalId ?? '').slice(0, 160), bridge.id]);
        socket.send(JSON.stringify({ type: 'sync_employees' }));
        return;
      }
      if (message.type === 'employees_snapshot') {
        const count = await syncIikoEmployees(bridge.id, message.employees);
        socket.send(JSON.stringify({ type: 'employees_ack', snapshotId: String(message.snapshotId ?? '').slice(0, 100), count }));
        return;
      }
      if (message.type === 'auth_result') bridgeConnections.resolveAuthentication(message, bridge.id);
    }).catch((error) => {
      console.warn('iikoFront Bridge message:', error.message);
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', message: 'Не удалось обработать сообщение' }));
    });
  });
  socket.on('close', () => bridgeConnections.unregister(bridge.id, socket));
  socket.on('error', () => bridgeConnections.unregister(bridge.id, socket));
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/api/v1/iiko-front/connect') return socket.destroy();
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token.length < 32) throw new Error('Unauthorized');
    const result = await pool.query('select * from iiko_front_bridges where token_hash=$1 and is_active=true', [sha256(token)]);
    if (!result.rowCount) throw new Error('Unauthorized');
    bridgeWebSockets.handleUpgrade(request, socket, head, (webSocket) => bridgeWebSockets.emit('connection', webSocket, request, result.rows[0]));
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

await loadStoredIikoConfig();
server.listen(port, '127.0.0.1', () => {
  console.log(`BB Kiosk API listening on ${port}`);
  // A process restart must not create an iiko request burst. Webhook settings
  // are changed only by the explicit connection wizard and the first scheduled
  // refresh happens after the normal ten-minute interval; cached data remains
  // available immediately.
  // No tablet makes these calls. Menu/tables/stop-list are refreshed in one
  // controlled server task; active orders use webhooks first and this fallback.
  setInterval(() => { void backgroundSync(); }, 10 * 60 * 1_000).unref();
  // Stop-list webhooks are primary; the ten-minute full sync above is the only
  // fallback. A former second two-minute poll duplicated these calls.
  setInterval(() => { void syncActiveIikoOrders().catch((error) => console.warn('iiko order sync:', error.message)); }, 2 * 60 * 1_000).unref();
});
