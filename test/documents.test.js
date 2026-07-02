import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDocumentRequirements,
  buildOrders,
  classifyObject,
  expandPrintDocumentCopies,
  filterOrders,
  orderToPrintSnapshot,
  summarizeDispatchCombos,
  summarizeOrders
} from '../src/documents.js';
import { attachOrderContexts } from '../src/orderContext.js';
import { buildPrintIndex } from '../src/stateStore.js';

test('classifies order document file names', () => {
  assert.deepEqual(classifyObject('order123.pdf'), {
    type: 'packingSlip',
    orderNumber: '123',
    fileName: 'order123.pdf'
  });
  assert.deepEqual(classifyObject('nested/parti123.pdf'), {
    type: 'attachment',
    orderNumber: '123',
    fileName: 'parti123.pdf'
  });
  assert.equal(classifyObject('invoice123.pdf'), null);
});

test('builds order packets from storage objects', () => {
  const orders = buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' },
    { name: 'order1002.pdf', updated: '2026-06-24T09:00:00.000Z', generation: '4' }
  ]);

  assert.equal(orders.length, 2);
  assert.equal(orders[0].orderNumber, '1002');
  assert.equal(orders[0].packetStatus, 'missing');
  assert.equal(orders[1].orderNumber, '1001');
  assert.equal(orders[1].packetStatus, 'pending');
});

test('marks current generations as printed and updated generations as pending', () => {
  const state = {
    printEvents: [
      {
        orderNumber: '1001',
        documentType: 'packingSlip',
        objectName: 'order1001.pdf',
        generation: '1',
        objectUpdated: '2026-06-24T08:00:00.000Z',
        printedAt: '2026-06-24T08:30:00.000Z',
        status: 'printed'
      }
    ]
  };

  const current = buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' }
  ], buildPrintIndex(state));

  assert.equal(current[0].documents.packingSlip.printStatus, 'printed');
  assert.equal(current[0].documents.attachment.printStatus, 'pending');

  const updated = buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:45:00.000Z', generation: '5' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' }
  ], buildPrintIndex(state));

  assert.equal(updated[0].documents.packingSlip.printStatus, 'reprint');
});

test('filters and summarizes packets', () => {
  const orders = buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' },
    { name: 'order1002.pdf', updated: '2026-06-24T09:00:00.000Z', generation: '4' }
  ]);

  assert.equal(filterOrders(orders, { q: '1002' }).length, 1);
  assert.equal(filterOrders(orders, { status: 'missing' }).length, 1);

  const summary = summarizeOrders(orders);
  assert.equal(summary.totalOrders, 2);
  assert.equal(summary.readyOrders, 1);
  assert.equal(summary.pendingDocuments, 4);
});

test('summarizes dispatch combo readiness', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' },
    { name: 'order1002.pdf', updated: '2026-06-24T09:00:00.000Z', generation: '4' }
  ]), new Map([
    ['1001', {
      deliveryDate: '2026-06-25',
      deliveryMethodName: 'Truck 12 Stockholm',
      dispatchTime: '06:00'
    }],
    ['1002', {
      deliveryDate: '2026-06-25',
      deliveryMethodName: 'Truck 12 Stockholm',
      dispatchTime: '06:00'
    }]
  ]));

  assert.deepEqual(summarizeDispatchCombos(orders), {
    totalCombos: 1,
    readyCombos: 0,
    blockedCombos: 1,
    needsPrintCombos: 0,
    printedCombos: 0
  });
});

test('does not require freight documents when freight is disabled', () => {
  const orders = buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' }
  ], undefined, {
    requiredTypes: ['packingSlip', 'attachment']
  });

  assert.deepEqual(orders[0].missingTypes, []);
  assert.equal(orders[0].packetStatus, 'pending');
});

test('requires freight only for freight orders when freight is enabled', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'order1002.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' },
    { name: 'parti1002.pdf', updated: '2026-06-24T08:03:00.000Z', generation: '4' }
  ]), new Map([
    ['1001', { freightRequired: false }],
    ['1002', { freightRequired: true, freightConsignmentNumbers: ['123456'] }]
  ]));

  const required = applyDocumentRequirements(orders, ['packingSlip', 'attachment', 'freight']);
  const byOrder = new Map(required.map((order) => [order.orderNumber, order]));

  assert.deepEqual(byOrder.get('1001').missingTypes, []);
  assert.equal(byOrder.get('1001').packetStatus, 'pending');
  assert.deepEqual(byOrder.get('1002').missingTypes, ['freight']);
  assert.equal(byOrder.get('1002').packetStatus, 'missing');
});

test('requires visible freight documents even without freight context', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' }
  ]), new Map([
    ['1001', { freightRequired: false }]
  ]));

  const required = applyDocumentRequirements(orders, ['packingSlip', 'attachment', 'freight']);

  assert.deepEqual(required[0].missingTypes, []);
  assert.deepEqual(required[0].requiredTypes, ['packingSlip', 'attachment', 'freight']);
  assert.equal(required[0].packetStatus, 'pending');
});

