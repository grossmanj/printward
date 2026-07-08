export const DOCUMENT_TYPES = {
  pallet: {
    key: 'pallet',
    label: 'Pallet document',
    shortLabel: 'Pallet',
    filePrefix: 'pallet',
    order: 0
  },
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

const FREIGHT_PRINT_COPY_RULES = new Map([
  ['db schenker finland international', 4]
]);

const KYL_PALLET_SPLIT_DISTRIBUTORS = new Set([
  'kyl- och frysexpressen mälardalen ab'
]);

const MATCHERS = [
  ['pallet', /^pallet([0-9A-Za-z_-]+)\.pdf$/i],
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

function hasPackingLeft(order) {
  const context = order.context || {};
  if (context.packingBlocked) return true;
  if (Number(context.packingLinesLeft || 0) > 0) return true;
  return (context.packingDepartments || []).some((department) => Number(department.linesLeft || 0) > 0);
}

function isOrderReady(order) {
  return order.missingTypes.length === 0 && !hasPackingLeft(order);
}

function isExternalDistributionOrder(order) {
  const context = order.context || {};
  return Number(context.distributorNo || 0) > 0
    && Boolean(context.freightRequired || context.palletDocumentRequired || order.documents?.pallet || order.documents?.freight);
}

function requiredFreightDocumentTypes(order) {
  const requiredTypes = new Set(order.requiredTypes || requiredTypesForOrder(order));
  if (requiredTypes.has('pallet')) return ['pallet'];
  if (requiredTypes.has('freight')) return ['freight'];
  if (order.documents?.pallet) return ['pallet'];
  if (order.documents?.freight) return ['freight'];
  return [];
}

export function canPrintExternalFreightEarly(order) {
  if (!hasPackingLeft(order)) return false;
  if (!isExternalDistributionOrder(order)) return false;

  const freightTypes = requiredFreightDocumentTypes(order);
  return freightTypes.length > 0 && freightTypes.every((type) => Boolean(order.documents?.[type]));
}

export function isPrintBlockedByPacking(order) {
  return hasPackingLeft(order) && !canPrintExternalFreightEarly(order);
}

export function documentTypesForPrintOrder(order, selectedTypes = DOCUMENT_ORDER) {
  const normalized = normalizedDocumentTypes(selectedTypes);
  if (!canPrintExternalFreightEarly(order)) return normalized;

  const freightTypes = new Set(requiredFreightDocumentTypes(order));
  return normalized.filter((type) => freightTypes.has(type));
}

function getPacketStatus(documents, missingTypes, requiredTypes = DOCUMENT_ORDER, packingBlocked = false) {
  const existing = DOCUMENT_ORDER.map((type) => documents[type]).filter(Boolean);
  const statuses = existing
    .filter((document) => requiredTypes.includes(document.type))
    .map((document) => document.printStatus);

  if (packingBlocked) return 'blocked';
  if (missingTypes.length > 0) return 'missing';
  if (statuses.length === 0) return 'missing';
  if (statuses.every((status) => status === 'printed')) return 'printed';
  if (statuses.some((status) => status === 'reprint')) return 'reprint';
  return 'pending';
}

function normalizedDocumentTypes(types = DOCUMENT_ORDER) {
  return types.filter((type) => DOCUMENT_ORDER.includes(type));
}

function normalizedDistributorName(value) {
  return String(value || '').trim().toLowerCase();
}

function freightPageCopiesForOrder(order) {
  return FREIGHT_PRINT_COPY_RULES.get(normalizedDistributorName(order.context?.distributorName)) || 1;
}

function requiresPalletDocument(order) {
  if (order.context?.palletDocumentRequired) return true;
  return Boolean(order.documents?.pallet);
}

function usesKylPalletSplit(order) {
  return KYL_PALLET_SPLIT_DISTRIBUTORS.has(normalizedDistributorName(order.context?.distributorName))
    && Boolean(order.documents?.pallet);
}

function requiredTypesForOrder(order, requiredTypes = DOCUMENT_ORDER) {
  const palletDocumentCoversFreight = requiresPalletDocument(order);

  return normalizedDocumentTypes(requiredTypes).filter((type) => {
    if (type === 'pallet') return requiresPalletDocument(order);
    if (type === 'freight' && palletDocumentCoversFreight) return false;
    if (type !== 'freight') return true;
    return Boolean(order.context?.freightRequired || order.documents?.freight);
  });
}

export function applyDocumentRequirements(orders, requiredTypes = DOCUMENT_ORDER) {
  return orders.map((order) => {
    const orderRequiredTypes = requiredTypesForOrder(order, requiredTypes);
    const missingTypes = orderRequiredTypes.filter((type) => !order.documents[type]);
    const packingBlocked = hasPackingLeft(order);

    return {
      ...order,
      requiredTypes: orderRequiredTypes,
      missingTypes,
      packingBlocked,
      packetStatus: getPacketStatus(order.documents, missingTypes, orderRequiredTypes, packingBlocked)
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

    const missingTypes = requiredTypes.filter((type) => type !== 'pallet' && !order.documents[type]);
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
    blockedOrders: 0,
    pendingOrders: 0,
    printedOrders: 0,
    reprintOrders: 0,
    pendingDocuments: 0
  };

  for (const order of orders) {
    const requiredForOrder = new Set(order.requiredTypes || countedTypes);
    const packingBlocked = hasPackingLeft(order);
    if (isOrderReady(order)) summary.readyOrders += 1;
    if (order.missingTypes.length > 0) summary.missingOrders += 1;
    if (packingBlocked) summary.blockedOrders = (summary.blockedOrders || 0) + 1;
    if (order.packetStatus === 'pending') summary.pendingOrders += 1;
    if (order.packetStatus === 'printed') summary.printedOrders += 1;
    if (order.packetStatus === 'reprint') summary.reprintOrders += 1;

    for (const type of countedTypes) {
      if (!requiredForOrder.has(type)) continue;
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
        blockedOrders: 0,
        pendingOrders: 0,
        reprintOrders: 0,
        printedOrders: 0
      });
    }

    const combo = combos.get(key);
    combo.totalOrders += 1;
    const packingBlocked = hasPackingLeft(order);
    if (isOrderReady(order)) combo.readyOrders += 1;
    if (order.missingTypes.length > 0) combo.missingOrders += 1;
    if (packingBlocked) combo.blockedOrders = (combo.blockedOrders || 0) + 1;
    if (order.packetStatus === 'pending') combo.pendingOrders += 1;
    if (order.packetStatus === 'reprint') combo.reprintOrders += 1;
    if (order.packetStatus === 'printed') combo.printedOrders += 1;
  }

  const values = Array.from(combos.values());
  return {
    totalCombos: values.length,
    readyCombos: values.filter((combo) => combo.missingOrders === 0 && !combo.blockedOrders).length,
    blockedCombos: values.filter((combo) => combo.missingOrders > 0 || combo.blockedOrders > 0).length,
    needsPrintCombos: values.filter((combo) => combo.missingOrders === 0 && !combo.blockedOrders && (combo.pendingOrders > 0 || combo.reprintOrders > 0)).length,
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
        context.packerNo,
        context.packerName,
        Number(context.distributorNo || 0) > 0 ? 'external distributor' : 'internal',
        context.deliveryDate,
        context.deliveryMethod,
        context.deliveryMethodName,
        context.dispatchPriority,
        context.dispatchTime,
        context.packingBlocked ? 'packing left warehouse blocked' : '',
        ...(context.packingDepartments || []).flatMap((department) => [department.department, department.linesLeft, department.quantityLeft]),
        ...(context.topLines || []).flatMap((line) => [line.productNo, line.description, line.note])
      ].filter(Boolean).join(' ').toLowerCase();

      if (!searchable.includes(normalizedQuery)) return false;
    }

    if (status === 'all') return true;
    if (status === 'ready') return isOrderReady(order);
    if (status === 'missing') return order.missingTypes.length > 0;
    if (status === 'blocked') return hasPackingLeft(order);
    if (status === 'pending') return order.packetStatus === 'pending';
    if (status === 'printed') return order.packetStatus === 'printed';
    if (status === 'reprint') return order.packetStatus === 'reprint';

    return true;
  });
}

