import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStopList,
  calculateOrder,
  deterministicUuid,
  idempotencyDecision,
  iikoStatusStep,
  isDatabaseBackupFileName,
  normalizeIikoStopListGroups,
  resolveTable,
  serviceRequestTransition,
  validateMenuPublication,
} from '../server/core.mjs';

const products = [{
  id: 'pizza', sku: 'PIZZA-1', price: 500, available: true,
  modifierGroups: [{ id: 'sauces', minQuantity: 0, maxQuantity: 3, items: [{ id: 'cheese', price: 50, maxQuantity: 2 }, { id: 'bbq', price: 30 }] }],
}, { id: 'drink', sku: 'DRINK-1', price: 200, available: true, modifierGroups: [] }];

test('publishes a complete menu with unique SKU', () => {
  assert.deepEqual(validateMenuPublication(products), { ok: true, visible: 2, missingSku: 0, duplicateSkus: [] });
});

test('normalizes the wrapped iiko Cloud stop-list response', () => {
  const group = { terminalGroupId: 'terminal-group', items: [{ productId: 'pizza', balance: 0 }] };
  assert.deepEqual(normalizeIikoStopListGroups({ terminalGroupStopLists: [{ organizationId: 'restaurant', items: [group] }] }), [group]);
});

test('keeps compatibility with a direct stop-list group response', () => {
  const group = { terminalGroupId: 'terminal-group', items: [{ productId: 'pizza', balance: 0 }] };
  assert.deepEqual(normalizeIikoStopListGroups({ terminalGroupStopLists: [group] }), [group]);
});
test('rejects visible products without SKU', () => assert.equal(validateMenuPublication([{ id: 'x' }]).ok, false));
test('rejects duplicate SKU but ignores hidden seasonal items', () => {
  const result = validateMenuPublication([{ sku: 'A' }, { sku: 'A' }, { sku: '', isHidden: true }]);
  assert.deepEqual(result.duplicateSkus, ['A']);
});
test('applies and clears stop-list snapshots', () => {
  assert.equal(applyStopList(products, [{ productId: 'pizza', balance: 0 }])[0].available, false);
  assert.equal(applyStopList(products, [])[0].available, true);
});
test('calculates cart, quantity and optional modifiers', () => {
  const order = calculateOrder({ products, lines: [{ productId: 'pizza', quantity: 2, modifiers: [{ groupId: 'sauces', productId: 'cheese', amount: 1 }] }] });
  assert.equal(order.total, 1100);
});
test('rejects unavailable dishes', () => assert.throws(() => calculateOrder({ products: [{ ...products[0], available: false }], lines: [{ productId: 'pizza', quantity: 1 }] }), /недоступно/));
test('rejects an unknown modifier', () => assert.throws(() => calculateOrder({ products, lines: [{ productId: 'pizza', quantity: 1, modifiers: [{ groupId: 'sauces', productId: 'unknown', amount: 1 }] }] }), /Модификатор/));
test('checks mandatory modifier groups', () => {
  const required = [{ ...products[0], modifierGroups: [{ ...products[0].modifierGroups[0], minQuantity: 1 }] }];
  assert.throws(() => calculateOrder({ products: required, lines: [{ productId: 'pizza', quantity: 1, modifiers: [] }] }), /правила/);
});
test('checks modifier maximum', () => assert.throws(() => calculateOrder({ products, lines: [{ productId: 'pizza', quantity: 1, modifiers: [{ groupId: 'sauces', productId: 'cheese', amount: 3 }] }] }), /количество/));
test('applies percent promotion without negative total', () => assert.equal(calculateOrder({ products, lines: [{ productId: 'drink', quantity: 2 }], promotion: { type: 'percent', value: 10 } }).total, 360));
test('caps a fixed promotion at subtotal', () => assert.equal(calculateOrder({ products, lines: [{ productId: 'drink', quantity: 1 }], promotion: { type: 'fixed', value: 500 } }).total, 0));
test('fixed tablet table wins over guest and QR choices', () => assert.deepEqual(resolveTable({ fixed: { id: '1', number: '5' }, selected: { id: '2', number: '6' }, qr: { id: '3', number: '7' } }), { id: '1', number: '5', source: 'admin' }));
test('QR table wins when no table is fixed', () => assert.equal(resolveTable({ qr: { id: '3', number: '7' } }).source, 'qr'));
test('requires a table before placing an order', () => assert.throws(() => resolveTable({}), /не выбран/));
test('generates stable iiko order UUIDs for retries', () => assert.equal(deterministicUuid('restaurant:request'), deterministicUuid('restaurant:request')));
test('different client requests produce different UUIDs', () => assert.notEqual(deterministicUuid('a'), deterministicUuid('b')));
test('recognizes current and legacy database backup names', () => {
  assert.equal(isDatabaseBackupFileName('bb-kiosk-20260818T233000Z.dump'), true);
  assert.equal(isDatabaseBackupFileName('zakaz-20260818T233000Z.dump'), true);
  assert.equal(isDatabaseBackupFileName('bb-kiosk-20260818T233000Z.dump.partial'), false);
});
test('idempotency returns an existing successful order', () => assert.equal(idempotencyDecision({ requestHash: 'x', status: 'success' }, 'x'), 'return-existing'));
test('idempotency rejects a reused key with another cart', () => assert.equal(idempotencyDecision({ requestHash: 'x', status: 'success' }, 'y'), 'conflict'));
test('maps all guest-visible iiko kitchen stages', () => {
  assert.deepEqual([
    iikoStatusStep({ items: [{ status: 'Added' }] }),
    iikoStatusStep({ items: [{ status: 'PrintedNotCooking' }] }),
    iikoStatusStep({ items: [{ status: 'CookingStarted' }] }),
    iikoStatusStep({ items: [{ status: 'CookingCompleted' }] }),
    iikoStatusStep({ items: [{ status: 'Served' }] }),
  ], [0, 1, 2, 3, 4]);
});
test('does not move mixed cooking items backwards', () => assert.equal(iikoStatusStep({ items: [{ status: 'CookingStarted' }, { status: 'Added' }] }), 2));
test('validates waiter request lifecycle', () => {
  assert.equal(serviceRequestTransition('new', 'accept'), 'accepted');
  assert.equal(serviceRequestTransition('accepted', 'start'), 'in_progress');
  assert.equal(serviceRequestTransition('in_progress', 'complete'), 'completed');
  assert.throws(() => serviceRequestTransition('completed', 'accept'), /Недопустимый/);
});
