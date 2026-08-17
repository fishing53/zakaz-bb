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

export const deterministicUuid = (value) => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const validateMenuPublication = (items) => {
  const visible = (Array.isArray(items) ? items : []).filter((item) => !item.isHidden);
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