export function orderToPrintSnapshot(order, selectedTypes = DOCUMENT_ORDER) {
  const selected = new Set(selectedTypes);
  const freightPageCopies = freightPageCopiesForOrder(order);
  const palletDocumentCoversFreight = requiresPalletDocument(order);
  return {
    orderNumber: order.orderNumber,
    missingTypes: order.missingTypes.filter((type) => selected.has(type)),
    documents: DOCUMENT_ORDER
      .filter((type) => selected.has(type))
      .filter((type) => !(type === 'freight' && palletDocumentCoversFreight))
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
        contentType: document.contentType,
        pageCopies: document.type === 'freight' && freightPageCopies > 1 ? freightPageCopies : undefined
      }))
  };
}

function sectionFileName(document, suffix) {
  const fileName = document.fileName || basename(document.name);
  return fileName.replace(/\.pdf$/i, `-${suffix}.pdf`);
}

function documentForPrintSection(document, overrides = {}) {
  return {
    name: document.name,
    source: document.source || 'primary',
    fileName: overrides.fileName || document.fileName,
    type: document.type,
    typeLabel: overrides.typeLabel || document.typeLabel,
    orderNumber: document.orderNumber,
    size: document.size,
    updated: document.updated,
    generation: document.generation,
    contentType: document.contentType,
    ...overrides
  };
}

