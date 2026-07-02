export const DOCUMENT_TYPES = {
  packingSlip: {
    key: 'packingSlip',
    label: 'Packing slip',
    shortLabel: 'Slip',
    filePrefix: 'order',
    order: 1
  },
  attachment: {
    key: 'attachment',
    label: 'Attachment',
    shortLabel: 'Attachment',
    filePrefix: 'parti',
    order: 2
  },
  freight: {
    key: 'freight',
    label: 'Freight document',
    shortLabel: 'Freight',
    filePrefix: 'freight',
    order: 3
  }
};

export const DOCUMENT_ORDER = Object.values(DOCUMENT_TYPES)
  .sort((left, right) => left.order - right.order)
  .map((type) => type.key);

const MATCHERS = [
  ['packingSlip', /^order([0-9A-Za-z_-]+)\.pdf$/i],
  ['attachment', /^parti([0-9A-Za-z_-]+)\.pdf$/i],
  ['freight', /^freight([0-9A-Za-z_-]+)\.pdf$/i]
];

function basename(objectName) {
  return String(objectName || '').split('/').pop() || '';
}

export function classifyObject(objectName) {
  const fileName = basename(objectName);

  for (const [type, pattern] of MATCHERS) {
    const match = fileName.match(pattern);
    if (match) {
      return {
        type,
        orderNumber: match[1],
        fileName
      };
    }
  }

  return null;
}

export function normalizeObject(object) {
  const classification = classifyObject(object.name);
  if (!classification) return null;

  return {
    name: object.name,
    source: object.source || 'primary',
    fileName: classification.fileName,
    type: classification.type,
    typeLabel: DOCUMENT_TYPES[classification.type].label,
    orderNumber: classification.orderNumber,
    size: Number(object.size || 0),
    updated: object.updated || null,
    generation: object.generation || null,
    contentType: object.contentType || 'application/pdf'
  };
}

function compareUpdatedDesc(left, right) {
  return String(right.updated || '').localeCompare(String(left.updated || ''));
}

function printEventMatchesDocument(event, document) {
  if (!event || !document) return false;
  if (event.objectName !== document.name) return false;
  if ((event.source || 'primary') !== (document.source || 'primary')) return false;
  if (document.generation && event.generation !== document.generation) return false;
  if (!document.generation && document.updated && event.objectUpdated !== document.updated) return false;
  return true;
}

function getDocumentPrintStatus(document, printIndex) {
  if (!document) return 'missing';

  const key = `${document.orderNumber}:${document.type}:${document.source || 'primary'}:${document.name}`;
  const event = printIndex.latestByDoc.get(key);

  if (!event) return 'pending';
  return printEventMatchesDocument(event, document) ? 'printed' : 'reprint';
}

function getPacketStatus(documents, missingTypes, requiredTypes = DOCUMENT_ORDER) {
  const existing = DOCUMENT_ORDER.map((type) => documents[type]).filter(Boolean);
  const statuses = existing
    .filter((document) => requiredTypes.includes(document.type))
    .map((document) => document.printStatus);

  if (missingTypes.length > 0) return 'missing';
  if (statuses.length === 0) return 'missing';
  if (statuses.every((status) => status === 'printed')) return 'printed';
  if (statuses.some((status) => status === 'reprint')) return 'reprint';
  return 'pending';
}

function normalizedDocumentTypes(types = DOCUMENT_ORDER) {
  return types.filter((type) => DOCUMENT_ORDER.includes(type));
}

function requiredTypesForOrder(order, requiredTypes = DOCUMENT_ORDER) {
  return normalizedDocumentTypes(requiredTypes).filter((type) => {
    if (type !== 'freight') return true;
    return Boolean(order.context?.freightRequired || order.documents?.freight);
  });
}

export function applyDocumentRequirements(orders, requiredTypes = DOCUMENT_ORDER) {
  return orders.map((order) => {
    const orderRequiredTypes = requiredTypesForOrder(order, requiredTypes);
    const missingTypes = orderRequiredTypes.filter((type) => !order.documents[type]);

    return {
      ...order,
      requiredTypes: orderRequiredTypes,
      missingTypes,
      packetStatus: getPacketStatus(order.documents, missingTypes, orderRequiredTypes)
    };
  });
}

export function buildOrders(objects, printIndex = { latestByDoc: new Map() }, options = {}) {
  const requiredTypes = normalizedDocumentTypes(options.requiredTypes || DOCUMENT_ORDER);
  const grouped = new Map();

  for (const object of objects) {
    const document = normalizeObject(object);
    if (!document) continue;

    if (!grouped.has(document.orderNumber)) {
      grouped.set(document.orderNumber, {
        orderNumber: document.orderNumber,
        documents: {},
        duplicates: {}
      });
    }

    const order = grouped.get(document.orderNumber);
    const current = order.documents[document.type];

    if (!current || compareUpdatedDesc(document, current) < 0) {
      if (current) {
        order.duplicates[document.type] ||= [];
        order.duplicates[document.type].push(current);
      }
      order.documents[document.type] = document;
    } else {
      order.duplicates[document.type] ||= [];
      order.duplicates[document.type].push(document);
    }
  }

  const orders = Array.from(grouped.values()).map((order) => {
    for (const type of DOCUMENT_ORDER) {
      if (order.documents[type]) {
        order.documents[type].printStatus = getDocumentPrintStatus(order.documents[type], printIndex);
      }
    }

    const missingTypes = requiredTypes.filter((type) => !order.documents[type]);
    const latestUpdated = DOCUMENT_ORDER
      .map((type) => order.documents[type]?.updated)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    const printableDocuments = DOCUMENT_ORDER
      .map((type) => order.documents[type])
      .filter(Boolean);

    return {
      orderNumber: order.orderNumber,
      documents: order.documents,
      duplicates: order.duplicates,
      missingTypes,
      latestUpdated,
      printableDocumentCount: printableDocuments.length,
      packetStatus: getPacketStatus(order.documents, missingTypes, requiredTypes)
    };
  });

  return orders.sort((left, right) => {
    const byUpdate = String(right.latestUpdated || '').localeCompare(String(left.latestUpdated || ''));
    if (byUpdate !== 0) return byUpdate;
    return String(left.orderNumber).localeCompare(String(right.orderNumber), undefined, { numeric: true });
  });
}

