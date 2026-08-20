import crypto from 'node:crypto';

export const iikoItemStatuses = new Set(['Added', 'PrintedNotCooking', 'CookingStarted', 'CookingCompleted', 'Served']);

export const iikoStatusStep = (order) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  const statuses = items.map((item) => item?.status).filter((status) => iikoItemStatuses.has(status));
  if (order?.status === 'Closed' || (statuses.length && statuses.every((status) => status === 'Served'))) return 4;
  if (statuses.length && statuses.every((status) => status === 'CookingCompleted' || status === 'Served')) return 3;
  if (statuses.some((status) => status === 'CookingStarted' || status === 'CookingCompleted' || status === 'Served')) return 2;
  if (statuses.some((status) => status === 'PrintedNotCooking')) return 1;
  return 0;
};

// A served item is only a kitchen/service milestone: the guest may still be
// eating and may place another order. The guest session can be finalized only
// after iiko closes the whole order (the final settlement/check event).
export const isIikoOrderSettled = (order) => order?.status === 'Closed';

export const deterministicUuid = (value) => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const isDatabaseBackupFileName = (name) => /^(?:bb-kiosk|zakaz)-\d{8}T\d{6}Z\.dump$/.test(String(name));

export const validateMenuPublication = (items) => {
  const seenProducts = new Set();
  const visible = (Array.isArray(items) ? items : []).filter((item) => {
    if (item.isHidden) return false;
    const productId = String(item.productId ?? '');
    if (!productId) return true;
    if (seenProducts.has(productId)) return false;
    seenProducts.add(productId);
    return true;
  });
  const missingSku = visible.filter((item) => !String(item.sku ?? '').trim());
  const counts = new Map();
  visible.forEach((item) => {
    const sku = String(item.sku ?? '').trim();
    if (sku) counts.set(sku, (counts.get(sku) ?? 0) + 1);
  });
  const duplicateSkus = [...counts].filter(([, count]) => count > 1).map(([sku]) => sku);
  return { ok: !missingSku.length && !duplicateSkus.length, visible: visible.length, missingSku: missingSku.length, duplicateSkus };
};

export const applyStopList = (items, stopList) => {
  const balance = new Map((Array.isArray(stopList) ? stopList : []).map((item) => [String(item.productId), Number(item.balance ?? 0)]));
  return (Array.isArray(items) ? items : []).map((item) => ({ ...item, available: !balance.has(String(item.id)) || Number(balance.get(String(item.id))) > 0 }));
};

export const visibleCatalogItems = (items, stopList) => {
  const stopped = new Set((Array.isArray(stopList) ? stopList : [])
    .filter((item) => Number(item.balance ?? 0) <= 0)
    .map((item) => String(item.productId)));
  return (Array.isArray(items) ? items : []).filter((item) => {
    const id = item?.productId ?? item?.product_id ?? item?.id;
    return id && !stopped.has(String(id));
  });
};

export const isSauceMenuCategory = (value) => String(value ?? '').trim().toLocaleUpperCase('ru-RU') === 'СОУСЫ';

export const isStandaloneMenuProduct = (item) => {
  const categories = Array.isArray(item?.categories) && item.categories.length ? item.categories : [item?.category];
  return categories.some((category) => !isSauceMenuCategory(typeof category === 'object' ? category?.name : category));
};

const arrayValue = (value) => Array.isArray(value) ? value : [];

/**
 * Preserve the external-menu presentation order. A product is stored once,
 * while every visible category placement keeps its own position.
 */
