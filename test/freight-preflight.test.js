import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { projectRoot } from '../src/config.js';
import { planFreightDocumentSelection } from '../src/dashboardRules.js';
import { MockGcsClient } from '../src/gcsClient.js';
import { mergePdfBuffers } from '../src/freightSync.js';
import { createPlaceholderPdf } from '../src/pdf.js';
import { prepareBulkFreightPrint, verifyFreightPacket } from '../src/server.js';

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
    'frozen-freight-packet', 'cooling-freight-packet'
  ]);
  assert.deepEqual(result.sections.map((section) => section.documents[0].pages), ['2-3', '1,4']);
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
    'cooling-freight-packet'
  ]);

  const dsv = {
    orderNumber: '400',
    context: { distributorNo: 50063993, deliveryMethod: 47, freightConsignmentFresh: 'DSV-400' },
    missingTypes: [],
    documents: { freight: { name: 'freight400.pdf', source: 'primary', generation: '1', type: 'freight', fileName: 'freight400.pdf' } }
  };
  const dsvBody = await mergePdfBuffers([
    createPlaceholderPdf('ETIKETT DSV Finland DSV-400'),
    createPlaceholderPdf('FRAKTSEDEL DSV Finland DSV-400')
  ]);
  const dsvStorage = { getObject: async () => ({ body: dsvBody }) };
  const dsvPlan = planFreightDocumentSelection([dsv], 'dsv-finland', ['400']);
  const dsvResult = await verifyFreightPacket(dsvStorage, [dsv], dsvPlan);
  assert.equal(dsvResult.verifiedFiles[0].pageCount, 2);
  assert.deepEqual(dsvResult.sections.map((section) => section.sectionType), ['cooling-dsv-packet']);
  assert.deepEqual(dsvResult.sections[0].documents.map((document) => document.type), ['freight', 'freight']);
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
  assert.deepEqual(result.verifiedFiles.map((file) => file.pageCount), [2, 2]);
  assert.deepEqual(result.sections.map((section) => section.orderNumber), ['900004', '900005']);
  assert.deepEqual(result.sections.map((section) => section.sectionType),
    ['cooling-dsv-packet', 'frozen-dsv-packet']);
  assert.ok(result.sections.every((section) => section.documents.length === 2
    && section.documents[0].type === 'freight'
    && section.documents[0].pageCopies === 1
    && section.documents[1].pageCopies === 4));
});

