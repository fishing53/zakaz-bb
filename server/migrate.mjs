import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let restaurantId = process.env.IIKO_ORGANIZATION_ID ?? '';
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
  create table if not exists banners (
    id bigserial primary key,
    name text not null default '',
    image_url text not null,
    product_id text,
    kind text not null default 'restaurant' check (kind in ('restaurant','advertising')),
    active boolean not null default true,
    starts_at timestamptz,
    ends_at timestamptz,
    impression_limit integer check (impression_limit is null or impression_limit > 0),
    impressions integer not null default 0 check (impressions >= 0),
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (ends_at is null or starts_at is null or ends_at > starts_at)
  );
  alter table banners add column if not exists product_id text;
  alter table banners add column if not exists product_sku text;
  create index if not exists banners_public_idx on banners(active, sort_order, id);
  create table if not exists banner_impressions (
    id bigserial primary key,
    banner_id bigint not null references banners(id) on delete cascade,
    terminal_id text not null,
    exposure_bucket bigint not null,
    shown_at timestamptz not null default now(),
    unique (banner_id, terminal_id, exposure_bucket)
  );
  create table if not exists promotions (
    id bigserial primary key,
    restaurant_id text not null,
    code text not null,
    name text not null,
    iiko_discount_type_id text not null,
    iiko_discount_name text not null,
    discount_type text not null check(discount_type in ('percent','fixed')),
    value numeric not null check(value > 0),
    min_order_total integer not null default 0 check(min_order_total >= 0),
    active boolean not null default true,
    starts_at timestamptz,
    ends_at timestamptz,
    usage_limit integer check(usage_limit is null or usage_limit > 0),
    uses_count integer not null default 0 check(uses_count >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check(ends_at is null or starts_at is null or ends_at > starts_at)
  );
  create unique index if not exists promotions_restaurant_code_idx on promotions(restaurant_id,upper(code));
  create table if not exists terminals (
    id text primary key, label text not null default '', table_id text, table_number text not null default '', is_active boolean not null default true, idle_seconds integer not null default 45 check (idle_seconds >= 15 and idle_seconds <= 600),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
  );
  alter table terminals add column if not exists table_id text;
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
  alter table iiko_menu_items add column if not exists sku text;
  update iiko_menu_items set sku=nullif(raw_payload->'item'->>'sku','') where sku is null;
  create index if not exists iiko_menu_items_sku_idx on iiko_menu_items(sku) where sku is not null;
  create index if not exists iiko_menu_items_category_idx on iiko_menu_items(category_name, sort_order);
  create table if not exists iiko_product_overrides (
    product_id text primary key references iiko_menu_items(product_id) on delete cascade,
    image text not null default '', image_position text not null default 'center', badge text not null default '',
    pairs_with jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  );
  create table if not exists iiko_product_presentations (
    restaurant_id text not null,
    sku text not null,
    image text not null default '',
    image_position text not null default 'center',
    badge text not null default '',
    composition text not null default '',
    pairs_with_skus jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (restaurant_id, sku)
  );
  alter table iiko_product_presentations add column if not exists composition text not null default '';
  update banners b set product_sku=m.sku from iiko_menu_items m where b.product_sku is null and b.product_id=m.product_id and m.sku is not null;
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
  create table if not exists table_qr_codes (
    id uuid primary key,
    restaurant_id text not null,
    table_id text not null,
    table_number text not null default '',
    table_name text not null default '',
    section_name text not null default '',
    token_version integer not null default 1 check(token_version > 0),
    is_active boolean not null default true,
    scans_count integer not null default 0 check(scans_count >= 0),
    last_scanned_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(restaurant_id, table_id)
  );
  create index if not exists table_qr_codes_restaurant_idx on table_qr_codes(restaurant_id,is_active,section_name,table_number);
  alter table terminal_table_selections add column if not exists source text not null default 'guest';
  alter table terminal_table_selections add column if not exists qr_code_id uuid references table_qr_codes(id) on delete set null;
  create table if not exists service_requests (
    id bigserial primary key, terminal_id text not null references terminals(id), table_number text not null default '', request_type text not null check (request_type in ('waiter','cutlery','bill','help')),
    created_at timestamptz not null default now(), handled_at timestamptz
  );
  -- Foundation shared by kiosk, QR ordering and the future waiter application.
  create table if not exists guest_sessions (
    id uuid primary key, restaurant_id text not null, terminal_id text references terminals(id) on delete set null,
    source text not null check (source in ('tablet','qr','waiter')), table_id text, table_number text not null default '',
    status text not null default 'active' check (status in ('active','closed','expired')),
    started_at timestamptz not null default now(), ended_at timestamptz, last_seen_at timestamptz not null default now(), metadata jsonb not null default '{}'::jsonb
  );
  create index if not exists guest_sessions_active_idx on guest_sessions(restaurant_id, table_number, status, last_seen_at desc);
  alter table customer_orders add column if not exists restaurant_id text not null default '';
  alter table customer_orders add column if not exists guest_session_id uuid references guest_sessions(id) on delete set null;
  alter table customer_orders add column if not exists source text not null default 'tablet';
  alter table customer_orders add column if not exists client_request_id text;
  create unique index if not exists customer_orders_client_request_idx on customer_orders(restaurant_id, client_request_id) where client_request_id is not null;
  create table if not exists order_requests (
    restaurant_id text not null, client_request_id text not null, terminal_id text not null,
    request_hash text not null, status text not null default 'processing' check(status in ('processing','success','failed')),
    order_number text, iiko_order_id text, error_message text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    primary key(restaurant_id,client_request_id)
  );
  create table if not exists order_status_history (
    id bigserial primary key, restaurant_id text not null, order_number text,
    iiko_order_id text, status_step integer not null check(status_step between 0 and 4),
    order_status text, item_statuses jsonb not null default '[]'::jsonb, source text not null,
    created_at timestamptz not null default now()
  );
  create index if not exists order_status_history_order_idx on order_status_history(restaurant_id,order_number,created_at);
  alter table service_requests add column if not exists restaurant_id text not null default '';
  alter table service_requests add column if not exists guest_session_id uuid references guest_sessions(id) on delete set null;
  alter table service_requests add column if not exists status text not null default 'new';
  alter table service_requests add column if not exists accepted_by text;
  alter table service_requests add column if not exists accepted_at timestamptz;
  alter table service_requests add column if not exists completed_at timestamptz;
  alter table service_requests add column if not exists completed_by text;
  create table if not exists waiter_profiles (
    id text primary key, restaurant_id text not null, display_name text not null, pin_hash text, is_active boolean not null default true,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table if not exists admin_users (
    id uuid primary key, restaurant_id text not null, username text not null, display_name text not null,
    role text not null check(role in ('administrator','hostess')), password_hash text not null,
    is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create unique index if not exists admin_users_restaurant_username_idx on admin_users(restaurant_id,lower(username));
  create table if not exists waiter_table_assignments (
    restaurant_id text not null, table_id text not null, waiter_id text not null references waiter_profiles(id),
    assigned_at timestamptz not null default now(), released_at timestamptz, primary key(restaurant_id, table_id, waiter_id, assigned_at)
  );
  create table if not exists waiter_devices (
    id bigserial primary key, waiter_id text not null references waiter_profiles(id) on delete cascade,
    token text not null unique, platform text not null default 'android', is_active boolean not null default true,
    last_seen_at timestamptz not null default now(), created_at timestamptz not null default now()
  );
  create table if not exists app_events (
    id bigserial primary key, restaurant_id text not null, event_type text not null,
    aggregate_type text not null, aggregate_id text not null, payload jsonb not null,
    created_at timestamptz not null default now()
  );
  create index if not exists app_events_restaurant_idx on app_events(restaurant_id, id desc);
  create table if not exists auth_attempts (
    attempt_key text primary key, failures integer not null default 0,
    window_started_at timestamptz not null default now(), locked_until timestamptz,
    updated_at timestamptz not null default now()
  );
  create table if not exists monitoring_events (
    id bigserial primary key,
    component text not null check(component in ('api','database','disk','iiko_order','iiko_sync','webhook')),
    severity text not null default 'error' check(severity in ('warning','error','critical')),
    message text not null,
    context jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  alter table monitoring_events add column if not exists alerted_at timestamptz;
  create index if not exists monitoring_events_recent_idx on monitoring_events(component,created_at desc);
  delete from monitoring_events where created_at < now()-interval '90 days';
  create table if not exists iiko_connection_settings (
    id text primary key default 'active' check(id='active'),
    api_base text not null,
    organization_id text not null,
    terminal_group_id text not null,
    external_menu_id text not null,
    order_type_id text not null,
    order_source_key text not null default 'BrooklynBowl Kiosk',
    credentials_ciphertext text not null,
    credentials_iv text not null,
    credentials_tag text not null,
    encryption_version integer not null default 1,
    configured_by text not null,
    last_test_at timestamptz,
    last_test_details jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`);
const configuredRestaurant = await pool.query("select organization_id from iiko_connection_settings where id='active'");
restaurantId = configuredRestaurant.rows[0]?.organization_id ?? restaurantId;
await pool.query(`insert into iiko_product_presentations(restaurant_id,sku,image,image_position,badge,pairs_with_skus)
  select $1,m.sku,o.image,o.image_position,o.badge,
    coalesce((select jsonb_agg(pm.sku) from jsonb_array_elements_text(o.pairs_with) pair(product_id) join iiko_menu_items pm on pm.product_id=pair.product_id and pm.sku is not null),'[]'::jsonb)
  from iiko_product_overrides o join iiko_menu_items m on m.product_id=o.product_id where m.sku is not null
  on conflict(restaurant_id,sku) do nothing`, [restaurantId]);
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
const bannerCount = await pool.query('select count(*)::int as count from banners');
if (!bannerCount.rows[0].count) {
  const defaults = await pool.query("select name,image from products where image <> '' order by sort_order,name limit 3");
  for (const [index, product] of defaults.rows.entries()) {
    await pool.query('insert into banners(name,image_url,kind,sort_order) values($1,$2,$3,$4)', [product.name, product.image, 'restaurant', index]);
  }
}
await pool.query(`insert into app_settings(key,value) values ('business_hours', '"12:00 – 03:00"'::jsonb) on conflict (key) do nothing`);
console.log('Database migration complete');
await pool.end();
