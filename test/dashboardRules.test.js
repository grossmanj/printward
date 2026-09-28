import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchSlotForContext, freightBookingsForContext, freightPanelForOrder, ownVehicleSourceForContext, pickupKindForContext, planDashboardPrintSelection, planFreightDocumentSelection, returnDepartureForContext, summarizeChainPanels, summarizeFreightPanels, summarizeOwnDispatch, summarizePickups, summarizeReturnDepartures } from '../src/dashboardRules.js';

test('dashboard print plan rejects wrong groups, unfinished slips, and already printed freight', () => {
  const slip = (printStatus = 'pending') => ({ name: 'slip.pdf', type: 'packingSlip', printStatus });
  const attachment = (printStatus = 'pending') => ({ name: 'attachment.pdf', type: 'attachment', printStatus });
  const orders = [
    { orderNumber: '101', context: { deliveryMethod: 1, distributorNo: 0, dispatchPriority: 6, customerChainNo: 41 }, documents: { packingSlip: slip(), attachment: attachment() } },
    { orderNumber: '102', context: { deliveryMethod: 1, distributorNo: 0, dispatchPriority: 6 }, packingBlocked: true, documents: { packingSlip: slip(), attachment: attachment() } },
    { orderNumber: '103', context: { deliveryMethod: 47, distributorNo: 50063993, dispatchPriority: 7 }, documents: { freight: { name: 'freight.pdf', type: 'freight', printStatus: 'printed' } } }
  ];
  assert.deepEqual(planDashboardPrintSelection(orders, 'dispatch', 'early', ['101']).orders.map((item) => item.orderNumber), ['101']);
  assert.equal(planDashboardPrintSelection(orders, 'dispatch', 'morning', ['101']).valid, false);
  assert.equal(planDashboardPrintSelection(orders, 'dispatch', 'early', ['102']).valid, false);
  assert.equal(planDashboardPrintSelection(orders, 'chain', 'sushi-yama', ['101']).valid, true);
  assert.equal(planDashboardPrintSelection(orders, 'freight', 'dsv-finland', ['103']).valid, false);
  assert.equal(planDashboardPrintSelection(orders, 'freight', 'best-transport', ['103']).valid, false);
  assert.equal(planDashboardPrintSelection(orders, 'dispatch', 'early', ['101', '101']).valid, false);
});

test('places routes 25 and 49 in Eriksson before the Kyl & Frys supplier rule', () => {
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 25, routeGroup: 4, distributorNo: 7331697 } }), 'eriksson');
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 49, deliveryMethodName: 'K&F Danmark 13:00', distributorNo: 7331697 } }), 'eriksson');
  assert.equal(freightPanelForOrder({ context: { routeGroup: 25, deliveryMethod: 20, distributorNo: 7331697 } }), 'kyl-and-frys');
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 25, distributorNo: 90000000 } }), 'other-carriers');
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 49, distributorNo: 90000000 } }), 'other-carriers');
});

test('places DSV Finland by route or supplier number', () => {
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 47 } }), 'dsv-finland');
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 48 } }), 'dsv-finland');
  assert.equal(freightPanelForOrder({ context: { distributorNo: 50063993 } }), 'dsv-finland');
});

test('places Jansen route 52 and unrecognised freight carriers in other carriers', () => {
  assert.equal(freightPanelForOrder({ context: { deliveryMethod: 52 } }), 'other-carriers');
  assert.equal(freightPanelForOrder({ context: { distributorNo: 90000000, freightRequired: true } }), 'other-carriers');
});

test('keeps Kyl & Frys, Best Transport and non-freight orders distinct', () => {
  assert.equal(freightPanelForOrder({ context: { distributorNo: 7331697 } }), 'kyl-and-frys');
  assert.equal(freightPanelForOrder({ context: { distributorNo: 55058127 } }), 'best-transport');
  assert.equal(freightPanelForOrder({ context: {} }), null);
});