function printSectionSnapshot(order, sectionType, sectionLabel, documents) {
  return {
    orderNumber: order.orderNumber,
    isPrintSection: true,
    sectionType,
    sectionLabel,
    missingTypes: [],
    documents
  };
}

function hasValue(value) {
  return String(value || '').trim().length > 0;
}

function compactPageSelection(pages = []) {
  const values = Array.from(new Set(
    pages.map((page) => Math.trunc(Number(page))).filter((page) => Number.isInteger(page) && page > 0)
  )).sort((left, right) => left - right);
  const ranges = [];

  for (let index = 0; index < values.length; index += 1) {
    const start = values[index];
    let end = start;
    while (index + 1 < values.length && values[index + 1] === end + 1) {
      index += 1;
      end = values[index];
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }

  return ranges.join(',');
}

function kylPalletPageCount(order) {
  const context = order.context || {};
  const inferred = Math.trunc(Number(context.kylPalletLabelPages || context.kylPalletPageGroups?.labelPages?.length || 0)) || 0;
  if (inferred > 0) return Math.max(1, Math.min(100, inferred));

  const consignmentCount = [
    context.freightConsignmentFresh,
    context.freightConsignmentFrozen
  ].filter(hasValue).length || (Array.isArray(context.freightConsignmentNumbers) ? context.freightConsignmentNumbers.length : 0);

  return Math.max(1, Math.min(100, consignmentCount || 1));
}

function kylPalletLabelPages(order) {
  const pages = order.context?.kylPalletPageGroups?.labelPages;
  if (Array.isArray(pages) && pages.length > 0) return pages;
  return Array.from({ length: kylPalletPageCount(order) }, (_, index) => index + 1);
}

function kylFreightSectionDocument(order, section, label) {
  const pallet = order.documents.pallet;
  const context = order.context || {};
  const groupKey = section === 'frozenFreight' ? 'frozenFreightPages' : 'coolingFreightPages';
  const pages = context.kylPalletPageGroups?.[groupKey];
  const pageSelection = Array.isArray(pages) && pages.length > 0 ? compactPageSelection(pages) : '';
  return documentForPrintSection(pallet, {
    typeLabel: label,
    fileName: sectionFileName(pallet, section),
    ...(pageSelection
      ? { pages: pageSelection }
      : {
          kylSection: {
            section,
            labelPages: kylPalletPageCount(order),
            hasCooling: hasValue(context.freightConsignmentFresh),
            hasFrozen: hasValue(context.freightConsignmentFrozen)
          }
        })
  });
}

function kylPalletPrintSnapshots(order, selectedTypes = DOCUMENT_ORDER) {
  const selected = new Set(selectedTypes);
  const snapshots = [];
  const pallet = order.documents.pallet;
  if (!selected.has('pallet') || !pallet) return [orderToPrintSnapshot(order, selectedTypes)];

  const labelPages = kylPalletLabelPages(order);
  for (const page of labelPages) {
    snapshots.push(printSectionSnapshot(order, `pallet-label-${page}`, `Pallet page ${page}`, [
      documentForPrintSection(pallet, {
        typeLabel: `Pallet page ${page}`,
        fileName: sectionFileName(pallet, `pallet-${page}`),
        pages: String(page)
      })
    ]));
  }

  const context = order.context || {};
  const hasCooling = hasValue(context.freightConsignmentFresh);
  const hasFrozen = hasValue(context.freightConsignmentFrozen);

  if (hasFrozen) {
    snapshots.push(printSectionSnapshot(order, 'frozen-freight', 'Frozen freight', [
      kylFreightSectionDocument(order, 'frozenFreight', 'Frozen freight')
    ]));
  }

  if (hasCooling) {
    snapshots.push(printSectionSnapshot(order, 'cooling-freight', 'Cooling freight', [
      kylFreightSectionDocument(order, 'coolingFreight', 'Cooling freight')
    ]));
  }

  if (!hasFrozen && !hasCooling) {
    snapshots.push(printSectionSnapshot(order, 'freight', 'Freight', [
      kylFreightSectionDocument(order, 'remainingFreight', 'Freight')
    ]));
  }

  const slipAttachment = ['packingSlip', 'attachment']
    .filter((type) => selected.has(type))
    .map((type) => order.documents[type])
    .filter(Boolean)
    .map((document) => documentForPrintSection(document));

  if (slipAttachment.length > 0) {
    snapshots.push(printSectionSnapshot(order, 'slip-attachment', 'Slip and attachment', slipAttachment));
  }

  return snapshots.filter((snapshot) => snapshot.documents.length > 0);
}

export function orderToPrintSnapshots(order, selectedTypes = DOCUMENT_ORDER) {
  if (usesKylPalletSplit(order)) return kylPalletPrintSnapshots(order, selectedTypes);
  const snapshot = orderToPrintSnapshot(order, selectedTypes);
  return snapshot.documents.length > 0 ? [snapshot] : [];
}
