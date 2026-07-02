const state = {
  orders: [],
  summary: {},
  documentTypes: {},
  contextStatus: {},
  groupIndex: new Map(),
  selected: new Set(),
  status: 'all',
  sort: localStorage.getItem('printward:sort') || 'dispatch',
  group: localStorage.getItem('printward:group') || 'dispatchSlot',
  distributor: localStorage.getItem('printward:distributor') || 'all',
  deliveryDate: todayIsoDate(),
  visibleOrders: [],
  defaults: {},
  user: localStorage.getItem('printward:user') || 'operator',
  agentOnline: false,
  activeManualJob: null
};

const elements = {
  storageLabel: document.querySelector('#storageLabel'),
  refreshButton: document.querySelector('#refreshButton'),
  settingsButton: document.querySelector('#settingsButton'),
  searchInput: document.querySelector('#searchInput'),
  dispatchDateInput: document.querySelector('#dispatchDateInput'),
  todayButton: document.querySelector('#todayButton'),
  nextDayButton: document.querySelector('#nextDayButton'),
  sortInput: document.querySelector('#sortInput'),
  distributorInput: document.querySelector('#distributorInput'),
  groupInput: document.querySelector('#groupInput'),
  selectAll: document.querySelector('#selectAll'),
  selectionLabel: document.querySelector('#selectionLabel'),
  printSelectedButton: document.querySelector('#printSelectedButton'),
  markPrintedButton: document.querySelector('#markPrintedButton'),
  ordersBody: document.querySelector('#ordersBody'),
  settingsPanel: document.querySelector('#settingsPanel'),
  settingsForm: document.querySelector('#settingsForm'),
  closeSettingsButton: document.querySelector('#closeSettingsButton'),
  userInput: document.querySelector('#userInput'),
  agentUrlInput: document.querySelector('#agentUrlInput'),
  printerInput: document.querySelector('#printerInput'),
  printerList: document.querySelector('#printerList'),
  copiesInput: document.querySelector('#copiesInput'),
  colorModeInput: document.querySelector('#colorModeInput'),
  duplexInput: document.querySelector('#duplexInput'),
  stapleInput: document.querySelector('#stapleInput'),
  stapleOptionInput: document.querySelector('#stapleOptionInput'),
  testAgentButton: document.querySelector('#testAgentButton'),
  docTypeInputs: Array.from(document.querySelectorAll('.doc-type-input')),
  totalOrders: document.querySelector('#totalOrders'),
  readyOrders: document.querySelector('#readyOrders'),
  readyDispatchCombos: document.querySelector('#readyDispatchCombos'),
  pendingDocuments: document.querySelector('#pendingDocuments'),
  printedOrders: document.querySelector('#printedOrders'),
  manualDialog: document.querySelector('#manualDialog'),
  closeManualButton: document.querySelector('#closeManualButton'),
  manualDocumentList: document.querySelector('#manualDocumentList'),
  openDocumentsButton: document.querySelector('#openDocumentsButton'),
  manualCompleteButton: document.querySelector('#manualCompleteButton'),
  toast: document.querySelector('#toast')
};

const SORT_VALUES = new Set(['dispatch', 'latest', 'dispatchDate', 'deliveryMethod', 'dispatchTime', 'distributor', 'customer', 'order']);
const GROUP_VALUES = new Set(['dispatchSlot', 'dispatchDate', 'deliveryMethod', 'dispatchTime', 'distributor', 'none', 'customer', 'packet']);

if (!SORT_VALUES.has(state.sort)) state.sort = 'dispatch';
if (!GROUP_VALUES.has(state.group)) state.group = 'dispatchSlot';

function isoDateFromDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function todayIsoDate() {
  return isoDateFromDate(new Date());
}

function shiftIsoDate(value, days) {
  const [year, month, day] = String(value || todayIsoDate()).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return isoDateFromDate(date);
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(payload.error || payload || `Request failed with ${response.status}`);
  }

  return payload;
}

function formatTime(value) {
  if (!value) return 'No timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatDate(value) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function dispatchLabel(context = {}) {
  const date = context.deliveryDate ? formatDate(context.deliveryDate) : 'No dispatch date';
  const time = context.dispatchTime || 'No time';
  const method = context.deliveryMethodName || (context.deliveryMethod ? `Method ${context.deliveryMethod}` : 'No method');
  return `${date} / ${time} / ${method}`;
}

function distributorKey(context = {}) {
  const distributorNo = Number(context.distributorNo || 0);
  return distributorNo > 0 ? `external:${distributorNo}` : 'internal';
}

