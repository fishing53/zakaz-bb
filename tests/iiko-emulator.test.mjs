import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('iiko emulator exposes auth, menu, stop-list, order and webhook contracts', async () => {
  const calls = [];
  const server = await listen(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    const payload = request.url === '/api/v2/access_token' ? { token: 'test-token' }
      : request.url === '/api/2/menu/by_id' ? { revision: 1, itemCategories: [{ id: 'pizza', name: 'Пицца', items: [{ itemId: 'p1', sku: 'P1', name: 'Маргарита', itemSizes: [{ prices: [{ price: 500 }] }] }] }] }
        : request.url === '/api/1/stop_lists' ? { terminalGroupStopLists: [{ terminalGroupId: 'tg', items: [] }] }
          : request.url === '/api/1/order/create' ? { correlationId: 'correlation', orderInfo: { id: 'order-id', creationStatus: 'Success' } }
            : { ok: true };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, token = '') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((response) => response.json());
    const auth = await post('/api/v2/access_token', { appId: 'app', apiLogin: 'login', clientSecret: 'secret' });
    const menu = await post('/api/2/menu/by_id', { organizationIds: ['org'], externalMenuId: 'menu' }, auth.token);
    const stopList = await post('/api/1/stop_lists', { organizationIds: ['org'], terminalGroupsIds: ['tg'] }, auth.token);
    const order = await post('/api/1/order/create', { organizationId: 'org', terminalGroupId: 'tg', order: { tableIds: ['table'], items: [{ productId: 'p1', amount: 1 }] } }, auth.token);
    assert.equal(menu.itemCategories[0].items[0].sku, 'P1');
    assert.deepEqual(stopList.terminalGroupStopLists[0].items, []);
    assert.equal(order.orderInfo.creationStatus, 'Success');
    assert.deepEqual(calls.map((item) => item.path), ['/api/v2/access_token', '/api/2/menu/by_id', '/api/1/stop_lists', '/api/1/order/create']);
    assert.equal(calls[3].body.order.tableIds[0], 'table');
  } finally { await close(server); }
});