export const createIikoMenuSnapshot = (menu) => {
  const records = new Map();
  const categories = [];
  let productSortOrder = 0;

  arrayValue(menu?.itemCategories).forEach((category, categorySortOrder) => {
    const categoryId = String(category?.id ?? `category-${categorySortOrder}`);
    const categoryName = String(category?.name ?? 'Без категории').trim() || 'Без категории';
    const placements = [];

    arrayValue(category?.items).forEach((item, itemSortOrder) => {
      if (!item?.itemId) return;
      const productId = String(item.itemId);
      const sizes = arrayValue(item?.itemSizes);
      const size = sizes.find((value) => value?.isDefault) ?? sizes[0] ?? {};
      const placementHidden = Boolean(item?.isHidden || size?.isHidden);
      let record = records.get(productId);

      if (!record) {
        record = {
          productId,
          sku: String(item?.sku ?? size?.sku ?? '').trim(),
          categoryId,
          category: categoryName,
          categories: [],
          name: String(item?.name ?? 'Без названия').trim(),
          item,
          size,
          isHidden: true,
          sortOrder: productSortOrder++,
        };
        records.set(productId, record);
      }

      record.isHidden = record.isHidden && placementHidden;
      if (placementHidden) return;
      if (!record.categories.some((value) => value.id === categoryId)) {
        record.categories.push({ id: categoryId, name: categoryName });
      }
      if (!placements.some((placement) => placement.productId === productId)) {
        placements.push({ productId, sortOrder: itemSortOrder });
      }
    });

    categories.push({
      id: categoryId,
      name: categoryName,
      sortOrder: categorySortOrder,
      items: placements,
      raw: category,
    });
  });

  const products = [...records.values()].map((record) => {
    const primary = record.categories[0] ?? { id: record.categoryId, name: record.category };
    return { ...record, categoryId: primary.id, category: primary.name, categories: record.categories.length ? record.categories : [primary] };
  });

  return { products, categories };
};

export const normalizeIikoStopListGroups = (payload) => {
  const wrappers = Array.isArray(payload?.terminalGroupStopLists) ? payload.terminalGroupStopLists : [];
  return wrappers.flatMap((wrapper) => {
    if (wrapper?.terminalGroupId) return [wrapper];
    return Array.isArray(wrapper?.items) ? wrapper.items.filter((item) => item?.terminalGroupId) : [];
  });
};

export const calculateOrder = ({ lines, products, promotion = null }) => {
  const catalog = new Map((Array.isArray(products) ? products : []).map((item) => [String(item.id), item]));
  let subtotal = 0;
  const normalized = (Array.isArray(lines) ? lines : []).map((line) => {
    const product = catalog.get(String(line.productId));
    if (!product || product.available === false) throw new Error('Блюдо недоступно');
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('Некорректное количество');
    const groups = new Map((product.modifierGroups ?? []).map((group) => [String(group.id), group]));
    let modifiersTotal = 0;
    const modifiers = (line.modifiers ?? []).map((modifier) => {
      const group = groups.get(String(modifier.groupId));
      const option = group?.items?.find((item) => String(item.id) === String(modifier.productId));
      if (!group || !option) throw new Error('Модификатор недоступен');
      const amount = Number(modifier.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > Number(option.maxQuantity ?? group.maxQuantity ?? 99)) throw new Error('Некорректное количество модификатора');
      modifiersTotal += Number(option.price ?? 0) * amount;
      return { ...modifier, amount, price: Number(option.price ?? 0) };
    });
    for (const group of groups.values()) {
      const selected = modifiers.filter((item) => String(item.groupId) === String(group.id)).reduce((sum, item) => sum + item.amount, 0);
      if (selected < Number(group.minQuantity ?? 0) || selected > Number(group.maxQuantity ?? 99)) throw new Error('Нарушены правила группы модификаторов');
    }
    const lineTotal = (Number(product.price ?? 0) + modifiersTotal) * quantity;
    subtotal += lineTotal;
    return { productId: String(product.id), quantity, modifiers, lineTotal };
  });
  const rawDiscount = promotion?.type === 'percent' ? subtotal * Number(promotion.value ?? 0) / 100 : Number(promotion?.value ?? 0);
  const discount = Math.max(0, Math.min(subtotal, Math.round(rawDiscount || 0)));
  return { lines: normalized, subtotal, discount, total: subtotal - discount };
};

export const resolveTable = ({ fixed, selected, qr }) => {
  const table = fixed || qr || selected;
  if (!table?.id || !String(table.number ?? '').trim()) throw new Error('Стол не выбран');
  return { id: String(table.id), number: String(table.number), source: fixed ? 'admin' : qr ? 'qr' : 'guest' };
};

export const idempotencyDecision = (existing, requestHash) => {
  if (!existing) return 'create';
  if (existing.requestHash !== requestHash) return 'conflict';
  if (existing.status === 'success') return 'return-existing';
  if (existing.status === 'processing') return 'wait';
  return 'retry';
};

export const serviceRequestTransition = (current, action) => {
  const transitions = { new: { accept: 'accepted' }, accepted: { start: 'in_progress', complete: 'completed' }, in_progress: { complete: 'completed' } };
  const next = transitions[current]?.[action];
  if (!next) throw new Error('Недопустимый переход вызова');
  return next;
};
