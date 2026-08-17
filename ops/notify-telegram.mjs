import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import pg from 'pg';

const [mode = 'alert', key = 'system', ...parts] = process.argv.slice(2);
const message = parts.join(' ').trim() || key;
const encryptionKeyHex = process.env.IIKO_CONFIG_ENCRYPTION_KEY ?? '';
const databaseUrl = process.env.DATABASE_URL ?? '';
const cachePath = process.env.ZAKAZ_TELEGRAM_CACHE_PATH ?? '/etc/zakaz-telegram-cache.json';
const statePath = process.env.ZAKAZ_TELEGRAM_STATE_PATH ?? '/var/lib/zakaz/telegram-alerts.json';
const repeatAfterMs = 6 * 60 * 60_000;

if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) process.exit(0);

const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');
const pool = databaseUrl
  ? new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3_000 })
  : null;

const decryptToken = (row) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(row.token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.token_tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')).token;
};

const atomicWrite = async (path, value, mode) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(value), { mode });
  await rename(temporary, path);
};

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};

const getConfiguration = async () => {
  if (pool) {
    try {
      const result = await pool.query("select * from notification_settings where id='active' and enabled=true and token_ciphertext is not null and chat_id<>''");
      if (result.rowCount) {
        const row = result.rows[0];
        await atomicWrite(cachePath, {
          token_ciphertext: row.token_ciphertext,
          token_iv: row.token_iv,
          token_tag: row.token_tag,
          chat_id: row.chat_id,
        }, 0o600).catch(() => {});
        return { row, databaseAvailable: true };
      }
      return { row: null, databaseAvailable: true };
    } catch {}
  }
  return { row: await readJson(cachePath, null), databaseAvailable: false };
};

const send = async (row, text, databaseAvailable) => {
  const response = await fetch(`https://api.telegram.org/bot${decryptToken(row)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: row.chat_id,
      text: `BrooklynBowl Kiosk\n\n${text}`,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.description ?? `Telegram HTTP ${response.status}`);
  if (databaseAvailable) {
    await pool.query("update notification_settings set last_success_at=now(),last_error=null where id='active'");
  }
};

const localAlert = async (key) => (await readJson(statePath, {}))[key] ?? null;
const saveLocalAlert = async (key, value) => {
  const state = await readJson(statePath, {});
  state[key] = value;
  await atomicWrite(statePath, state, 0o600);
};

const getAlert = async (key, databaseAvailable) => {
  if (databaseAvailable) {
    const result = await pool.query('select * from notification_alerts where alert_key=$1', [key]);
    return result.rows[0] ?? null;
  }
  return localAlert(key);
};

const saveAlert = async (key, message, isOpen, databaseAvailable) => {
  const now = new Date().toISOString();
  if (databaseAvailable) {
    if (isOpen) {
      await pool.query(`insert into notification_alerts(alert_key,is_open,last_message,last_sent_at,updated_at)
        values($1,true,$2,now(),now()) on conflict(alert_key) do update set
        is_open=true,last_message=excluded.last_message,last_sent_at=now(),updated_at=now()`, [key, message]);
    } else {
      await pool.query(`insert into notification_alerts(alert_key,is_open,last_message,recovered_at,updated_at)
        values($1,false,$2,now(),now()) on conflict(alert_key) do update set
        is_open=false,last_message=excluded.last_message,recovered_at=now(),updated_at=now()`, [key, message]);
    }
  }
  await saveLocalAlert(key, {
    is_open: isOpen,
    last_message: message,
    last_sent_at: isOpen ? now : null,
    recovered_at: isOpen ? null : now,
  }).catch(() => {});
};

try {
  const { row, databaseAvailable } = await getConfiguration();
  if (!row) process.exit(0);
  const alert = await getAlert(key, databaseAvailable);
  if (mode === 'recover') {
    if (alert?.is_open) {
      await send(row, `✅ Работа восстановлена\n${message}`, databaseAvailable);
      await saveAlert(key, message, false, databaseAvailable);
    }
  } else {
    const lastSentAt = alert?.last_sent_at ? new Date(alert.last_sent_at).getTime() : 0;
    if (!alert?.is_open || Date.now() - lastSentAt >= repeatAfterMs) {
      await send(row, `🔴 Требуется внимание\n${message}`, databaseAvailable);
      await saveAlert(key, message, true, databaseAvailable);
    }
  }
} catch (error) {
  if (pool) {
    await pool.query("update notification_settings set last_error=$1 where id='active'", [String(error.message ?? error).slice(0, 500)]).catch(() => {});
  }
  console.error(error.message ?? error);
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
