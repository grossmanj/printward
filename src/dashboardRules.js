const ROUTES = {
  eriksson: new Set([25, 49]),
  dsvFinland: new Set([47, 48]),
  jansenGermany: 52
};

const SUPPLIERS = {
  kylAndFrys: 7331697,
  dsvFinland: 50063993,
  bestTransport: 55058127
};

export function freightPanelForOrder(order = {}) {
  const context = order.context || order;
  const deliveryMethod = Number(context.deliveryMethod || 0);
  const distributorNo = Number(context.distributorNo || 0);

  // Eriksson uses Kyl & Frys' supplier; only the order's DelMt separates it.
  if (ROUTES.eriksson.has(deliveryMethod) && distributorNo === SUPPLIERS.kylAndFrys) return 'eriksson';
  if (ROUTES.dsvFinland.has(deliveryMethod) || distributorNo === SUPPLIERS.dsvFinland) return 'dsv-finland';
  if (deliveryMethod === ROUTES.jansenGermany) return 'other-carriers';
  if (distributorNo === SUPPLIERS.kylAndFrys) return 'kyl-and-frys';
  if (distributorNo === SUPPLIERS.bestTransport) return 'best-transport';
  if (context.freightRequired || distributorNo > 0) return 'other-carriers';
  return null;
}

const FREIGHT_PANEL_IDS = [
  'kyl-and-frys',
  'dsv-finland',
  'best-transport',
  'eriksson',
  'other-carriers'
];

const TRACKED_DOCUMENT_PANELS = new Set(['kyl-and-frys', 'dsv-finland', 'eriksson']);
const OWN_DELIVERY_METHODS = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 27, 41]);
const REGISTRATION_TEXT = /^(?:\d+\s*[.:-]?\s*)?\[?([A-ZÅÄÖ]{3}\s+[A-Z0-9]{3})\]?$/i;

function freightDocumentType(order, panelId) {
  if (panelId === 'dsv-finland') return 'freight';
  if (order.context?.palletDocumentRequired || order.requiredTypes?.includes('pallet') || order.documents?.pallet) {
    return 'pallet';
  }
  return 'freight';
}

export function freightBookingsForContext(context = {}) {
  const fresh = String(context.freightConsignmentFresh || '').trim();
  const frozen = String(context.freightConsignmentFrozen || '').trim();
  const bookings = [];
  if (fresh) bookings.push({ kind: 'Kylt', number: fresh });
  if (frozen) bookings.push({ kind: 'Fryst', number: frozen });
  if (!bookings.length) {
    for (const number of context.freightConsignmentNumbers || []) {
      const value = String(number || '').trim();
      if (value && !bookings.some((booking) => booking.number === value)) {
        bookings.push({ kind: 'Bokning', number: value });
      }
    }
  }
  return bookings;
}

export function summarizeFreightPanels(orders = []) {
  const panels = Object.fromEntries(FREIGHT_PANEL_IDS.map((id) => [id, {
    id,
    total: 0,
    departureCount: 0,
    ready: 0,
    waiting: 0,
    documentTracking: TRACKED_DOCUMENT_PANELS.has(id),
    orders: []
  }]));

  for (const order of orders) {
    const panelId = freightPanelForOrder(order);
    if (!panelId) continue;
    const panel = panels[panelId];
    const documentType = panel.documentTracking ? freightDocumentType(order, panelId) : null;
    const document = documentType ? order.documents?.[documentType] : null;
    const documentReady = Boolean(document);
    panel.total += 1;
    if (panel.documentTracking) {
      if (documentReady) panel.ready += 1;
      else panel.waiting += 1;
    }
    panel.orders.push({
      order,
      documentType,
      documentReady,
      printStatus: document?.printStatus || null,
      bookings: freightBookingsForContext(order.context || {})
    });
  }

  for (const panel of Object.values(panels)) {
    panel.departureCount = new Set(panel.orders.map(({ order }) => {
      const context = order.context || {};
      const key = [context.dispatchPriority || '', context.deliveryMethod || context.deliveryMethodName || ''].join('|');
      return key === '|' ? `order:${order.orderNumber}` : key;
    })).size;
    panel.orders.sort((a, b) => {
      const priorityA = Number(a.order.context?.dispatchPriority ?? 9999);
      const priorityB = Number(b.order.context?.dispatchPriority ?? 9999);
      const methodA = Number(a.order.context?.deliveryMethod ?? 9999);
      const methodB = Number(b.order.context?.deliveryMethod ?? 9999);
      return priorityA - priorityB || methodA - methodB || String(a.order.orderNumber).localeCompare(String(b.order.orderNumber), 'sv');
    });
  }

  return panels;
}