test('freight readiness ignores missing packing slips and combines routes 25 and 49 in Eriksson', () => {
  const panels = summarizeFreightPanels([
    { orderNumber: '101', context: { deliveryMethod: 25, distributorNo: 7331697, dispatchPriority: 16 }, documents: { pallet: { printStatus: 'pending' } }, requiredTypes: ['pallet', 'packingSlip'], missingTypes: ['packingSlip'] },
    { orderNumber: '108', context: { deliveryMethod: 49, distributorNo: 7331697, dispatchPriority: 13 }, documents: { pallet: { printStatus: 'pending' } }, requiredTypes: ['pallet'], missingTypes: [] },
    { orderNumber: '102', context: { distributorNo: 7331697, palletDocumentRequired: true, dispatchPriority: 7 }, documents: { freight: { printStatus: 'pending' } } },
    { orderNumber: '103', context: { distributorNo: 50063993, dispatchPriority: 11 }, documents: { freight: { printStatus: 'printed' } } },
    { orderNumber: '104', context: { distributorNo: 55058127, deliveryMethod: 26, dispatchPriority: 11 }, documents: {} },
    { orderNumber: '107', context: { distributorNo: 55058127, deliveryMethod: 26, dispatchPriority: 11 }, documents: {} },
    { orderNumber: '105', context: { deliveryMethod: 52 }, documents: {} },
    { orderNumber: '106', context: {}, documents: {} }
  ]);
  assert.deepEqual([panels.eriksson.total, panels.eriksson.ready, panels.eriksson.waiting], [2, 2, 0]);
  assert.deepEqual(panels.eriksson.orders.map(({ order }) => order.orderNumber), ['108', '101']);
  assert.deepEqual([panels['kyl-and-frys'].total, panels['kyl-and-frys'].ready, panels['kyl-and-frys'].waiting], [1, 0, 1]);
  assert.deepEqual([panels['dsv-finland'].total, panels['dsv-finland'].ready, panels['dsv-finland'].waiting], [1, 1, 0]);
  assert.equal(panels['dsv-finland'].orders[0].printStatus, 'printed');
  assert.equal(panels['best-transport'].documentTracking, false);
  assert.equal(panels['best-transport'].total, 2);
  assert.equal(panels['best-transport'].departureCount, 1);
  assert.equal(panels['other-carriers'].total, 1);
});

test('Eriksson uses the Kyl document rule and sorts by order DelPri', () => {
  const panels = summarizeFreightPanels([
    { orderNumber: '200', context: { deliveryMethod: 25, distributorNo: 7331697, dispatchPriority: 16, palletDocumentRequired: true }, documents: { pallet: { printStatus: 'pending' } } },
    { orderNumber: '100', context: { deliveryMethod: 25, distributorNo: 7331697, dispatchPriority: 7, palletDocumentRequired: true }, documents: { pallet: { printStatus: 'pending' } } }
  ]);
  assert.equal(panels.eriksson.ready, 2);
  assert.deepEqual(panels.eriksson.orders.map(({ order }) => order.orderNumber), ['100', '200']);
  assert.ok(panels.eriksson.orders.every(({ documentType }) => documentType === 'pallet'));
});

test('chilled and frozen booking numbers remain distinct rows for one freight order', () => {
  const context = {
    distributorNo: 7331697,
    freightConsignmentFresh: '0068602499',
    freightConsignmentFrozen: '0068594456'
  };
  assert.deepEqual(freightBookingsForContext(context), [
    { kind: 'Kylt', number: '0068602499' },
    { kind: 'Fryst', number: '0068594456' }
  ]);
  const panel = summarizeFreightPanels([{ orderNumber: '1987613', context, documents: { pallet: { printStatus: 'pending' } } }])['kyl-and-frys'];
  assert.equal(panel.total, 1);
  assert.equal(panel.ready, 1);
  assert.deepEqual(panel.orders[0].bookings, freightBookingsForContext(context));
  assert.deepEqual(freightBookingsForContext({ freightConsignmentNumbers: ['X', 'X', 'Y'] }), [
    { kind: 'Bokning', number: 'X' },
    { kind: 'Bokning', number: 'Y' }
  ]);
});

test('freight plan is read-only, sorted, and excludes packing slips and attachments', () => {
  const orders = [
    { orderNumber: '200', context: { distributorNo: 7331697, deliveryMethod: 25, dispatchPriority: 16 }, documents: { pallet: { fileName: 'pallet200.pdf', printStatus: 'pending' }, packingSlip: { fileName: 'pack200.pdf' } } },
    { orderNumber: '150', context: { distributorNo: 7331697, deliveryMethod: 49, dispatchPriority: 13 }, documents: { pallet: { fileName: 'pallet150.pdf', printStatus: 'pending' } } },
    { orderNumber: '100', context: { distributorNo: 7331697, deliveryMethod: 25, dispatchPriority: 7, freightConsignmentFresh: 'FRESH-100' }, documents: { pallet: { fileName: 'pallet100.pdf', printStatus: 'printed' }, attachment: { fileName: 'parti100.pdf' } } }
  ];
  const plan = planFreightDocumentSelection(orders, 'eriksson', ['200', '150', '100']);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.orders.map((order) => order.orderNumber), ['100', '150', '200']);
  assert.deepEqual(plan.orders.map((order) => order.document.fileName), ['pallet100.pdf', 'pallet150.pdf', 'pallet200.pdf']);
  assert.deepEqual(plan.excludes, ['packingSlip', 'attachment']);
  assert.deepEqual(plan.orders[0].bookings, [{ kind: 'Kylt', number: 'FRESH-100' }]);
});