function distributorLabel(context = {}) {
  const distributorNo = Number(context.distributorNo || 0);
  if (distributorNo <= 0) return 'Internal';
  return context.distributorName || `Distributor ${distributorNo}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function statusLabel(status) {
  return {
    printed: 'Printed',
    pending: 'Needs print',
    reprint: 'Updated',
    missing: 'Missing',
    blocked: 'Packing left'
  }[status] || status;
}

function packetLabel(status) {
  return {
    printed: 'Printed',
    pending: 'Needs print',
    reprint: 'Updated docs',
    missing: 'Missing docs',
    blocked: 'Packing left'
  }[status] || status;
}

function hasPackingLeft(order = {}) {
  const context = order.context || {};
  return Boolean(order.packingBlocked || context.packingBlocked || Number(context.packingLinesLeft || 0) > 0);
}

function packingLeftText(context = {}) {
  const departments = (context.packingDepartments || [])
    .filter((department) => Number(department.linesLeft || 0) > 0 || Number(department.quantityLeft || 0) !== 0)
    .sort((left, right) => Number(left.departmentBit || 0) - Number(right.departmentBit || 0));

  if (departments.length === 0) return '';

  return departments.map((department) => {
    const items = Number(department.linesLeft || 0);
    const quantity = Number(department.quantityLeft || 0);
    const quantityText = quantity ? ` / ${quantity.toLocaleString()} qty` : '';
    return `${department.department}: ${items} item${items === 1 ? '' : 's'}${quantityText}`;
  }).join(', ');
}

function documentChip(order, type, document) {
  if (!document) {
    if (!(order.requiredTypes || []).includes(type.key)) return '';
    return `<span class="chip status-missing">${type.shortLabel}: Missing</span>`;
  }

  const printStatus = hasPackingLeft(order) && ['packingSlip', 'attachment'].includes(type.key)
    ? 'blocked'
    : document.printStatus;
  const params = new URLSearchParams({
    name: document.name,
    source: document.source || 'primary'
  });
  const href = `/api/documents?${params}`;
  return [
    `<span class="chip status-${printStatus}">`,
    `<a href="${href}" target="_blank" rel="noreferrer">${type.shortLabel}: ${statusLabel(printStatus)}</a>`,
    '</span>'
  ].join('');
}

function distributorOptions(orders) {
  const options = new Map([['all', 'All'], ['internal', 'Internal']]);
  for (const order of orders) {
    const key = distributorKey(order.context);
    if (key !== 'internal' && !options.has(key)) {
      options.set(key, distributorLabel(order.context));
    }
  }

  return Array.from(options.entries()).sort((left, right) => {
    if (left[0] === 'all') return -1;
    if (right[0] === 'all') return 1;
    if (left[0] === 'internal') return -1;
    if (right[0] === 'internal') return 1;
    return compareText(left[1], right[1]);
  });
}

function renderDistributorFilter() {
  const options = distributorOptions(state.orders);
  const valid = new Set(options.map(([value]) => value));
  if (!valid.has(state.distributor)) state.distributor = 'all';

  elements.distributorInput.innerHTML = options
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join('');
  elements.distributorInput.value = state.distributor;
}

function filteredOrders() {
  if (state.distributor === 'all') return [...state.orders];
  return state.orders.filter((order) => distributorKey(order.context) === state.distributor);
}

function selectedOrderNumbers() {
  return Array.from(state.selected);
}

function pruneSelectionToVisibleOrders() {
  const visible = new Set(state.visibleOrders.map((order) => order.orderNumber));
  for (const orderNumber of state.selected) {
    if (!visible.has(orderNumber)) state.selected.delete(orderNumber);
  }
}

function renderSummary() {
  elements.totalOrders.textContent = state.summary.totalOrders || 0;
  elements.readyOrders.textContent = state.summary.readyOrders || 0;
  const combos = state.summary.dispatchCombos || {};
  elements.readyDispatchCombos.textContent = `${combos.readyCombos || 0} / ${combos.totalCombos || 0}`;
  elements.pendingDocuments.textContent = state.summary.pendingDocuments || 0;
  elements.printedOrders.textContent = state.summary.printedOrders || 0;
}

function renderDateControls() {
  elements.dispatchDateInput.value = state.deliveryDate;
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function sortedOrders() {
  const orders = [...state.orders];
  orders.sort((left, right) => {
    if (state.sort === 'dispatch') {
      return compareText(left.context?.deliveryDate || '9999-99-99', right.context?.deliveryDate || '9999-99-99')
        || compareText(left.context?.dispatchTime || '99:99', right.context?.dispatchTime || '99:99')
        || compareText(left.context?.deliveryMethodName || left.context?.deliveryMethod, right.context?.deliveryMethodName || right.context?.deliveryMethod)
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'dispatchDate') {
      return compareText(left.context?.deliveryDate || '9999-99-99', right.context?.deliveryDate || '9999-99-99')
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'deliveryMethod') {
      return compareText(left.context?.deliveryMethodName || left.context?.deliveryMethod, right.context?.deliveryMethodName || right.context?.deliveryMethod)
        || compareText(left.context?.deliveryDate || '9999-99-99', right.context?.deliveryDate || '9999-99-99')
        || compareText(left.context?.dispatchTime || '99:99', right.context?.dispatchTime || '99:99')
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'dispatchTime') {
      return compareText(left.context?.dispatchTime || '99:99', right.context?.dispatchTime || '99:99')
        || compareText(left.context?.deliveryDate || '9999-99-99', right.context?.deliveryDate || '9999-99-99')
        || compareText(left.context?.deliveryMethodName || left.context?.deliveryMethod, right.context?.deliveryMethodName || right.context?.deliveryMethod)
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'distributor') {
      return compareText(distributorLabel(left.context), distributorLabel(right.context))
        || compareText(left.context?.deliveryDate || '9999-99-99', right.context?.deliveryDate || '9999-99-99')
        || compareText(left.context?.dispatchTime || '99:99', right.context?.dispatchTime || '99:99')
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'customer') {
      return compareText(left.context?.customerName, right.context?.customerName)
        || compareText(left.orderNumber, right.orderNumber);
    }

    if (state.sort === 'order') {
      return compareText(left.orderNumber, right.orderNumber);
    }

    return compareText(right.latestUpdated, left.latestUpdated)
      || compareText(left.orderNumber, right.orderNumber);
  });

  return orders;
}

function groupLabel(order) {
  if (state.group === 'dispatchSlot') return dispatchLabel(order.context);
  if (state.group === 'dispatchDate') return order.context?.deliveryDate ? formatDate(order.context.deliveryDate) : 'No dispatch date';
  if (state.group === 'deliveryMethod') return order.context?.deliveryMethodName || (order.context?.deliveryMethod ? `Method ${order.context.deliveryMethod}` : 'No delivery method');
  if (state.group === 'dispatchTime') return order.context?.dispatchTime || 'No departure time';
  if (state.group === 'distributor') return distributorLabel(order.context);
  if (state.group === 'customer') return order.context?.customerName || 'No customer context';
  if (state.group === 'packet') return packetLabel(order.packetStatus);
  return '';
}

function groupName() {
  return state.group === 'dispatchSlot' ? 'combo' : 'group';
}

function documentTypeLabel(typeKey) {
  return state.documentTypes[typeKey]?.shortLabel || state.documentTypes[typeKey]?.label || typeKey;
}

function summarizeGroup(orders) {
  const summary = {
    total: orders.length,
    readyOrders: 0,
    missingOrders: 0,
    blockedOrders: 0,
    pendingOrders: 0,
    reprintOrders: 0,
    printedOrders: 0,
    missingDocuments: 0,
    pendingDocuments: 0,
    latestUpdated: null,
    missingLabels: new Set()
  };

  for (const order of orders) {
    const packingBlocked = hasPackingLeft(order);
    if (order.missingTypes.length === 0 && !packingBlocked) summary.readyOrders += 1;
    if (order.missingTypes.length > 0) summary.missingOrders += 1;
    if (packingBlocked) summary.blockedOrders += 1;
    if (order.packetStatus === 'pending') summary.pendingOrders += 1;
    if (order.packetStatus === 'reprint') summary.reprintOrders += 1;
    if (order.packetStatus === 'printed') summary.printedOrders += 1;
    summary.missingDocuments += order.missingTypes.length;
    for (const typeKey of order.missingTypes) summary.missingLabels.add(documentTypeLabel(typeKey));

    for (const document of Object.values(order.documents || {})) {
      if (document.printStatus !== 'printed') summary.pendingDocuments += 1;
    }

    if (order.latestUpdated && (!summary.latestUpdated || order.latestUpdated > summary.latestUpdated)) {
      summary.latestUpdated = order.latestUpdated;
    }
  }

  summary.canPrint = summary.total > 0 && summary.missingOrders === 0 && summary.blockedOrders === 0;
  return summary;
}

function groupReadiness(summary) {
  if (summary.blockedOrders > 0) {
    return {
      key: 'blocked',
      label: 'Packing left',
      detail: `${summary.blockedOrders} order${summary.blockedOrders === 1 ? '' : 's'} not packed`
    };
  }

  if (summary.missingOrders > 0) {
    return {
      key: 'missing',
      label: 'Waiting for docs',
      detail: `${summary.missingDocuments} missing`
    };
  }

  if (summary.reprintOrders > 0) {
    return {
      key: 'reprint',
      label: 'Updated docs ready',
      detail: `${summary.reprintOrders} updated`
    };
  }

  if (summary.pendingOrders > 0) {
    return {
      key: 'pending',
      label: 'Ready to print',
      detail: `${summary.pendingOrders} not printed`
    };
  }

  if (summary.printedOrders === summary.total) {
    return {
      key: 'printed',
      label: 'Printed',
      detail: `${summary.printedOrders} printed`
    };
  }

  return {
    key: 'pending',
    label: 'All docs ready',
    detail: `${summary.readyOrders} ready`
  };
}

function buildOrderGroups(orders) {
  if (state.group === 'none') return [];

  const groups = [];
  let current = null;

  for (const order of orders) {
    const label = groupLabel(order);
    if (!current || current.label !== label) {
      current = {
        id: `group-${groups.length}`,
        label,
        orders: []
      };
      groups.push(current);
    }
    current.orders.push(order);
  }

  for (const group of groups) {
    group.summary = summarizeGroup(group.orders);
  }

  return groups;
}

function renderGroupRow(group) {
  const summary = group.summary;
  const readiness = groupReadiness(summary);
  const actionName = groupName();
  const selectedCount = group.orders.filter((order) => state.selected.has(order.orderNumber)).length;
  const blockedText = summary.blockedOrders > 0
    ? `${summary.blockedOrders} order${summary.blockedOrders === 1 ? '' : 's'} still have warehouse packing left`
    : '';
  const missingText = summary.missingLabels.size > 0
    ? `Missing ${Array.from(summary.missingLabels).slice(0, 3).join(', ')}`
    : 'No missing documents';
  const disabledText = [blockedText, summary.missingOrders > 0 ? missingText : ''].filter(Boolean).join('. ');
  const printLabel = summary.printedOrders === summary.total ? `Reprint ${actionName}` : `Print ${actionName}`;
  const disabled = summary.canPrint ? '' : 'disabled';
  const disabledTitle = summary.canPrint ? '' : ` title="${escapeHtml(disabledText)}"`;

  return `
    <tr class="group-row group-status-${readiness.key}">
      <td colspan="8">
        <div class="group-summary">
          <label class="group-picker">
            <input class="group-checkbox" type="checkbox" data-group-id="${group.id}" ${disabled}${disabledTitle}>
            <span>${state.group === 'dispatchSlot' ? 'Select combo' : 'Select group'}</span>
          </label>
          <div class="group-heading">
            <span class="group-status-pill status-${readiness.key}">${escapeHtml(readiness.label)}</span>
            <strong>${escapeHtml(group.label)}</strong>
            <small>${escapeHtml(readiness.detail)}${summary.latestUpdated ? ` / last update ${escapeHtml(formatTime(summary.latestUpdated))}` : ''}</small>
          </div>
          <div class="group-metrics" aria-label="Group readiness">
            <span>${summary.total} order${summary.total === 1 ? '' : 's'}</span>
            <span>${summary.readyOrders}/${summary.total} ready</span>
            ${summary.blockedOrders > 0 ? `<span>${summary.blockedOrders} packing left</span>` : ''}
            <span>${
              summary.missingDocuments > 0
                ? `${summary.missingDocuments} doc${summary.missingDocuments === 1 ? '' : 's'} missing`
                : `${summary.pendingDocuments} doc${summary.pendingDocuments === 1 ? '' : 's'} need print`
            }</span>
            <span>${summary.printedOrders} printed</span>
            ${selectedCount > 0 ? `<span>${selectedCount} selected</span>` : ''}
          </div>
          <div class="group-actions">
            <button class="button secondary group-print" type="button" data-group-id="${group.id}" ${disabled}${disabledTitle}>${escapeHtml(printLabel)}</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function syncGroupCheckboxes() {
  for (const checkbox of elements.ordersBody.querySelectorAll('.group-checkbox')) {
    const group = state.groupIndex.get(checkbox.dataset.groupId);
    if (!group) continue;
    const selectedCount = group.orders.filter((order) => state.selected.has(order.orderNumber)).length;
    checkbox.checked = selectedCount > 0 && selectedCount === group.orders.length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < group.orders.length;
  }
}

function renderSelection() {
  const count = state.selected.size;
  elements.selectionLabel.textContent = count === 0 ? 'No orders selected' : `${count} order${count === 1 ? '' : 's'} selected`;
  elements.printSelectedButton.disabled = count === 0;
  elements.markPrintedButton.disabled = count === 0;
  elements.selectAll.checked = state.visibleOrders.length > 0 && state.visibleOrders.every((order) => state.selected.has(order.orderNumber));
  elements.selectAll.indeterminate = count > 0 && !elements.selectAll.checked;
}

function renderOrders() {
  state.groupIndex = new Map();
  state.visibleOrders = filteredOrders();

  if (state.visibleOrders.length === 0) {
    const distributorText = state.distributor === 'all' ? '' : ` for ${distributorLabel(state.orders.find((order) => distributorKey(order.context) === state.distributor)?.context || {})}`;
    elements.ordersBody.innerHTML = `<tr><td colspan="8" class="empty">No orders match ${escapeHtml(formatDate(state.deliveryDate))}${escapeHtml(distributorText)}</td></tr>`;
    renderSelection();
    return;
  }

  const rows = [];
  const visibleOrderNumbers = new Set(state.visibleOrders.map((order) => order.orderNumber));
  const ordered = sortedOrders().filter((order) => visibleOrderNumbers.has(order.orderNumber));
  const groups = buildOrderGroups(ordered);
  const rowsToRender = state.group === 'none'
    ? [{ orders: ordered }]
    : groups;

  for (const group of rowsToRender) {
    if (state.group !== 'none') {
      state.groupIndex.set(group.id, group);
      rows.push(renderGroupRow(group));
    }

    for (const order of group.orders) {
      const chips = Object.values(state.documentTypes)
        .sort((left, right) => left.order - right.order)
        .map((type) => documentChip(order, type, order.documents[type.key]))
        .join('');

      const context = order.context || {};
      const customer = context.customerName || context.deliveryName || 'No SQL context';
      const distributor = distributorLabel(context);
      const refs = [context.yourReference, context.requisitionNo, context.consignmentNo]
        .filter(Boolean)
        .join(' / ');
      const topLines = (context.topLines || [])
        .map((line) => `${line.quantity || ''} ${line.unit || ''} ${line.description || line.productNo}`.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(', ');
      const packingText = packingLeftText(context);
      const note = context.orderNote ? `<small class="context-note">${escapeHtml(context.orderNote)}</small>` : '';
      const printBlocked = hasPackingLeft(order);
      const printBlockedTitle = printBlocked ? ` title="${escapeHtml(`Packing left: ${packingText}`)}" disabled` : '';

      rows.push(`
        <tr>
          <td>
            <input class="order-checkbox" type="checkbox" value="${order.orderNumber}" ${state.selected.has(order.orderNumber) ? 'checked' : ''}>
          </td>
          <td>
            <div class="order-meta">
              <a class="order-link" href="/api/orders/${encodeURIComponent(order.orderNumber)}" target="_blank" rel="noreferrer">${escapeHtml(order.orderNumber)}</a>
              <small>${escapeHtml(customer)}${context.customerNo ? ` (#${escapeHtml(context.customerNo)})` : ''}</small>
              <small>${escapeHtml(distributor)}${context.distributorNo ? ` (#${escapeHtml(context.distributorNo)})` : ''}</small>
              ${refs ? `<small>${escapeHtml(refs)}</small>` : ''}
            </div>
          </td>
          <td>
            <div class="delivery-meta">
              <span>${escapeHtml(formatDate(context.deliveryDate))}</span>
              <strong>${escapeHtml(context.dispatchTime || 'No time')}</strong>
              <small>${escapeHtml(context.deliveryMethodName || (context.deliveryMethod ? `Method ${context.deliveryMethod}` : 'No method'))}</small>
              ${context.desiredProductionDate ? `<small>Production ${escapeHtml(formatDate(context.desiredProductionDate))}</small>` : ''}
              ${context.isActive === false ? '<small>Inactive in Visma</small>' : ''}
            </div>
          </td>
          <td>
            <div class="line-meta">
              <span>${Number(context.lineCount || 0)} items / ${Number(context.totalQuantity || 0).toLocaleString()} qty</span>
              ${packingText ? `<small class="packing-left">Packing left: ${escapeHtml(packingText)}</small>` : ''}
              ${topLines ? `<small>${escapeHtml(topLines)}</small>` : ''}
              ${note}
            </div>
          </td>
          <td><div class="doc-stack">${chips}</div></td>
          <td>${formatTime(order.latestUpdated)}</td>
          <td><span class="packet-status status-${order.packetStatus}">${packetLabel(order.packetStatus)}</span></td>
          <td>
            <div class="row-actions">
              <button class="button secondary row-print" type="button" data-order="${order.orderNumber}"${printBlockedTitle}>Print</button>
            </div>
          </td>
        </tr>
      `);
    }
  }

  elements.ordersBody.innerHTML = rows.join('');
  renderSelection();
  syncGroupCheckboxes();
}

async function loadHealth() {
  const health = await api('/api/health');
  elements.storageLabel.textContent = environmentLabel(health);
}

function environmentLabel(health) {
  if (health.mode === 'mock') return 'Kvalitetsfisk MOCK';

  const prefix = String(health.prefix || '').replace(/^\/+|\/+$/g, '');
  if (prefix === '2') return 'Kvalitetsfisk LIVE';
  if (prefix === '9992') return 'Kvalitetsfisk DEMO';
  if (prefix) return `Kvalitetsfisk ${prefix}`;
  return 'Kvalitetsfisk';
}

function configuredDocumentTypes() {
  const types = Object.keys(state.documentTypes || {});
  return types.length > 0 ? types : ['packingSlip', 'attachment', 'freight'];
}

function syncDocumentTypeControls() {
  const visible = new Set(configuredDocumentTypes());
  for (const input of elements.docTypeInputs) {
    const row = input.closest('.checkbox-line');
    const isVisible = visible.has(input.value);
    input.disabled = !isVisible;
    if (!isVisible) input.checked = false;
    if (row) row.hidden = !isVisible;
  }
}

async function loadDefaults() {
  const payload = await api(`/api/defaults?user=${encodeURIComponent(state.user)}`);
  const local = JSON.parse(localStorage.getItem('printward:defaults') || '{}');
  state.defaults = {
    ...payload.defaults,
    ...local
  };
  fillSettingsForm();
}

async function loadOrders(options = {}) {
  const query = new URLSearchParams({
    q: elements.searchInput.value.trim(),
    status: state.status,
    deliveryDate: state.deliveryDate
  });
  if (options.refresh) query.set('refresh', '1');
  const payload = await api(`/api/orders?${query}`);
  state.orders = payload.orders;
  state.summary = payload.summary;
  state.documentTypes = payload.documentTypes;
  state.contextStatus = payload.contextStatus || {};
  renderDistributorFilter();
  state.visibleOrders = filteredOrders();
  pruneSelectionToVisibleOrders();
  syncDocumentTypeControls();
  renderDateControls();
  renderSummary();
  renderOrders();
  if (state.contextStatus.error) {
    console.warn('Order context unavailable:', state.contextStatus.error);
  }
}

async function checkAgent() {
  const agentUrl = state.defaults.agentUrl || elements.agentUrlInput.value || 'http://127.0.0.1:37951';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(`${agentUrl}/health`, { signal: controller.signal });
    state.agentOnline = response.ok;
  } catch {
    state.agentOnline = false;
  } finally {
    window.clearTimeout(timeout);
  }

  if (state.agentOnline) await loadPrinters();
}

async function loadPrinters() {
  const agentUrl = state.defaults.agentUrl || 'http://127.0.0.1:37951';
  try {
    const response = await fetch(`${agentUrl}/printers`);
    if (!response.ok) return;
    const payload = await response.json();
    elements.printerList.innerHTML = (payload.printers || [])
      .map((printer) => `<option value="${printer.name}">${printer.isDefault ? 'System default' : ''}</option>`)
      .join('');

    const defaultPrinter = (payload.printers || []).find((printer) => printer.isDefault);
    if (!state.defaults.printerName && defaultPrinter) {
      elements.printerInput.placeholder = defaultPrinter.name;
    }
  } catch {
    // Printer discovery is optional.
  }
}

function fillSettingsForm() {
  const defaults = state.defaults;
  elements.userInput.value = state.user;
  elements.agentUrlInput.value = defaults.agentUrl || 'http://127.0.0.1:37951';
  elements.printerInput.value = defaults.printerName || '';
  elements.copiesInput.value = defaults.copies || 1;
  elements.colorModeInput.value = defaults.colorMode || 'auto';
  elements.duplexInput.checked = defaults.duplex !== false;
  elements.stapleInput.checked = defaults.staple !== false;
  elements.stapleOptionInput.value = defaults.stapleOption || 'StapleLocation=UpperLeft';

  const selectedTypes = new Set(defaults.documentTypes || configuredDocumentTypes());
  for (const input of elements.docTypeInputs) {
    input.checked = selectedTypes.has(input.value);
  }
  syncDocumentTypeControls();
}

function readSettingsForm() {
  const documentTypes = elements.docTypeInputs
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value);

  return {
    agentUrl: elements.agentUrlInput.value.trim() || 'http://127.0.0.1:37951',
    printerName: elements.printerInput.value.trim(),
    copies: Math.max(1, Number(elements.copiesInput.value || 1)),
    colorMode: elements.colorModeInput.value,
    duplex: elements.duplexInput.checked,
    staple: elements.stapleInput.checked,
    stapleOption: elements.stapleOptionInput.value.trim(),
    documentTypes: documentTypes.length > 0 ? documentTypes : configuredDocumentTypes()
  };
}

function setSettingsOpen(open) {
  elements.settingsPanel.classList.toggle('open', open);
  elements.settingsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

async function saveSettings(event) {
  event.preventDefault();
  state.user = elements.userInput.value.trim() || 'operator';
  localStorage.setItem('printward:user', state.user);
  state.defaults = readSettingsForm();
  localStorage.setItem('printward:defaults', JSON.stringify(state.defaults));
  await api('/api/defaults', {
    method: 'POST',
    body: JSON.stringify({ user: state.user, defaults: state.defaults })
  });
  setSettingsOpen(false);
  await checkAgent();
  toast('Print defaults saved');
}

async function createPrintJob(orderNumbers) {
  return api('/api/print-jobs', {
    method: 'POST',
    body: JSON.stringify({
      user: state.user,
      orderNumbers,
      documentTypes: state.defaults.documentTypes,
      printerName: state.defaults.printerName,
      options: state.defaults
    })
  });
}

function confirmIncompletePackets(orderNumbers) {
  const selected = new Set(orderNumbers);
  const blocked = state.orders.filter((order) => selected.has(order.orderNumber) && hasPackingLeft(order));
  if (blocked.length > 0) {
    const details = blocked.slice(0, 4)
      .map((order) => `${order.orderNumber}: ${packingLeftText(order.context) || 'packing left'}`)
      .join('\n');
    window.alert(`${blocked.length} selected order packet(s) still have warehouse packing left and cannot be printed yet.\n\n${details}`);
    return false;
  }

  const incomplete = state.orders.filter((order) => selected.has(order.orderNumber) && order.missingTypes.length > 0);
  if (incomplete.length === 0) return true;

  const missingDocuments = incomplete.reduce((total, order) => total + order.missingTypes.length, 0);
  return window.confirm(`${incomplete.length} selected order packet(s) are missing ${missingDocuments} required document(s). Print available documents anyway?`);
}

async function sendToAgent(jobPayload) {
  const agentUrl = state.defaults.agentUrl || 'http://127.0.0.1:37951';
  const response = await fetch(`${agentUrl}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...jobPayload.manifest,
      user: state.user,
      printerName: state.defaults.printerName,
      options: state.defaults
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Local print agent failed.');
  }
  return payload;
}

function showManualDialog(jobPayload) {
  state.activeManualJob = jobPayload;
  elements.manualDocumentList.innerHTML = jobPayload.manifest.orders.map((order) => {
    const links = order.documents.map((document) => {
      return `<a href="${document.url}" target="_blank" rel="noreferrer">${document.typeLabel}</a>`;
    }).join('');
    return `<div class="manual-order"><strong>Order ${order.orderNumber}</strong>${links}</div>`;
  }).join('');
  elements.manualDialog.hidden = false;
  elements.manualDialog.classList.add('open');
}

function closeManualDialog() {
  elements.manualDialog.classList.remove('open');
  elements.manualDialog.hidden = true;
  state.activeManualJob = null;
}

async function printOrders(orderNumbers) {
  if (orderNumbers.length === 0) return;
  if (!confirmIncompletePackets(orderNumbers)) return;
  const jobPayload = await createPrintJob(orderNumbers);

  if (!state.agentOnline) {
    showManualDialog(jobPayload);
    toast('Local print agent is offline');
    return;
  }

  toast('Sending packet to local printer');
  await sendToAgent(jobPayload);
  state.selected.clear();
  await loadOrders();
  toast('Print job completed');
}

async function markPrinted(orderNumbers) {
  if (orderNumbers.length === 0) return;
  const jobPayload = await createPrintJob(orderNumbers);
  await api(`/api/print-jobs/${jobPayload.job.id}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'printed',
      user: state.user,
      printerName: state.defaults.printerName || 'manual'
    })
  });
  state.selected.clear();
  await loadOrders();
  toast('Selected documents marked printed');
}

async function setDeliveryDate(value) {
  state.deliveryDate = value || todayIsoDate();
  state.selected.clear();
  renderDateControls();
  await loadOrders();
}

function bindEvents() {
  elements.sortInput.value = state.sort;
  elements.groupInput.value = state.group;
  elements.distributorInput.value = state.distributor;
  renderDateControls();

  elements.refreshButton.addEventListener('click', async () => {
    await Promise.all([loadOrders({ refresh: true }), checkAgent()]);
    toast('Order list refreshed');
  });

  elements.searchInput.addEventListener('input', () => {
    window.clearTimeout(bindEvents.searchTimer);
    bindEvents.searchTimer = window.setTimeout(loadOrders, 180);
  });

  elements.dispatchDateInput.addEventListener('change', async () => {
    await setDeliveryDate(elements.dispatchDateInput.value);
  });

  elements.todayButton.addEventListener('click', async () => {
    await setDeliveryDate(todayIsoDate());
  });

  elements.nextDayButton.addEventListener('click', async () => {
    await setDeliveryDate(shiftIsoDate(state.deliveryDate, 1));
  });

  elements.sortInput.addEventListener('change', () => {
    state.sort = elements.sortInput.value;
    localStorage.setItem('printward:sort', state.sort);
    renderOrders();
  });

  elements.distributorInput.addEventListener('change', () => {
    state.distributor = elements.distributorInput.value;
    localStorage.setItem('printward:distributor', state.distributor);
    state.selected.clear();
    renderOrders();
  });

  elements.groupInput.addEventListener('change', () => {
    state.group = elements.groupInput.value;
    localStorage.setItem('printward:group', state.group);
    renderOrders();
  });

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      state.status = button.dataset.status;
      state.selected.clear();
      await loadOrders();
    });
  });

  elements.ordersBody.addEventListener('change', (event) => {
    if (event.target.matches('.group-checkbox')) {
      const group = state.groupIndex.get(event.target.dataset.groupId);
      if (!group) return;
      for (const order of group.orders) {
        if (event.target.checked) state.selected.add(order.orderNumber);
        else state.selected.delete(order.orderNumber);
      }
      renderOrders();
      return;
    }

    if (event.target.matches('.order-checkbox')) {
      if (event.target.checked) state.selected.add(event.target.value);
      else state.selected.delete(event.target.value);
      renderSelection();
      syncGroupCheckboxes();
    }
  });

  elements.ordersBody.addEventListener('click', async (event) => {
    const groupButton = event.target.closest('.group-print');
    if (groupButton) {
      const group = state.groupIndex.get(groupButton.dataset.groupId);
      if (!group || groupButton.disabled) return;
      await printOrders(group.orders.map((order) => order.orderNumber));
      return;
    }

    const button = event.target.closest('.row-print');
    if (button) await printOrders([button.dataset.order]);
  });

  elements.selectAll.addEventListener('change', () => {
    if (elements.selectAll.checked) {
      for (const order of state.visibleOrders) state.selected.add(order.orderNumber);
    } else {
      state.selected.clear();
    }
    renderOrders();
  });

  elements.printSelectedButton.addEventListener('click', async () => {
    await printOrders(selectedOrderNumbers());
  });

  elements.markPrintedButton.addEventListener('click', async () => {
    const orderNumbers = selectedOrderNumbers();
    const confirmed = window.confirm(`Mark ${orderNumbers.length} selected order packet(s) as printed?`);
    if (confirmed) await markPrinted(orderNumbers);
  });

  elements.settingsButton.addEventListener('click', () => {
    fillSettingsForm();
    setSettingsOpen(true);
  });

  elements.closeSettingsButton.addEventListener('click', () => setSettingsOpen(false));
  elements.settingsPanel.addEventListener('click', (event) => {
    if (event.target === elements.settingsPanel) setSettingsOpen(false);
  });
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.testAgentButton.addEventListener('click', async () => {
    state.defaults = { ...state.defaults, ...readSettingsForm() };
    await checkAgent();
    toast(state.agentOnline ? 'Local print agent is reachable' : 'Local print agent is offline');
  });

  elements.closeManualButton.addEventListener('click', closeManualDialog);
  elements.openDocumentsButton.addEventListener('click', () => {
    const jobPayload = state.activeManualJob;
    if (!jobPayload) return;
    for (const order of jobPayload.manifest.orders) {
      for (const document of order.documents) {
        window.open(document.url, '_blank', 'noopener,noreferrer');
      }
    }
  });
  elements.manualCompleteButton.addEventListener('click', async () => {
    const jobPayload = state.activeManualJob;
    if (!jobPayload) return;
    await api(`/api/print-jobs/${jobPayload.job.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'printed',
        user: state.user,
        printerName: state.defaults.printerName || 'manual'
      })
    });
    closeManualDialog();
    state.selected.clear();
    await loadOrders();
    toast('Manual print marked complete');
  });
}

async function init() {
  bindEvents();
  await loadHealth();
  await loadDefaults();
  await checkAgent();
  await loadOrders();
}

init().catch((error) => {
  console.error(error);
  toast(error.message);
});
