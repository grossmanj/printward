import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachOrderContexts,
  dispatchPriorityToTime,
  isoDateToVismaDate,
  SqlServerOrderContextClient,
  vismaDateTimeToIso,
  vismaDateToIsoDate
} from '../src/orderContext.js';

test('converts Visma integer dates', () => {
  assert.equal(vismaDateToIsoDate(20260624), '2026-06-24');
  assert.equal(isoDateToVismaDate('2026-06-24'), 20260624);
  assert.equal(vismaDateTimeToIso(20260624, 915), '2026-06-24T09:15:00');
  assert.equal(vismaDateToIsoDate(0), null);
});

test('converts Visma delivery priority to departure time', () => {
  assert.equal(dispatchPriorityToTime(6), '06:00');
  assert.equal(dispatchPriorityToTime(12), '12:00');
  assert.equal(dispatchPriorityToTime(0), null);
});

test('attaches missing order context safely', () => {
  const orders = attachOrderContexts([{ orderNumber: '123' }], new Map());
  assert.equal(orders[0].context.available, false);
  assert.equal(orders[0].context.orderNumber, '123');
  assert.equal(orders[0].context.freightRequired, false);
  assert.deepEqual(orders[0].context.freightConsignmentNumbers, []);
  assert.equal(orders[0].context.deliveryMethodName, '');
  assert.equal(orders[0].context.dispatchTime, null);
});

test('SQL order context filters sales transaction headers', async () => {
  const queries = [];
  const client = new SqlServerOrderContextClient({
    maxOrdersPerQuery: 500,
    freightBookedStatuses: [2, 8]
  });

  client.getSql = async () => ({ Int: 'Int' });
  client.getPool = async () => ({
    request() {
      return {
        input() {},
        async query(sql) {
          queries.push(sql);
          return {
            recordset: [],
            recordsets: [[], [], []]
          };
        }
      };
    }
  });

  await client.getByDeliveryDate('2026-07-01');
  await client.fetchBatch([1956705]);

  assert.match(queries[0], /WHERE o\.DelDt = @delDt\s+AND o\.TrTp = 1/);
  assert.match(queries[1], /FROM Ord o[\s\S]*INNER JOIN @OrderNos f ON f\.OrdNo = o\.OrdNo[\s\S]*WHERE o\.TrTp = 1;/);
  assert.match(queries[1], /ISNULL\(NULLIF\(o\.Nm, ''\), ISNULL\(customer\.Nm, ''\)\) AS CustomerName/);
});
