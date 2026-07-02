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
  assert.equal(orders[0].context.distributorNo, 0);
  assert.equal(orders[0].context.distributorName, '');
  assert.equal(orders[0].context.freightRequired, false);
  assert.deepEqual(orders[0].context.freightConsignmentNumbers, []);
  assert.equal(orders[0].context.deliveryMethodName, '');
  assert.equal(orders[0].context.dispatchTime, null);
  assert.equal(orders[0].context.packerNo, 0);
  assert.equal(orders[0].context.packerName, '');
  assert.deepEqual(orders[0].context.packingDepartments, []);
  assert.equal(orders[0].context.packingLinesLeft, 0);
  assert.equal(orders[0].context.packingQuantityLeft, 0);
  assert.equal(orders[0].context.packingBlocked, false);
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

  assert.match(queries[0], /WHERE o\.DelDt = @delDt\s+AND o\.TrTp = 1\s+AND \(ISNULL\(o\.OrdPrSt, 0\) & 536870912\) = 0\s+AND \(\(ISNULL\(o\.OrdPrSt, 0\) & 8\) = 8 OR \(ISNULL\(o\.OrdPrSt, 0\) & 8192\) = 8192\)\s+AND ISNULL\(o\.DelMt, 0\) NOT IN \(150, 151\)/);
  assert.match(queries[1], /FROM Ord o[\s\S]*INNER JOIN @OrderNos f ON f\.OrdNo = o\.OrdNo[\s\S]*WHERE o\.TrTp = 1\s+AND \(ISNULL\(o\.OrdPrSt, 0\) & 536870912\) = 0\s+AND \(\(ISNULL\(o\.OrdPrSt, 0\) & 8\) = 8 OR \(ISNULL\(o\.OrdPrSt, 0\) & 8192\) = 8192\)\s+AND ISNULL\(o\.DelMt, 0\) NOT IN \(150, 151\);/);
  assert.match(queries[1], /ISNULL\(NULLIF\(o\.Nm, ''\), ISNULL\(customer\.Nm, ''\)\) AS CustomerName/);
  assert.match(queries[1], /ISNULL\(o\.SupNo, 0\) AS SupNo/);
  assert.match(queries[1], /WHERE a\.SupNo = o\.SupNo/);
  assert.match(queries[1], /ISNULL\(distributor\.Nm, ''\) AS DistributorName/);
  assert.match(queries[1], /ISNULL\(o\.Rsp, 0\) AS Rsp/);
  assert.match(queries[1], /WHERE a\.EmpNo = o\.Rsp/);
  assert.match(queries[1], /AND ISNULL\(o\.Rsp, 0\) > 0/);
  assert.match(queries[1], /ISNULL\(packer\.Nm, ''\) AS PackerName/);
  assert.match(queries[1], /CASE WHEN ISNULL\(o\.SupNo, 0\) > 0 THEN 1 ELSE 0 END AS FreightRequired/);
  assert.equal([...queries[1].matchAll(/\(ISNULL\(l\.ExcPrint, 0\) & 16384\) = 0/g)].length, 3);
  assert.match(queries[1], /LinesLeftToPack AS/);
  assert.match(queries[1], /QuantityLeftToPack = CAST\(ROUND\(SUM\(ISNULL\(NoInvoAb, 0\)\), 2\) AS DECIMAL\(18, 2\)\)/);
});

test('SQL order context marks external distributors as freight-required', async () => {
  const client = new SqlServerOrderContextClient({
    maxOrdersPerQuery: 500,
    freightBookedStatuses: [2, 8]
  });

  client.getSql = async () => ({ Int: 'Int' });
  client.getPool = async () => ({
    request() {
      return {
        input() {},
        async query() {
          return {
            recordsets: [
              [{
                OrdNo: 123,
                CustNo: 456,
                Nm: 'Customer AB',
                CustomerName: 'Customer AB',
                SupNo: 789,
                DistributorName: 'External Freight AB',
                Rsp: 321,
                PackerName: 'Warehouse Packer',
                DelDt: 20260702,
                DelPri: 12,
                DelMt: 5,
                TrTp: 1,
                OrdTp: 1,
                OrdPrSt: 8,
                FreightRequired: 1,
                FreightConsignmentFresh: 'ABC'
              }],
              [{ OrdNo: 123, LineCount: 1, TotalQuantity: 4 }],
              [{ OrdNo: 123, LnNo: 1, ProdNo: 'P1', Descr: 'Product', Quantity: 4, Unit: 'kg', Note: '' }],
              [{ OrdNo: 123, Department: 'Frozen', DepartmentBit: 2, LinesLeftToPack: 2, QuantityLeftToPack: 6 }]
            ]
          };
        }
      };
    }
  });

  const contexts = await client.fetchBatch([123]);
  const context = contexts.get('123');

  assert.equal(context.distributorNo, 789);
  assert.equal(context.distributorName, 'External Freight AB');
  assert.equal(context.packerNo, 321);
  assert.equal(context.packerName, 'Warehouse Packer');
  assert.equal(context.freightRequired, true);
  assert.equal(context.dispatchTime, '12:00');
  assert.equal(context.lineCount, 1);
  assert.equal(context.packingBlocked, true);
  assert.equal(context.packingLinesLeft, 2);
  assert.equal(context.packingQuantityLeft, 6);
  assert.deepEqual(context.packingDepartments, [{
    department: 'Frozen',
    departmentBit: 2,
    linesLeft: 2,
    quantityLeft: 6
  }]);
});
