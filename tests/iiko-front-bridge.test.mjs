import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeConnectionRegistry, normalizeBridgeEmployee, validateEmployeeSnapshot } from '../server/iiko-front-bridge.mjs';

test('normalizes an iikoFront employee without accepting secrets', () => {
  assert.deepEqual(normalizeBridgeEmployee({ id: ' u-1 ', displayName: ' Иван ', roleIds: ['r1', 'r1'], roleNames: ['Официант'], pin: '1111' }), {
    id: 'u-1', displayName: 'Иван', firstName: '', middleName: '', lastName: '', roleIds: ['r1'], roleNames: ['Официант'], isActive: true,
  });
});

test('rejects duplicate employees in a snapshot', () => {
  assert.throws(() => validateEmployeeSnapshot([{ id: '1', displayName: 'A' }, { id: '1', displayName: 'B' }]), /дубликаты/);
});

test('routes an authentication response to the originating request', async () => {
  const registry = new BridgeConnectionRegistry();
  let sent;
  registry.register({ bridgeId: 'bridge', restaurantId: 'restaurant', connectedAt: 1, socket: { readyState: 1, send: (value) => { sent = JSON.parse(value); } } });
  const resultPromise = registry.requestAuthentication('restaurant', '1111', 500);
  assert.equal(sent.pin, '1111');
  assert.equal(registry.resolveAuthentication({ type: 'auth_result', requestId: sent.requestId, ok: true, employee: { id: 'u-1', displayName: 'Иван' } }, 'bridge'), true);
  assert.equal((await resultPromise).employee.id, 'u-1');
});
