import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachOrderContexts,
  dispatchPriorityToTime,
  isoDateToVismaDate,
  MockOrderContextClient,
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
  assert.equal(orders[0].context.customerPaymentTerm, null);
  assert.equal(orders[0].context.customerChainNo, null);
  assert.equal(orders[0].context.distributorName, '');
  assert.equal(orders[0].context.routeGroup, null);
  assert.equal(orders[0].context.freightRequired, false);
  assert.deepEqual(orders[0].context.freightConsignmentNumbers, []);
  assert.equal(orders[0].context.freightPalletCopies, 0);
  assert.equal(orders[0].context.palletDocumentRequired, false);
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
  await client.getReturnsByDeliveryDate('2026-07-01');
  await client.getPickupsByDeliveryDate('2026-07-01');
  await client.fetchBatch([1956706], { includePickups: true });
  await client.fetchBatch([1956707], { includeReturns: true });

  assert.match(queries[0], /WHERE o\.DelDt = @delDt\s+AND o\.TrTp = 1\s+AND \(ISNULL\(o\.OrdPrSt, 0\) & 536870912\) = 0\s+AND \(\(ISNULL\(o\.OrdPrSt, 0\) & 8\) = 8 OR \(ISNULL\(o\.OrdPrSt, 0\) & 8192\) = 8192\)\s+AND ISNULL\(o\.Gr3, 0\) <> 30\s+AND ISNULL\(o\.DelMt, 0\) NOT IN \(6, 40, 150, 151, 152\)/);
  assert.match(queries[1], /FROM Ord o[\s\S]*INNER JOIN @OrderNos f ON f\.OrdNo = o\.OrdNo[\s\S]*WHERE o\.TrTp = 1\s+AND \(ISNULL\(o\.OrdPrSt, 0\) & 536870912\) = 0\s+AND \(\(ISNULL\(o\.OrdPrSt, 0\) & 8\) = 8 OR \(ISNULL\(o\.OrdPrSt, 0\) & 8192\) = 8192\)\s+AND ISNULL\(o\.Gr3, 0\) <> 30 AND ISNULL\(o\.DelMt, 0\) NOT IN \(6, 40, 150, 151, 152\);/);
  assert.match(queries[1], /ISNULL\(NULLIF\(o\.Nm, ''\), ISNULL\(customer\.Nm, ''\)\) AS CustomerName/);
  assert.match(queries[1], /ISNULL\(customer\.CPmtTrm, 0\) AS CustomerPaymentTerm/);
  assert.match(queries[1], /ISNULL\(customer\.R12, 0\) AS CustomerChainNo/);
  assert.match(queries[1], /SELECT TOP 1 a\.Nm, a\.CPmtTrm, a\.R12\s+FROM Actor a\s+WHERE a\.CustNo = o\.CustNo/);
  assert.match(queries[1], /ISNULL\(o\.SupNo, 0\) AS SupNo/);
  assert.match(queries[1], /o\.Gr2,/);
  assert.match(queries[1], /o\.Gr3,/);
  assert.match(queries[1], /WHERE a\.SupNo = o\.SupNo/);
  assert.match(queries[1], /ISNULL\(distributor\.Nm, ''\) AS DistributorName/);
  assert.match(queries[1], /ISNULL\(o\.Rsp, 0\) AS Rsp/);
  assert.match(queries[1], /WHERE a\.EmpNo = o\.Rsp/);
  assert.match(queries[1], /AND ISNULL\(o\.Rsp, 0\) > 0/);
  assert.match(queries[1], /ISNULL\(packer\.Nm, ''\) AS PackerName/);
  assert.match(queries[0], /ISNULL\(o\.Gr3, 0\) <> 30/);
  assert.match(queries[1], /ISNULL\(o\.Gr3, 0\) <> 30 AND ISNULL\(o\.DelMt, 0\) NOT IN/);
  assert.match(queries[1], /ISNULL\(o\.SupNo, 0\) NOT IN \(55058127\)/);
  assert.match(queries[1], /LOWER\(LTRIM\(RTRIM\(ISNULL\(distributor\.Nm, ''\)\)\)\) NOT IN \('best transport ab'\)/);
  assert.match(queries[1], /ISNULL\(freight\.Val2, 0\) AS FreightVal2/);
  assert.match(queries[1], /ISNULL\(freight\.Val7, 0\) AS FreightVal7/);
  assert.equal([...queries[1].matchAll(/\(ISNULL\(l\.ExcPrint, 0\) & 16384\) = 0/g)].length, 3);
  assert.match(queries[1], /LinesLeftToPack AS/);
  assert.match(queries[1], /QuantityLeftToPack = CAST\(ROUND\(SUM\(ISNULL\(NoInvoAb, 0\)\), 2\) AS DECIMAL\(18, 2\)\)/);
  assert.match(queries[2], /ISNULL\(o\.Gr3, 0\) = 30/);
  assert.doesNotMatch(queries[2], /ISNULL\(o\.DelMt, 0\) = 151/);
  assert.doesNotMatch(queries[2], /OrdPrSt, 0\) & (8|8192)/);
  assert.match(queries[3], /ISNULL\(o\.DelMt, 0\) IN \(6, 16, 42, 43, 44, 45, 46\)/);
  assert.match(queries[3], /ISNULL\(o\.Gr3, 0\) <> 30/);
  assert.match(queries[4], /ISNULL\(o\.DelMt, 0\) IN \(6, 16, 42, 43, 44, 45, 46\);/);
  assert.match(queries[4], /ISNULL\(o\.Gr3, 0\) <> 30/);
  assert.match(queries[5], /ISNULL\(o\.Gr3, 0\) = 30;/);
  assert.doesNotMatch(queries[5], /ISNULL\(o\.DelMt, 0\) = 151/);
  assert.doesNotMatch(queries[5], /OrdPrSt, 0\) & (8|8192)/);
});