test('DSV preflight refuses a PDF missing one of two booked waybills', async () => {
  const order = {
    orderNumber: '401',
    context: {
      distributorNo: 50063993, deliveryMethod: 47,
      freightConsignmentFresh: 'CHILLED-401',
      freightConsignmentFrozen: 'FROZEN-401'
    },
    missingTypes: [],
    documents: { freight: { name: 'freight401.pdf', source: 'freight', generation: '1', type: 'freight' } }
  };
  const oneWaybill = { getObject: async () => ({ body: createPlaceholderPdf('FRAKTSEDEL CHILLED-401') }) };
  const plan = planFreightDocumentSelection([order], 'dsv-finland', ['401']);
  await assert.rejects(() => verifyFreightPacket(oneWaybill, [order], plan),
    /Missing DSV waybill for frozen booking FROZEN-401/);
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

test('PDF preflight refuses to guess which of two bookings owns an unmarked label', async () => {
  const order = {
    orderNumber: '501',
    context: {
      distributorNo: 7331697,
      distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      deliveryMethod: 20,
      freightConsignmentFresh: 'FRESH-501',
      freightConsignmentFrozen: 'FROZEN-501',
      palletDocumentRequired: true
    },
    missingTypes: [],
    documents: { pallet: { name: 'pallet501.pdf', source: 'primary', generation: '1', type: 'pallet', fileName: 'pallet501.pdf' } }
  };
  const ambiguous = { getObject: async () => ({ body: createPlaceholderPdf('Kolli-ID utan bokningsnummer') }) };
  const plan = planFreightDocumentSelection([order], 'kyl-and-frys', ['501']);
  await assert.rejects(() => verifyFreightPacket(ambiguous, [order], plan), /label pages could not be matched/);
});

test('bulk Kyl printing keeps verified orders and reports each unavailable order separately', async () => {
  const good = await palletOrder('900001', {
    deliveryMethod: 20,
    freightConsignmentFresh: 'TEST-KYLT-01',
    freightConsignmentFrozen: 'TEST-FRYST-02'
  });
  const clone = (number, overrides = {}) => ({
    ...good,
    orderNumber: number,
    context: { ...good.context, ...overrides },
    documents: { pallet: { ...good.documents.pallet } }
  });
  const noBooking = clone('900006', { freightConsignmentFresh: '', freightConsignmentFrozen: '' });
  const noDocument = { ...clone('900007'), documents: {} };
  const incomplete = clone('900008');
  incomplete.documents.pallet.name = 'pallet900008.pdf';
  const printed = clone('900009');
  printed.documents.pallet.printStatus = 'printed';
  const testStorage = {
    getObject: (name, source, generation) => name === 'pallet900008.pdf'
      ? { body: createPlaceholderPdf('Endast etikett') }
      : storage.getObject(name, source, generation)
  };

  const result = await prepareBulkFreightPrint(testStorage,
    [good, noBooking, noDocument, incomplete, printed], 'kyl-and-frys',
    ['900001', '900006', '900007', '900008', '900009']);
  assert.deepEqual(new Set(result.snapshots.map((item) => item.orderNumber)), new Set(['900001']));
  assert.deepEqual(result.skipped.map((item) => item.orderNumber), ['900006', '900007', '900008', '900009']);
  assert.match(result.skipped[0].reason, /Bokningsnummer saknas/);
  assert.match(result.skipped[1].reason, /no available freight document/);
  assert.match(result.skipped[2].reason, /PDF-kontroll misslyckades/);
  assert.match(result.skipped[3].reason, /already printed/);
});

test('bulk DSV printing skips an order without a booking instead of blocking a valid Finland packet', async () => {
  const ready = await dsvOrder('900004', {
    deliveryMethod: 47,
    freightConsignmentFresh: 'TEST-DSV-KYLT-07'
  });
  const unbooked = {
    ...ready,
    orderNumber: '1993262',
    context: { ...ready.context, freightConsignmentFresh: '', freightConsignmentFrozen: '' }
  };
  const result = await prepareBulkFreightPrint(storage, [ready, unbooked], 'dsv-finland', ['900004', '1993262']);
  assert.deepEqual(result.snapshots.map((item) => item.orderNumber), ['900004']);
  assert.deepEqual(result.skipped, [{ orderNumber: '1993262', reason: 'Bokningsnummer saknas.' }]);
});

test('bulk DSV printing skips a frozen booking whose stored PDF has no matching label', async () => {
  const ready = await dsvOrder('900004', {
    deliveryMethod: 47,
    freightConsignmentFresh: 'TEST-DSV-KYLT-07'
  });
  const missingFrozenLabel = await dsvOrder('900005', {
    deliveryMethod: 48,
    freightConsignmentFrozen: 'TEST-DSV-FRYST-13'
  });
  const testStorage = {
    getObject: (name, source, generation) => name === 'freight900005.pdf'
      ? { body: createPlaceholderPdf('FRAKTSEDEL TEST-DSV-FRYST-13') }
      : storage.getObject(name, source, generation)
  };
  const result = await prepareBulkFreightPrint(testStorage,
    [ready, missingFrozenLabel], 'dsv-finland', ['900004', '900005']);
  assert.deepEqual(result.snapshots.map((item) => item.orderNumber), ['900004']);
  assert.deepEqual(result.skipped.map((item) => item.orderNumber), ['900005']);
  assert.match(result.skipped[0].reason, /No verified DSV label pages for Frozen booking/);
});