test('freight plan rejects other carriers, missing documents, wrong groups and duplicate selection', () => {
  const orders = [
    { orderNumber: '100', context: { distributorNo: 7331697, deliveryMethod: 25 }, documents: {} },
    { orderNumber: '200', context: { distributorNo: 7331697, deliveryMethod: 20 }, documents: { pallet: { fileName: 'pallet200.pdf' } } }
  ];
  assert.equal(planFreightDocumentSelection(orders, 'best-transport', ['100']).valid, false);
  assert.equal(planFreightDocumentSelection(orders, 'eriksson', ['100']).valid, false);
  assert.equal(planFreightDocumentSelection(orders, 'eriksson', ['200']).valid, false);
  assert.equal(planFreightDocumentSelection(orders, 'eriksson', ['100', '100']).valid, false);
});

test('returns follow Gr3 regardless of delivery method and respect the 12:00 afternoon boundary', () => {
  const contexts = [
    { orderNumber: '30', deliveryMethod: 151, returnGroup: 30, dispatchPriority: 12 },
    { orderNumber: '10', deliveryMethod: 151, returnGroup: 30, dispatchPriority: 6 },
    { orderNumber: '20', deliveryMethod: 151, returnGroup: 30, dispatchPriority: 11 },
    { orderNumber: '40', deliveryMethod: 151, returnGroup: 30, dispatchPriority: null },
    { orderNumber: '50', deliveryMethod: 151, returnGroup: 31, dispatchPriority: 11 },
    { orderNumber: '60', deliveryMethod: 16, returnGroup: 30, dispatchPriority: 11 }
  ];
  const { returns, summary } = summarizeReturnDepartures(contexts);
  assert.deepEqual(returns.map((context) => context.orderNumber), ['10', '20', '60', '30', '40']);
  assert.equal(returns[3].returnDeparture, 'afternoon');
  assert.deepEqual(summary, {
    totalReturns: 5,
    byDeparture: { early: 1, morning: 2, afternoon: 1, unscheduled: 1 }
  });
  assert.equal(returnDepartureForContext({ dispatchPriority: 13 }), 'afternoon');
});

test('pickup summary separates customer, courier and taxi and marks only customer Swish', () => {
  const { pickups, summary } = summarizePickups([
    { orderNumber: '2', deliveryMethod: 16, customerPaymentTerm: 1, dispatchPriority: 12 },
    { orderNumber: '1', deliveryMethod: 6, customerPaymentTerm: 1, dispatchPriority: 7 },
    { orderNumber: '3', deliveryMethod: 44, customerPaymentTerm: 2, dispatchPriority: 13 },
    { orderNumber: '4', deliveryMethod: 151, customerPaymentTerm: 1, dispatchPriority: 11 }
  ]);
  assert.deepEqual(pickups.map((context) => context.orderNumber), ['1', '2', '3']);
  assert.deepEqual(summary, { total: 3, customer: 1, staff: 0, courier: 1, taxi: 1, swish: 1 });
  assert.equal(pickups[0].swishPayment, true);
  assert.equal(pickups[1].swishPayment, false);
  assert.equal(pickupKindForContext({ deliveryMethod: 46 }), 'taxi');
});

test('personal orders are identified within customer pickups without double counting', () => {
  const { pickups, summary } = summarizePickups([
    { orderNumber: '1', deliveryMethod: 6, customerChainNo: 60, customerPaymentTerm: 1 },
    { orderNumber: '2', deliveryMethod: 6, customerChainNo: 41 },
    { orderNumber: '3', deliveryMethod: 16, customerChainNo: 60 },
    { orderNumber: '4', deliveryMethod: 44, customerChainNo: 60 }
  ]);
  assert.deepEqual(pickups.map((context) => context.staffOrder), [true, false, false, false]);
  assert.equal(pickups[0].swishPayment, true);
  assert.equal(summary.total, 4);
  assert.equal(summary.staff, 1);
  assert.equal(summary.customer, 1);
  assert.equal(summary.courier, 1);
  assert.equal(summary.taxi, 1);
});

test('own-car matching accepts confirmed methods and registration text without including external carriers', () => {
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 12 }), 'confirmed-method');
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 27 }), 'confirmed-method');
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 302, deliveryMethodName: 'UDG 62J' }), 'registration-text');
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 302, deliveryMethodName: '302. RJA 13M' }), 'registration-text');
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 42, deliveryMethodName: 'Taxi' }), null);
  assert.equal(ownVehicleSourceForContext({ deliveryMethod: 25, distributorNo: 7331697, deliveryMethodName: 'RJA 13M' }), null);
});