test('return grouping follows Gr3 even after delivery method changes', async () => {
  const client = new MockOrderContextClient('unused');
  client.cache = new Map([
    ['1', { orderNumber: '1', deliveryDate: '2026-09-24', deliveryMethod: 151, returnGroup: 30 }],
    ['2', { orderNumber: '2', deliveryDate: '2026-09-24', deliveryMethod: 7, returnGroup: 30 }],
    ['3', { orderNumber: '3', deliveryDate: '2026-09-24', deliveryMethod: 6, returnGroup: 30 }],
    ['4', { orderNumber: '4', deliveryDate: '2026-09-24', deliveryMethod: 7, returnGroup: 31 }]
  ]);

  assert.deepEqual([...await client.getReturnsByDeliveryDate('2026-09-24')].map(([number]) => number), ['1', '2', '3']);
  assert.deepEqual([...await client.getByDeliveryDate('2026-09-24')].map(([number]) => number), ['4']);
  assert.deepEqual([...await client.getPickupsByDeliveryDate('2026-09-24')], []);
});

test('date-scoped SQL reads every page and batches context lookups', async () => {
  const client = new SqlServerOrderContextClient({ maxOrdersPerQuery: 500 });
  const inputs = [];
  const contextBatches = [];
  client.getSql = async () => ({ Int: 'Int' });
  client.getPool = async () => ({
    request() {
      const parameters = {};
      return {
        input(name, _type, value) { parameters[name] = value; },
        async query(sql) {
          inputs.push({ ...parameters, sql });
          const pages = [Array.from({ length: 500 }, (_, index) => index + 1), [501]];
          return { recordset: (pages[parameters.offset / 500] || []).map((OrdNo) => ({ OrdNo })) };
        }
      };
    }
  });
  client.getByOrderNumbers = async (batch) => {
    contextBatches.push(batch);
    return new Map(batch.map((number) => [String(number), { orderNumber: String(number) }]));
  };

  const contexts = await client.getByDeliveryDate('2026-09-25');
  assert.equal(contexts.size, 501);
  assert.deepEqual([...contexts.keys()].slice(-2), ['500', '501']);
  assert.deepEqual(contextBatches.map((batch) => batch.length), [500, 1]);
  assert.deepEqual(inputs.map(({ offset, limit }) => [offset, limit]), [[0, 500], [500, 500]]);
  assert.ok(inputs.every(({ sql }) => /OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY/.test(sql)));
});