test('blocks document printing while warehouse packing is left', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' }
  ], undefined, {
    requiredTypes: ['packingSlip', 'attachment']
  }), new Map([
    ['1001', {
      deliveryDate: '2026-06-25',
      deliveryMethodName: 'Truck 12 Stockholm',
      dispatchTime: '06:00',
      packingBlocked: true,
      packingLinesLeft: 3,
      packingQuantityLeft: 12,
      packingDepartments: [
        { department: 'Dry', departmentBit: 1, linesLeft: 1, quantityLeft: 2 },
        { department: 'Frozen', departmentBit: 2, linesLeft: 2, quantityLeft: 10 }
      ]
    }]
  ]));

  const required = applyDocumentRequirements(orders, ['packingSlip', 'attachment']);

  assert.deepEqual(required[0].missingTypes, []);
  assert.equal(required[0].packingBlocked, true);
  assert.equal(required[0].packetStatus, 'blocked');
  assert.equal(filterOrders(required, { status: 'ready' }).length, 0);
  assert.equal(filterOrders(required, { status: 'blocked' }).length, 1);
  assert.equal(filterOrders(required, { q: 'frozen' }).length, 1);
  assert.equal(summarizeOrders(required).readyOrders, 0);
  assert.equal(summarizeOrders(required).blockedOrders, 1);
  assert.deepEqual(summarizeDispatchCombos(required), {
    totalCombos: 1,
    readyCombos: 0,
    blockedCombos: 1,
    needsPrintCombos: 0,
    printedCombos: 0
  });
});

test('filters orders by SQL context fields', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' },
    { name: 'order1002.pdf', updated: '2026-06-24T08:03:00.000Z', generation: '4' },
    { name: 'parti1002.pdf', updated: '2026-06-24T08:04:00.000Z', generation: '5' },
    { name: 'freight1002.pdf', updated: '2026-06-24T08:05:00.000Z', generation: '6' }
  ]), new Map([
    ['1001', {
      customerNo: 44021,
      customerName: 'Nordward Fresh Market',
      distributorNo: 0,
      distributorName: '',
      packerNo: 100,
      packerName: 'Anna Packer',
      deliveryMethodName: 'Truck 12 Stockholm',
      deliveryDate: '2026-06-25',
      dispatchTime: '06:00',
      orderNote: 'Morning route',
      topLines: [{ productNo: 'LAX-01', description: 'Fresh salmon fillet' }]
    }],
    ['1002', {
      customerNo: 44180,
      customerName: 'Matboden Uppsala',
      distributorNo: 77,
      distributorName: 'External Freight AB',
      deliveryMethodName: 'Uppsala linehaul',
      deliveryDate: '2026-06-26',
      dispatchTime: '12:00'
    }]
  ]));

  assert.equal(filterOrders(orders, { deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { deliveryDate: '2026-06-26' }).length, 1);
  assert.equal(filterOrders(orders, { deliveryDate: '2026-06-27' }).length, 0);
  assert.equal(filterOrders(orders, { q: 'fresh market', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'truck 12', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'anna packer', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'internal', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'external freight', deliveryDate: '2026-06-26' }).length, 1);
  assert.equal(filterOrders(orders, { q: '06:00', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'salmon', deliveryDate: '2026-06-25' }).length, 1);
  assert.equal(filterOrders(orders, { q: 'fresh market', deliveryDate: '2026-06-26' }).length, 0);
  assert.equal(filterOrders(orders, { q: 'not-found' }).length, 0);
});

test('prints four freight copies for DB Schenker Finland International', () => {
  const orders = attachOrderContexts(buildOrders([
    { name: 'order1001.pdf', updated: '2026-06-24T08:00:00.000Z', generation: '1' },
    { name: 'parti1001.pdf', updated: '2026-06-24T08:01:00.000Z', generation: '2' },
    { name: 'freight1001.pdf', updated: '2026-06-24T08:02:00.000Z', generation: '3' }
  ]), new Map([
    ['1001', {
      distributorNo: 123,
      distributorName: 'DB Schenker Finland International',
      freightRequired: true
    }]
  ]));

  const snapshot = orderToPrintSnapshot(orders[0], ['packingSlip', 'attachment', 'freight']);
  const freight = snapshot.documents.find((document) => document.type === 'freight');

  assert.equal(freight.printCopies, 4);

  const expanded = expandPrintDocumentCopies(snapshot.documents);
  assert.equal(expanded.filter((document) => document.type === 'packingSlip').length, 1);
  assert.equal(expanded.filter((document) => document.type === 'attachment').length, 1);
  assert.equal(expanded.filter((document) => document.type === 'freight').length, 4);
  assert.deepEqual(
    expanded.filter((document) => document.type === 'freight').map((document) => document.typeLabel),
    [
      'Freight document copy 1/4',
      'Freight document copy 2/4',
      'Freight document copy 3/4',
      'Freight document copy 4/4'
    ]
  );
});