export function summarizeOrders(orders, options = {}) {
  const countedTypes = (options.documentTypes || DOCUMENT_ORDER)
    .filter((type) => DOCUMENT_ORDER.includes(type));
  const summary = {
    totalOrders: orders.length,
    readyOrders: 0,
    missingOrders: 0,
    pendingOrders: 0,
    printedOrders: 0,
    reprintOrders: 0,
    pendingDocuments: 0
  };

  for (const order of orders) {
    if (order.missingTypes.length === 0) summary.readyOrders += 1;
    if (order.packetStatus === 'missing') summary.missingOrders += 1;
    if (order.packetStatus === 'pending') summary.pendingOrders += 1;
    if (order.packetStatus === 'printed') summary.printedOrders += 1;
    if (order.packetStatus === 'reprint') summary.reprintOrders += 1;

    for (const type of countedTypes) {
      const document = order.documents[type];
      if (document && document.printStatus !== 'printed') summary.pendingDocuments += 1;
    }
  }

  return summary;
}

function dispatchComboKey(order) {
  const context = order.context || {};
  return [
    context.deliveryDate || '',
    context.dispatchTime || '',
    context.deliveryMethodName || context.deliveryMethod || ''
  ].join('|');
}

export function summarizeDispatchCombos(orders) {
  const combos = new Map();

  for (const order of orders) {
    const key = dispatchComboKey(order);
    if (!combos.has(key)) {
      combos.set(key, {
        totalOrders: 0,
        readyOrders: 0,
        missingOrders: 0,
        pendingOrders: 0,
        reprintOrders: 0,
        printedOrders: 0
      });
    }

    const combo = combos.get(key);
    combo.totalOrders += 1;
    if (order.missingTypes.length === 0) combo.readyOrders += 1;
    if (order.packetStatus === 'missing') combo.missingOrders += 1;
    if (order.packetStatus === 'pending') combo.pendingOrders += 1;
    if (order.packetStatus === 'reprint') combo.reprintOrders += 1;
    if (order.packetStatus === 'printed') combo.printedOrders += 1;
  }

  const values = Array.from(combos.values());
  return {
    totalCombos: values.length,
    readyCombos: values.filter((combo) => combo.missingOrders === 0).length,
    blockedCombos: values.filter((combo) => combo.missingOrders > 0).length,
    needsPrintCombos: values.filter((combo) => combo.missingOrders === 0 && (combo.pendingOrders > 0 || combo.reprintOrders > 0)).length,
    printedCombos: values.filter((combo) => combo.totalOrders > 0 && combo.printedOrders === combo.totalOrders).length
  };
}

export function filterOrders(orders, { q = '', status = 'all', deliveryDate = '' } = {}) {
  const normalizedQuery = q.trim().toLowerCase();
  const normalizedDeliveryDate = String(deliveryDate || '').trim();

  return orders.filter((order) => {
    if (normalizedDeliveryDate && order.context?.deliveryDate !== normalizedDeliveryDate) return false;

    if (normalizedQuery) {
      const context = order.context || {};
      const searchable = [
        order.orderNumber,
        context.customerNo,
        context.customerName,
        context.deliveryName,
        context.orderNote,
        context.ourReference,
        context.yourReference,
        context.requisitionNo,
        context.consignmentNo,
        context.distributorNo,
        context.distributorName,
        Number(context.distributorNo || 0) > 0 ? 'external distributor' : 'internal',
        context.deliveryDate,
        context.deliveryMethod,
        context.deliveryMethodName,
        context.dispatchPriority,
        context.dispatchTime,
        ...(context.topLines || []).flatMap((line) => [line.productNo, line.description, line.note])
      ].filter(Boolean).join(' ').toLowerCase();

      if (!searchable.includes(normalizedQuery)) return false;
    }

    if (status === 'all') return true;
    if (status === 'ready') return order.missingTypes.length === 0;
    if (status === 'missing') return order.packetStatus === 'missing';
    if (status === 'pending') return order.packetStatus === 'pending';
    if (status === 'printed') return order.packetStatus === 'printed';
    if (status === 'reprint') return order.packetStatus === 'reprint';

    return true;
  });
}

export function orderToPrintSnapshot(order, selectedTypes = DOCUMENT_ORDER) {
  const selected = new Set(selectedTypes);
  return {
    orderNumber: order.orderNumber,
    missingTypes: order.missingTypes.filter((type) => selected.has(type)),
    documents: DOCUMENT_ORDER
      .filter((type) => selected.has(type))
      .map((type) => order.documents[type])
      .filter(Boolean)
      .map((document) => ({
        name: document.name,
        source: document.source || 'primary',
        fileName: document.fileName,
        type: document.type,
        typeLabel: document.typeLabel,
        orderNumber: document.orderNumber,
        size: document.size,
        updated: document.updated,
        generation: document.generation,
        contentType: document.contentType
      }))
  };
}