export function planFreightDocumentSelection(orders = [], panelId, orderNumbers = []) {
  if (!TRACKED_DOCUMENT_PANELS.has(panelId)) {
    return { valid: false, errors: ['This freight group does not support document selection.'], orders: [] };
  }
  if (!Array.isArray(orderNumbers) || orderNumbers.length === 0 || orderNumbers.length > 200) {
    return { valid: false, errors: ['Select between 1 and 200 orders.'], orders: [] };
  }

  const selectedNumbers = orderNumbers.map((number) => String(number).trim());
  if (selectedNumbers.some((number) => !/^\d+$/.test(number)) || new Set(selectedNumbers).size !== selectedNumbers.length) {
    return { valid: false, errors: ['Order numbers must be unique numeric values.'], orders: [] };
  }

  const panels = summarizeFreightPanels(orders);
  const selected = new Set(selectedNumbers);
  const allByNumber = new Map(orders.map((order) => [String(order.orderNumber), order]));
  const panelItems = panels[panelId].orders.filter(({ order }) => selected.has(String(order.orderNumber)));
  const panelNumbers = new Set(panelItems.map(({ order }) => String(order.orderNumber)));
  const errors = [];

  for (const number of selectedNumbers) {
    if (!allByNumber.has(number)) errors.push(`Order ${number} is not available for this delivery date.`);
    else if (!panelNumbers.has(number)) errors.push(`Order ${number} does not belong to this freight group.`);
  }
  for (const { order, documentReady } of panelItems) {
    if (!documentReady) errors.push(`Order ${order.orderNumber} has no available freight document.`);
  }

  if (errors.length) return { valid: false, errors, orders: [] };

  return {
    valid: true,
    panelId,
    errors: [],
    orderCount: panelItems.length,
    excludes: ['packingSlip', 'attachment'],
    orders: panelItems.map(({ order, documentType, printStatus, bookings }) => ({
      orderNumber: String(order.orderNumber),
      customerName: order.context?.customerName || order.context?.deliveryName || '',
      dispatchPriority: order.context?.dispatchPriority || null,
      dispatchTime: order.context?.dispatchTime || null,
      deliveryMethod: order.context?.deliveryMethod || null,
      deliveryMethodName: order.context?.deliveryMethodName || '',
      bookings,
      document: {
        type: documentType,
        name: order.documents[documentType].name,
        source: order.documents[documentType].source || 'primary',
        generation: order.documents[documentType].generation || null,
        fileName: order.documents[documentType].fileName || order.documents[documentType].name,
        printStatus
      }
    }))
  };
}

export function returnDepartureForContext(context = {}) {
  const hour = Number(context.dispatchPriority);
  if (!Number.isInteger(hour) || hour <= 0) return 'unscheduled';
  if (hour < 7) return 'early';
  if (hour <= 11) return 'morning';
  if (hour <= 16) return 'afternoon';
  return 'unscheduled';
}

export function summarizeReturnDepartures(contexts = []) {
  const returns = contexts
    .filter((context) => Number(context.returnGroup) === 30)
    .sort((a, b) => Number(a.dispatchPriority || 99) - Number(b.dispatchPriority || 99)
      || String(a.orderNumber).localeCompare(String(b.orderNumber), 'sv'))
    .map((context) => ({ ...context, returnDeparture: returnDepartureForContext(context) }));
  const byDeparture = { early: 0, morning: 0, afternoon: 0, unscheduled: 0 };
  for (const context of returns) byDeparture[context.returnDeparture] += 1;
  return { returns, summary: { totalReturns: returns.length, byDeparture } };
}

export function pickupKindForContext(context = {}) {
  const method = Number(context.deliveryMethod);
  if (method === 6) return 'customer';
  if (method === 16) return 'courier';
  if (method >= 42 && method <= 46) return 'taxi';
  return null;
}

export function summarizePickups(contexts = []) {
  const pickups = contexts
    .map((context) => ({
      ...context,
      pickupKind: pickupKindForContext(context),
      staffOrder: Number(context.deliveryMethod) === 6 && Number(context.customerChainNo) === 60,
      swishPayment: Number(context.customerPaymentTerm) === 1 && Number(context.deliveryMethod) === 6
    }))
    .filter((context) => context.pickupKind)
    .sort((a, b) => Number(a.dispatchPriority || 99) - Number(b.dispatchPriority || 99)
      || String(a.customerName || '').localeCompare(String(b.customerName || ''), 'sv')
      || String(a.orderNumber).localeCompare(String(b.orderNumber), 'sv'));
  return {
    pickups,
    summary: {
      total: pickups.length,
      customer: pickups.filter((context) => context.pickupKind === 'customer' && !context.staffOrder).length,
      staff: pickups.filter((context) => context.staffOrder).length,
      courier: pickups.filter((context) => context.pickupKind === 'courier').length,
      taxi: pickups.filter((context) => context.pickupKind === 'taxi').length,
      swish: pickups.filter((context) => context.swishPayment).length
    }
  };
}

