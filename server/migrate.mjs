import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const localCatalog = new URL('./menu.json', import.meta.url);
const catalogSource = fs.existsSync(localCatalog) ? localCatalog : new URL('../menu.json', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(catalogSource)).menu;

await pool.query(`
  create table if not exists products (
    id text primary key, name text not null, category text not null, price_rub integer not null check (price_rub >= 0), portion text not null default '', unit text not null default '', description text,
    kbju jsonb, image text not null, source_url text not null default '', sauce_options jsonb, sauce_addon_price_rub text, addon_options jsonb, flavor_options jsonb, size_option jsonb, pairs_with jsonb, recommendations_note text,
    is_available boolean not null default true, badge text not null default '', image_position text not null default 'center', allergens text not null default '', spicy text not null default 'none' check (spicy in ('none','mild','hot')), sort_order integer not null default 0,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table if not exists promotions (
    id bigserial primary key, product_id text not null references products(id) on delete cascade, title text not null, subtitle text not null, label text not null, active boolean not null default true, sort_order integer not null default 0,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table if not exists terminals (
    id text primary key, label text not null default '', table_number text not null default '', is_active boolean not null default true, idle_seconds integer not null default 45 check (idle_seconds >= 15 and idle_seconds <= 600),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
  );
  create table if not exists app_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
  create table if not exists audit_log (id bigserial primary key, actor text not null, action text not null, entity text not null, entity_id text not null, before_data jsonb, after_data jsonb, created_at timestamptz not null default now());
  create table if not exists customer_orders (
    id bigserial primary key, order_number text unique not null, terminal_id text not null references terminals(id), table_number text not null default '', items jsonb not null, total integer not null check (total >= 0), comment text not null default '', promo_code text not null default '', status_step integer not null default 0 check (status_step between 0 and 4),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  alter table customer_orders add column if not exists completed_at timestamptz;
  alter table customer_orders add column if not exists iiko_order_id text;
  alter table customer_orders add column if not exists iiko_pos_id text;
  create unique index if not exists customer_orders_iiko_order_id_idx on customer_orders(iiko_order_id) where iiko_order_id is not null;
  create table if not exists iiko_orders (
    order_id text primary key,
    organization_id text not null,
    pos_id text,
    external_number text,
    order_status text,
    item_statuses jsonb not null default '[]'::jsonb,
    status_step integer not null default 0 check (status_step between 0 and 4),
    creation_status text,
    error_info jsonb,
    last_event_type text,
    raw_payload jsonb not null,
    last_webhook_at timestamptz,
    last_polled_at timestamptz,
    updated_at timestamptz not null default now()
  );
  create table if not exists iiko_webhook_events (
    id bigserial primary key,
    event_type text not null,
    organization_id text,
    correlation_id text,
    event_time timestamptz,
    payload jsonb not null,
    received_at timestamptz not null default now()
  );
  create index if not exists iiko_webhook_events_order_idx on iiko_webhook_events ((payload #>> '{eventInfo,id}'), received_at desc);
  create table if not exists iiko_stop_list_items (
    organization_id text not null,
    terminal_group_id text not null,
    product_id text not null,
    size_id text not null default '',
    balance numeric not null default 0,
    sku text,
    date_added timestamptz,
    updated_at timestamptz not null default now(),
    primary key (organization_id, terminal_group_id, product_id, size_id)
  );
  -- iiko is queried by the server on a controlled schedule. Tablets read only
  -- these snapshots, which keeps the Cloud API rate limit protected.
  create table if not exists iiko_menu_items (
    product_id text primary key,
    category_id text not null default '', category_name text not null,
    name text not null, description text, price_rub numeric not null default 0,
    portion_weight_grams numeric not null default 0, measure_unit text not null default '',
    nutrition jsonb, image_url text, modifier_groups jsonb not null default '[]'::jsonb,
    is_hidden boolean not null default false, sort_order integer not null default 0,
    revision bigint, raw_payload jsonb not null, updated_at timestamptz not null default now()
  );
  create index if not exists iiko_menu_items_category_idx on iiko_menu_items(category_name, sort_order);
  create table if not exists iiko_tables (
    table_id text primary key, organization_id text not null, terminal_group_id text not null,
    section_id text not null default '', section_name text not null default '',
    table_number text not null default '', table_name text not null default '',
    updated_at timestamptz not null default now()
  );
  create index if not exists iiko_tables_group_idx on iiko_tables(terminal_group_id, section_name, table_number);
  create table if not exists terminal_table_selections (
    terminal_id text primary key references terminals(id) on delete cascade,
    table_id text not null, table_number text not null default '', table_name text not null default '',
    selected_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table if not exists service_requests (
    id bigserial primary key, terminal_id text not null references terminals(id), table_number text not null default '', request_type text not null check (request_type in ('waiter','cutlery','bill','help')),
    created_at timestamptz not null default now(), handled_at timestamptz
  );
`);
const existing = await pool.query('select count(*)::int as count from products');
if (!existing.rows[0].count) {
  for (const [index, product] of catalog.entries()) {
    await pool.query(`insert into products (id,name,category,price_rub,portion,unit,description,kbju,image,source_url,sauce_options,sauce_addon_price_rub,addon_options,flavor_options,size_option,pairs_with,recommendations_note,sort_order)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [
      product.id, product.name, product.category, product.price_rub, product.portion, product.unit, product.description, product.kbju ? JSON.stringify(product.kbju) : null,
      `/images/menu/${index}.webp`, product.source_url ?? '', JSON.stringify(product.sauce_options ?? []), product.sauce_addon_price_rub ?? null, JSON.stringify(product.addon_options ?? []), JSON.stringify(product.flavor_options ?? []), JSON.stringify(product.size_option ?? null), JSON.stringify(product.pairs_with ?? []), product.recommendations_note ?? null, index,
    ]);
  }
}
const promotionCount = await pool.query('select count(*)::int as count from promotions');
if (!promotionCount.rows[0].count) {
  const featured = catalog.slice(0, 3);
  for (const [index, product] of featured.entries()) await pool.query('insert into promotions(product_id,title,subtitle,label,sort_order) values ($1,$2,$3,$4,$5)', [product.id, product.name, product.description ?? product.name, index ? 'ВЫБОР ГОСТЕЙ' : 'СПЕЦПРЕДЛОЖЕНИЕ', index]);
}
await pool.query(`insert into app_settings(key,value) values ('business_hours', '"12:00 – 03:00"'::jsonb) on conflict (key) do nothing`);
console.log('Database migration complete');
await pool.end();
