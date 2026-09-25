import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { projectRoot } from '../src/config.js';
import { planFreightDocumentSelection } from '../src/dashboardRules.js';
import { MockGcsClient } from '../src/gcsClient.js';
import { createPlaceholderPdf } from '../src/pdf.js';
import { verifyFreightPacket } from '../src/server.js';

const storage = new MockGcsClient(path.join(projectRoot, 'data', 'mock-gcs-objects.json'));

async function palletOrder(number, context) {
  const name = `pallet${number}.pdf`;
  const metadata = await storage.getObjectMetadata(name);
  return {
    orderNumber: number,
    context: {
      distributorNo: 7331697,
      distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      palletDocumentRequired: true,
      ...context
    },
    missingTypes: [],
    documents: { pallet: { ...metadata, type: 'pallet', fileName: name } }
  };
}

async function dsvOrder(number, context) {
  const name = `freight${number}.pdf`;
  const metadata = await storage.getObjectMetadata(name);
  return {
    orderNumber: number,
    context: { distributorNo: 50063993, distributorName: 'DSV Finland', ...context },
    missingTypes: [],
    documents: { freight: { ...metadata, type: 'freight', fileName: name } }
  };
}

test('read-only PDF preflight verifies actual mock page order for chilled and frozen freight', async () => {
  const order = await palletOrder('900001', {
    deliveryMethod: 20,
    freightConsignmentFresh: 'TEST-KYLT-01',
    freightConsignmentFrozen: 'TEST-FRYST-02'
  });
  const plan = planFreightDocumentSelection([order], 'kyl-and-frys', ['900001']);
  const result = await verifyFreightPacket(storage, [order], plan);
  assert.equal(result.verifiedFiles[0].pageCount, 4);
  assert.deepEqual(result.sections.map((section) => section.sectionType), [
    'pallet-label-1', 'pallet-label-2', 'frozen-freight', 'cooling-freight'
  ]);
  assert.deepEqual(result.sections.map((section) => section.documents[0].pages), ['1', '2', '3', '4']);
  assert.ok(result.sections.every((section) => section.documents.every((document) => document.type === 'pallet')));
});

test('Eriksson uses the same PDF preflight and DSV verifies a freight-only PDF', async () => {
  const eriksson = await palletOrder('900002', {
    deliveryMethod: 25,
    freightConsignmentFresh: 'TEST-ERIKSSON-16'
  });
  const erikssonPlan = planFreightDocumentSelection([eriksson], 'eriksson', ['900002']);
  const erikssonResult = await verifyFreightPacket(storage, [eriksson], erikssonPlan);
  assert.deepEqual(erikssonResult.sections.map((section) => section.sectionType), [
    'pallet-label-1', 'cooling-freight'
  ]);

  const dsv = {
    orderNumber: '400',
    context: { distributorNo: 50063993, deliveryMethod: 47 },
    missingTypes: [],
    documents: { freight: { name: 'freight400.pdf', source: 'primary', generation: '1', type: 'freight', fileName: 'freight400.pdf' } }
  };
  const dsvStorage = { getObject: async () => ({ body: createPlaceholderPdf('FRAKTSEDEL DSV Finland') }) };
  const dsvPlan = planFreightDocumentSelection([dsv], 'dsv-finland', ['400']);
  const dsvResult = await verifyFreightPacket(dsvStorage, [dsv], dsvPlan);
  assert.equal(dsvResult.verifiedFiles[0].pageCount, 1);
  assert.deepEqual(dsvResult.sections.map((section) => section.sectionType), ['freight']);
  assert.deepEqual(dsvResult.sections[0].documents.map((document) => document.type), ['freight']);
});

test('DSV routes 47 and 48 verify in order with freight-only four-copy sections', async () => {
  const late = await dsvOrder('900005', {
    deliveryMethod: 48,
    dispatchPriority: 13,
    freightConsignmentFrozen: 'TEST-DSV-FRYST-13'
  });
  const early = await dsvOrder('900004', {
    deliveryMethod: 47,
    dispatchPriority: 7,
    freightConsignmentFresh: 'TEST-DSV-KYLT-07'
  });
  const orders = [late, early];
  const plan = planFreightDocumentSelection(orders, 'dsv-finland', ['900005', '900004']);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.orders.map((order) => order.orderNumber), ['900004', '900005']);
  assert.deepEqual(plan.orders.map((order) => order.bookings), [
    [{ kind: 'Kylt', number: 'TEST-DSV-KYLT-07' }],
    [{ kind: 'Fryst', number: 'TEST-DSV-FRYST-13' }]
  ]);
  assert.deepEqual(plan.excludes, ['packingSlip', 'attachment']);

  const result = await verifyFreightPacket(storage, orders, plan);
  assert.deepEqual(result.verifiedFiles.map((file) => file.pageCount), [1, 1]);
  assert.deepEqual(result.sections.map((section) => section.orderNumber), ['900004', '900005']);
  assert.ok(result.sections.every((section) => section.sectionType === 'freight'));
  assert.ok(result.sections.every((section) => section.documents.length === 1
    && section.documents[0].type === 'freight'
    && section.documents[0].pageCopies === 4));
});

test('PDF preflight fails closed when expected Kyl freight pages are missing', async () => {
  const order = {
    orderNumber: '500',
    context: {
      distributorNo: 7331697,
      distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      deliveryMethod: 25,
      freightConsignmentFresh: 'FRESH-500',
      palletDocumentRequired: true
    },
    missingTypes: [],
    documents: { pallet: { name: 'pallet500.pdf', source: 'primary', generation: '1', type: 'pallet', fileName: 'pallet500.pdf' } }
  };
  const wrongStorage = { getObject: async () => ({ body: createPlaceholderPdf('Endast etikett') }) };
  const plan = planFreightDocumentSelection([order], 'eriksson', ['500']);
  await assert.rejects(() => verifyFreightPacket(wrongStorage, [order], plan), /No Cooling freight pages detected/);
});