test('own-car dispatch uses order priority, requires both paper documents, and keeps unknown times out of quick groups', () => {
  const availableDocs = { packingSlip: { printStatus: 'pending' }, attachment: { printStatus: 'pending' } };
  const { slots, unassignedCount, registrationTextMatches } = summarizeOwnDispatch([
    { orderNumber: '4', context: { deliveryMethod: 302, deliveryMethodName: 'UDG 62J', dispatchPriority: 12 }, documents: availableDocs, packingBlocked: false },
    { orderNumber: '1', context: { deliveryMethod: 1, deliveryMethodName: 'Own route', dispatchPriority: 6 }, documents: availableDocs, packingBlocked: false },
    { orderNumber: '2', context: { deliveryMethod: 7, deliveryMethodName: 'B route', dispatchPriority: 7 }, documents: { packingSlip: availableDocs.packingSlip }, packingBlocked: false },
    { orderNumber: '3', context: { deliveryMethod: 8, deliveryMethodName: 'A route', dispatchPriority: 7 }, documents: availableDocs, packingBlocked: true },
    { orderNumber: '5', context: { deliveryMethod: 41, dispatchPriority: 0 }, documents: availableDocs, packingBlocked: false },
    { orderNumber: '6', context: { deliveryMethod: 6, dispatchPriority: 6 }, documents: availableDocs, packingBlocked: false },
    { orderNumber: '7', context: { deliveryMethod: 25, distributorNo: 7331697, dispatchPriority: 6 }, documents: availableDocs, packingBlocked: false }
  ]);
  assert.deepEqual([slots.early.total, slots.early.ready], [1, 1]);
  assert.deepEqual([slots.morning.total, slots.morning.ready, slots.morning.waiting], [2, 0, 2]);
  assert.deepEqual(slots.morning.orders.map(({ order }) => order.orderNumber), ['3', '2']);
  assert.deepEqual([slots.afternoon.total, slots.afternoon.ready], [1, 1]);
  assert.equal(unassignedCount, 1);
  assert.equal(registrationTextMatches, 1);
  assert.equal(dispatchSlotForContext({ dispatchPriority: 11 }), 'morning');
  assert.equal(dispatchSlotForContext({ dispatchPriority: 12 }), 'afternoon');
  assert.equal(dispatchSlotForContext({ dispatchPriority: 17 }), null);
});

test('chain cards count only fully printed slip-and-attachment bundles and preserve transport groups', () => {
  const printedDocs = {
    packingSlip: { printStatus: 'printed' },
    attachment: { printStatus: 'printed' }
  };
  const panels = summarizeChainPanels([
    { orderNumber: '2', context: { customerChainNo: 41, deliveryMethod: 25, distributorNo: 7331697, dispatchPriority: 13 }, documents: { packingSlip: { printStatus: 'pending' }, attachment: { printStatus: 'pending' } } },
    { orderNumber: '1', context: { customerChainNo: 41, deliveryMethod: 11, dispatchPriority: 7 }, documents: printedDocs },
    { orderNumber: '3', context: { customerChainNo: 41, deliveryMethod: 302, deliveryMethodName: 'Okänt körsätt', dispatchPriority: 12 }, documents: { packingSlip: printedDocs.packingSlip } },
    { orderNumber: '4', context: { customerChainNo: 100, deliveryMethod: 302, deliveryMethodName: 'RJA 13M', dispatchPriority: 12 }, documents: { packingSlip: { printStatus: 'reprint' }, attachment: printedDocs.attachment } },
    { orderNumber: '5', context: { customerChainNo: 60, deliveryMethod: 6, dispatchPriority: 10 }, documents: printedDocs }
  ]);
  assert.deepEqual(panels['sushi-yama'].orders.map(({ order }) => order.orderNumber), ['1', '3', '2']);
  assert.equal(panels['sushi-yama'].total, 3);
  assert.equal(panels['sushi-yama'].printed, 1);
  assert.equal(panels['sushi-yama'].waiting, 2);
  assert.deepEqual(panels['sushi-yama'].own, { total: 1, printed: 1 });
  assert.deepEqual(panels['sushi-yama'].remote, { total: 1, printed: 0 });
  assert.deepEqual(panels['sushi-yama'].unclassified, { total: 1, printed: 0 });
  assert.equal(panels.chopchop.total, 1);
  assert.equal(panels.chopchop.printed, 0);
  assert.deepEqual(panels.chopchop.own, { total: 1, printed: 0 });
});