test('return and pickup date reads also continue beyond one SQL page', async () => {
  const client = new SqlServerOrderContextClient({ maxOrdersPerQuery: 2 });
  client.getSql = async () => ({ Int: 'Int' });
  client.getPool = async () => ({
    request() {
      const parameters = {};
      return {
        input(name, _type, value) { parameters[name] = value; },
        async query() {
          return { recordset: ([[201, 202], [203]][parameters.offset / 2] || []).map((OrdNo) => ({ OrdNo })) };
        }
      };
    }
  });
  const batches = [];
  client.fetchBatch = async (batch, options) => {
    batches.push({ batch, options });
    return new Map(batch.map((number) => [String(number), { orderNumber: String(number) }]));
  };

  assert.equal((await client.getReturnsByDeliveryDate('2026-09-25')).size, 3);
  assert.equal((await client.getPickupsByDeliveryDate('2026-09-25')).size, 3);
  assert.deepEqual(batches.map(({ batch }) => batch), [[201, 202], [203], [201, 202], [203]]);
  assert.deepEqual(batches.map(({ options }) => options), [
    { includeReturns: true }, { includeReturns: true },
    { includePickups: true }, { includePickups: true }
  ]);
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
                CustomerPaymentTerm: 1,
                CustomerChainNo: 60,
                SupNo: 789,
                DistributorName: 'Kyl- och Frysexpressen Mälardalen AB',
                Rsp: 321,
                PackerName: 'Warehouse Packer',
                DelDt: 20260702,
                DelPri: 12,
                DelMt: 5,
                TrTp: 1,
                OrdTp: 1,
                Gr2: 25,
                OrdPrSt: 8,
                FreightRequired: 1,
                FreightConsignmentFresh: 'ABC',
                FreightVal2: 2,
                FreightVal4: 10,
                FreightVal5: 1
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
  assert.equal(context.customerPaymentTerm, 1);
  assert.equal(context.customerChainNo, 60);
  assert.equal(context.distributorName, 'Kyl- och Frysexpressen Mälardalen AB');
  assert.equal(context.routeGroup, 25);
  assert.equal(context.packerNo, 321);
  assert.equal(context.packerName, 'Warehouse Packer');
  assert.equal(context.freightRequired, true);
  assert.equal(context.freightPalletCopies, 3);
  assert.equal(context.palletDocumentRequired, true);
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

test('SQL order context requires Kyl pallet bundle even when pallet count is zero', async () => {
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
                OrdNo: 1962425,
                CustNo: 456,
                Nm: 'Customer AB',
                CustomerName: 'Customer AB',
                SupNo: 789,
                DistributorName: 'Kyl- och Frysexpressen Mälardalen AB',
                DelDt: 20260707,
                DelPri: 12,
                DelMt: 5,
                TrTp: 1,
                OrdTp: 1,
                OrdPrSt: 8,
                FreightRequired: 1,
                FreightConsignmentFresh: '0065247256',
                FreightVal2: 0,
                FreightVal3: 0,
                FreightVal5: 0,
                FreightVal6: 0
              }],
              [],
              [],
              []
            ]
          };
        }
      };
    }
  });

  const contexts = await client.fetchBatch([1962425]);
  const context = contexts.get('1962425');

  assert.equal(context.freightPalletCopies, 0);
  assert.equal(context.palletDocumentRequired, true);
});

test('SQL order context treats Best Transport as freight-optional for now', async () => {
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
                OrdNo: 124,
                CustNo: 456,
                Nm: 'Customer AB',
                CustomerName: 'Customer AB',
                SupNo: 55058127,
                DistributorName: 'Best Transport AB',
                DelDt: 20260702,
                DelPri: 12,
                DelMt: 5,
                TrTp: 1,
                OrdTp: 1,
                OrdPrSt: 8
              }],
              [{ OrdNo: 124, LineCount: 1, TotalQuantity: 4 }],
              [{ OrdNo: 124, LnNo: 1, ProdNo: 'P1', Descr: 'Product', Quantity: 4, Unit: 'kg', Note: '' }],
              []
            ]
          };
        }
      };
    }
  });

  const contexts = await client.fetchBatch([124]);
  const context = contexts.get('124');

  assert.equal(context.distributorNo, 55058127);
  assert.equal(context.distributorName, 'Best Transport AB');
  assert.equal(context.freightRequired, false);
});