export function ownVehicleSourceForContext(context = {}) {
  // External suppliers take precedence even if a route happens to reuse a code.
  if (Number(context.distributorNo || 0) > 0) return null;
  const method = Number(context.deliveryMethod);
  if (OWN_DELIVERY_METHODS.has(method)) return 'confirmed-method';
  const name = String(context.deliveryMethodName || '').trim();
  return REGISTRATION_TEXT.test(name) ? 'registration-text' : null;
}

export function dispatchSlotForContext(context = {}) {
  const hour = Number(context.dispatchPriority);
  if (!Number.isInteger(hour) || hour <= 0) return null;
  if (hour < 7) return 'early';
  if (hour <= 11) return 'morning';
  if (hour <= 16) return 'afternoon';
  return null;
}

export function summarizeOwnDispatch(orders = []) {
  const slots = Object.fromEntries(['early', 'morning', 'afternoon'].map((id) => [id, {
    id, total: 0, ready: 0, waiting: 0, orders: []
  }]));
  const unassigned = [];
  let registrationTextMatches = 0;
  for (const order of orders) {
    const context = order.context || {};
    const source = ownVehicleSourceForContext(context);
    if (!source) continue;
    if (source === 'registration-text') registrationTextMatches += 1;
    const slotId = dispatchSlotForContext(context);
    const ready = Boolean(order.documents?.packingSlip && order.documents?.attachment)
      && !Boolean(order.packingBlocked || context.packingBlocked);
    const item = { order, ready, matchSource: source };
    if (!slotId) {
      unassigned.push(item);
      continue;
    }
    const slot = slots[slotId];
    slot.total += 1;
    if (ready) slot.ready += 1;
    else slot.waiting += 1;
    slot.orders.push(item);
  }
  for (const slot of Object.values(slots)) {
    slot.orders.sort((a, b) => Number(a.order.context?.dispatchPriority || 99) - Number(b.order.context?.dispatchPriority || 99)
      || String(a.order.context?.deliveryMethodName || '').localeCompare(String(b.order.context?.deliveryMethodName || ''), 'sv')
      || String(a.order.orderNumber).localeCompare(String(b.order.orderNumber), 'sv'));
  }
  return { slots, unassignedCount: unassigned.length, registrationTextMatches };
}

const CHAIN_CODES = { 'sushi-yama': 41, chopchop: 100 };

export function summarizeChainPanels(orders = []) {
  const panels = Object.fromEntries(Object.keys(CHAIN_CODES).map((id) => [id, {
    id, total: 0, printed: 0, waiting: 0,
    own: { total: 0, printed: 0 },
    remote: { total: 0, printed: 0 },
    unclassified: { total: 0, printed: 0 },
    orders: []
  }]));
  const idByCode = new Map(Object.entries(CHAIN_CODES).map(([id, code]) => [code, id]));

  for (const order of orders) {
    const context = order.context || {};
    const id = idByCode.get(Number(context.customerChainNo));
    if (!id) continue;
    const panel = panels[id];
    const slip = order.documents?.packingSlip;
    const attachment = order.documents?.attachment;
    const printed = Boolean(slip && attachment && slip.printStatus === 'printed' && attachment.printStatus === 'printed');
    const ready = Boolean(slip && attachment) && !Boolean(order.packingBlocked || context.packingBlocked);
    const transport = ownVehicleSourceForContext(context)
      ? 'own'
      : Number(context.distributorNo || 0) > 0 || context.freightRequired
        ? 'remote'
        : 'unclassified';
    panel.total += 1;
    if (printed) panel.printed += 1;
    else panel.waiting += 1;
    panel[transport].total += 1;
    if (printed) panel[transport].printed += 1;
    panel.orders.push({ order, printed, ready, transport });
  }

  for (const panel of Object.values(panels)) {
    panel.orders.sort((a, b) => Number(a.order.context?.dispatchPriority || 99) - Number(b.order.context?.dispatchPriority || 99)
      || String(a.order.context?.deliveryMethodName || '').localeCompare(String(b.order.context?.deliveryMethodName || ''), 'sv')
      || String(a.order.orderNumber).localeCompare(String(b.order.orderNumber), 'sv'));
  }
  return panels;
}

export const freightPanelRules = Object.freeze({ ROUTES, SUPPLIERS });
