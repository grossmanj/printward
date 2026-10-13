import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrdersCache, listCurrentOrders } from '../src/server.js';

test('automatic refresh waits for expired order cache and shares one rebuild', async () => {
  let currentOrders = ['100'];
  let reads = 0;
  const orderContext = {
    mode: 'mock',
    async getByDeliveryDate() {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Map(currentOrders.map((orderNumber) => [orderNumber, {
        orderNumber, deliveryMethod: 7, deliveryMethodName: 'UEJ 64A',
        dispatchPriority: 8, deliveryDate: '2026-10-13'
      }]));
    }
  };
  const storage = { async getObjectMetadata() { return null; } };
  const store = { async getState() { return { printEvents: [] }; } };
  const config = {
    gcs: { mode: 'mock', prefix: '' },
    documentTypes: { required: ['packingSlip', 'attachment'], visible: ['packingSlip', 'attachment'] }
  };
  const cache = createOrdersCache({ ordersCacheMs: 60_000 });
  const options = { deliveryDate: '2026-10-13', waitForFresh: true };

  const first = await listCurrentOrders(storage, store, orderContext, config, cache, options);
  assert.equal(first.contextStatus.available, true, first.contextStatus.error);
  assert.deepEqual(first.orders.map((order) => order.orderNumber), ['100']);
  assert.equal(reads, 1);

  currentOrders = ['100', '101'];
  const stillFresh = await listCurrentOrders(storage, store, orderContext, config, cache, options);
  assert.deepEqual(stillFresh.orders.map((order) => order.orderNumber), ['100']);
  assert.equal(reads, 1);

  cache.entries.get('deliveryDate:2026-10-13').expiresAt = 0;
  const [updated, concurrent] = await Promise.all([
    listCurrentOrders(storage, store, orderContext, config, cache, options),
    listCurrentOrders(storage, store, orderContext, config, cache, options)
  ]);
  assert.deepEqual(updated.orders.map((order) => order.orderNumber), ['100', '101']);
  assert.deepEqual(concurrent.orders.map((order) => order.orderNumber), ['100', '101']);
  assert.equal(reads, 2);
});
