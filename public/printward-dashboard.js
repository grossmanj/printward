import { createVirtualPrinter } from './printward-virtual-printer.js';
import { sortLookupItems } from './printward-lookup-sort.js';

const dialog = document.querySelector('#detailsDialog');
const title = document.querySelector('#dialogTitle');
const detail = document.querySelector('#dialogDetail');
const toast = document.querySelector('#toast');
const grid = document.querySelector('.grid');
const ordersView = document.querySelector('#ordersView');
const search = document.querySelector('#dashboardSearch');
const dashboardSort = document.querySelector('#dashboardSort');
const deliveryDate = document.querySelector('#dashboardDate');
const total = document.querySelector('#dashboardTotal');
const packing = document.querySelector('#dashboardPacking');
const dashboardSource = document.querySelector('#dashboardSource');
const simulationDialog = document.querySelector('#simulationDialog');
const simulationToggle = document.querySelector('#simulationToggle');
const simulationStatus = document.querySelector('#simulationStatus');
let simulationStorage;
try { simulationStorage = window.sessionStorage; } catch { simulationStorage = null; }
const virtualPrinter = createVirtualPrinter(simulationStorage);
let simulationEnabled = false;
let proposedSimulation = null;
let lookupSort = 'priority';
const statuses = { alla: 'all', plock: 'blocked', uppdaterade: 'reprint', saknade: 'missing' };
const stockholmDateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
});
function todayInStockholm() { return stockholmDateFormatter.format(new Date()); }
function followingDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
let activeView = 'printward';
let activeFreightPanel = null;
let freightPayload = null;
let freightRequest = 0;
const selectedFreightOrders = new Set();
let freightReviewOpen = false;
let freightReviewPending = false;
let freightPlan = null;
let freightPlanError = '';
let freightPlanRequest = 0;
let returnPayload = null;
let returnRequest = 0;
const selectedReturnOrders = new Set();
let returnReviewOpen = false;
let pickupPayload = null;
let pickupRequest = 0;
let dispatchPayload = null;
let dispatchRequest = 0;
let activeDispatchSlot = null;
const selectedDispatchOrders = new Set();
let dispatchReviewOpen = false;
let chainPayload = null;
let chainRequest = 0;
let activeChainPanel = null;
const selectedChainOrders = new Set();
let chainReviewOpen = false;

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]); }
function statusLabel(status) { return ({ missing: 'Saknas', blocked: 'Pågående plock', ready: 'Klar', pending: 'Behöver utskrift', reprint: 'Uppdaterad', printed: 'Utskriven' })[status] || status || 'Okänd'; }
const previewNames = { packingSlip: 'följesedel', attachment: 'partibilaga', freight: 'fraktsedel', pallet: 'etiketter och fraktsedel' };
const documentNames = { packingSlip: 'Följesedel', attachment: 'Partibilaga', freight: 'Fraktsedel', pallet: 'Etiketter och fraktsedel' };
const simulationNames = { ...documentNames, pickup: 'Hämtning/bud/taxi · mall ej verifierad' };

function simulated(orderNumber, type, date = deliveryDate.value) {
  return simulationEnabled && virtualPrinter.has(date, String(orderNumber), type);
}

function pendingOrderDocuments(order, types, date = deliveryDate.value) {
  return types.filter((type) => order.documents?.[type]
    && order.documents[type].printStatus !== 'printed'
    && !simulated(order.orderNumber, type, date))
    .map((type) => ({ deliveryDate: date, orderNumber: String(order.orderNumber), type }));
}

function packetCandidates(order, date = deliveryDate.value) {
  const types = ['packingSlip', 'attachment'];
  if (!types.every((type) => order.documents?.[type])) return [];
  if (types.every((type) => order.documents[type].printStatus === 'printed')) return [];
  if (types.every((type) => simulated(order.orderNumber, type, date))) return [];
  return types.map((type) => ({ deliveryDate: date, orderNumber: String(order.orderNumber), type }));
}

function virtualPrintLabel(orderNumber, types, date = deliveryDate.value) {
  return types.every((type) => simulated(orderNumber, type, date)) ? 'Simulerat utskriven' : '';
}

function setVirtualCount(card, count) {
  if (!card?.parentElement) return;
  let badge = card.parentElement.querySelector('.virtual-count');
  if (!badge) {
    badge = document.createElement('small');
    badge.className = 'virtual-count';
    card.parentElement.append(badge);
  }
  badge.textContent = `${count} simulerad${count === 1 ? '' : 'e'} order`;
  badge.hidden = !simulationEnabled || !count;
}

function setVirtualQuick(card, label, items, note = '', verifyFreightPanelId = null) {
  const button = card?.parentElement?.querySelector(':scope > .quick-print');
  if (!button) return;
  button.dataset.originalLabel ||= button.textContent;
  button.textContent = simulationEnabled ? 'Simulera utskrift' : button.dataset.originalLabel;
  button.disabled = !simulationEnabled || items.length === 0;
  button.title = simulationEnabled ? items.length ? `Virtuell utskrift · ${items.length} dokument` : 'Inga dokument kvar att simulera' : 'Riktiga utskrifter är spärrade i läsläget';
  button.onclick = (event) => {
    event.stopPropagation();
    if (verifyFreightPanelId) openVerifiedFreightSimulation(label, items, verifyFreightPanelId);
    else openVirtualPrint(label, items, note);
  };
}

function virtualPacketRows(items) {
  const packets = new Map();
  for (const item of items) {
    if (!packets.has(item.orderNumber)) packets.set(item.orderNumber, []);
    packets.get(item.orderNumber).push(item.type);
  }
  return [...packets].map(([orderNumber, types]) => {
    const paired = types.includes('packingSlip') && types.includes('attachment');
    const sequence = types.map((type) => simulationNames[type]).join(' → ');
    const handling = paired ? 'Planerad bunt: de här två ska häftas ihop för denna order'
      : types.includes('freight') || types.includes('pallet') ? 'Fraktdokument/etiketter separat · ingen följesedel'
        : 'Ingen verifierad dokumentmall eller ihophäftning';
    return `<li><strong>Order ${escapeHtml(orderNumber)}</strong><span>${escapeHtml(sequence)}</span><small>${escapeHtml(handling)}</small></li>`;
  }).join('');
}

function openVirtualPrint(label, items, note = '') {
  if (!simulationEnabled || !items.length) return;
  proposedSimulation = { label, items };
  const orders = new Set(items.map((item) => item.orderNumber));
  document.querySelector('#simulationTitle').textContent = 'Virtuell utskrift';
  document.querySelector('#simulationDescription').textContent = `${label}: ${orders.size} order, ${items.length} ${items.length === 1 ? 'virtuellt dokument' : 'virtuella dokument'}.${note ? ` ${note}` : ''}`;
  document.querySelector('#simulationItems').innerHTML = virtualPacketRows(items);
  document.querySelector('#simulationConfirm').hidden = false;
  document.querySelector('#simulationCancel').textContent = 'Avbryt';
  simulationDialog.showModal();
}

function showVirtualHistory() {
  const jobs = virtualPrinter.jobs();
  if (!jobs.length) return;
  proposedSimulation = null;
  document.querySelector('#simulationTitle').textContent = 'Testkö · inga riktiga utskrifter';
  document.querySelector('#simulationDescription').textContent = `${jobs.length} virtuell${jobs.length === 1 ? '' : 'a'} utskrift${jobs.length === 1 ? '' : 'er'} i denna webbläsarflik.`;
  document.querySelector('#simulationItems').innerHTML = jobs.map((job, index) =>
    `<li class="simulation-job"><strong>${index + 1}. ${escapeHtml(job.label)}</strong><ol>${virtualPacketRows(job.items)}</ol></li>`).join('');
  document.querySelector('#simulationConfirm').hidden = true;
  document.querySelector('#simulationCancel').textContent = 'Stäng';
  simulationDialog.showModal();
}

async function openVerifiedFreightSimulation(label, items, panelId) {
  if (!simulationEnabled || !items.length) return;
  const date = deliveryDate.value;
  try {
    const response = await fetch('/api/dashboard/freight-packet-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryDate: date, panelId, orderNumbers: [...new Set(items.map((item) => item.orderNumber))] })
    });
    const result = await response.json();
    if (!simulationEnabled || date !== deliveryDate.value) return;
    if (!response.ok || !result.valid) {
      showToast(`Simulering stoppad: ${(result.errors || [result.error || 'PDF-kontrollen misslyckades']).join(' ')}`);
      return;
    }
    openVirtualPrint(label, items, 'PDF-sidorna har kontrollerats av servern i läsläge. Inget nShift-anrop görs.');
  } catch (error) { showToast(`Simulering stoppad: ${error.message}`); }
}

function updateSimulationStatus() {
  const jobs = virtualPrinter.jobs();
  const items = jobs.flatMap((job) => job.items);
  const orders = new Set(items.map((item) => `${item.deliveryDate}|${item.orderNumber}`));
  document.body.classList.toggle('simulation-active', simulationEnabled);
  document.querySelector('.read-only-banner').textContent = simulationEnabled
    ? 'TESTLÄGE · inga riktiga utskrifter' : 'Endast läsning · inga utskrifter';
  simulationToggle.textContent = simulationEnabled ? 'Stoppa testläge' : 'Starta virtuell skrivare';
  simulationToggle.setAttribute('aria-pressed', String(simulationEnabled));
  simulationStatus.textContent = simulationEnabled
    ? `${orders.size} order · ${items.length} ${items.length === 1 ? 'dokument simulerat' : 'dokument simulerade'} i denna webbläsare. Riktiga statusar är oförändrade.`
    : 'Testläget är avstängt. Riktiga utskrifter är alltid spärrade i den här vyn.';
  document.querySelector('#simulationHistory').hidden = jobs.length === 0;
  document.querySelector('#simulationReset').hidden = jobs.length === 0;
}

function refreshSimulationDisplays() {
  updateSimulationStatus();
  if (freightPayload) renderFreightCards(freightPayload);
  if (dispatchPayload) renderDispatchCards(dispatchPayload);
  if (chainPayload) renderChainCards(chainPayload);
  if (pickupPayload) renderPickupCard(pickupPayload);
  if (activeView === 'freight' && freightPayload) renderFreightList();
  if (activeView === 'dispatch' && dispatchPayload) renderDispatchList();
  if (activeView === 'chains' && chainPayload) renderChainList();
  if ((activeView === 'pickups' || activeView === 'staff') && pickupPayload) renderPickupList(pickupPayload, activeView === 'staff');
}
function lookupSortControl() {
  return '<span class="read-only">Endast läsning</span>';
}
function documentPreviewLink(document) {
  const params = new URLSearchParams({ name: document.name, source: document.source || 'primary' });
  if (document.generation) params.set('generation', document.generation);
  return `<a href="/api/documents?${escapeHtml(params.toString())}" target="_blank" rel="noopener noreferrer">Granska ${escapeHtml(previewNames[document.type] || 'dokument')}</a>`;
}
function showToast(message) { toast.textContent = message; toast.classList.add('show'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2400); }
function setActive(view) { activeView = view; document.querySelectorAll('.nav-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view)); grid.hidden = view !== 'printward'; ordersView.hidden = view === 'printward'; document.querySelector('#lookupActions').hidden = view === 'printward'; }
function updateUpdatedBadge(count) { const badge = document.querySelector('[data-view="uppdaterade"] i'); badge.textContent = count ?? ''; badge.hidden = !count; }

const freightNames = {
  'kyl-and-frys': 'Kyl & Frys',
  'dsv-finland': 'DSV Finland',
  'best-transport': 'Best Transport',
  eriksson: 'Eriksson',
  'other-carriers': 'Övriga Åkerier'
};

function clearFreightReview() {
  freightPlanRequest += 1;
  freightReviewOpen = false;
  freightReviewPending = false;
  freightPlan = null;
  freightPlanError = '';
}

function renderFreightCards(payload) {
  const available = payload.contextStatus?.available !== false;
  const isMock = payload.contextStatus?.mode === 'mock';
  dashboardSource.textContent = available
    ? `${isMock ? 'Lokal testdata' : 'Orderdata'} för ${payload.deliveryDate}. Följesedlar, fraktsedlar, returer, hämtningar och kedjor hämtas från data. Övriga kunder väntar på DocSmt-regeln.`
    : 'Orderkälla saknas. Dashboardens order- och dokumentsiffror kan inte visas.';
  total.textContent = available ? payload.summary?.totalOrders ?? 0 : '–';
  packing.textContent = available ? payload.summary?.blockedOrders ?? 0 : '–';
  updateUpdatedBadge(available ? payload.summary?.reprintOrders ?? 0 : null);
  document.querySelectorAll('[data-freight-panel]').forEach((card) => {
    const panel = payload.panels?.[card.dataset.freightPanel];
    const primary = card.querySelector('b em');
    const count = card.querySelector('.freight-total');
    const badge = card.querySelector('strong i');
    if (primary) primary.textContent = available ? (panel?.documentTracking ? panel.ready : panel?.departureCount) ?? 0 : '–';
    if (count) count.textContent = available ? panel?.total ?? 0 : '–';
    if (badge) {
      badge.textContent = available ? panel?.waiting ?? 0 : '';
      badge.hidden = !available || !panel?.waiting;
      badge.title = `${panel?.waiting ?? 0} order saknar fraktdokument`;
    }
    const candidates = available && panel?.documentTracking
      ? panel.orders.flatMap(({ order, documentType }) => pendingOrderDocuments(order, [documentType].filter(Boolean))) : [];
    const simulatedCount = panel?.orders.filter(({ order, documentType }) => documentType && simulated(order.orderNumber, documentType)).length || 0;
    setVirtualCount(card, simulatedCount);
    if (panel?.documentTracking) setVirtualQuick(card, `${freightNames[card.dataset.freightPanel]} · klara avgångar`, candidates,
      'Endast befintliga fraktdokument/etiketter tas med; inga följesedlar eller nShift-anrop.', card.dataset.freightPanel);
  });
}

function renderFreightList() {
  if (freightPayload?.contextStatus?.available === false) {
    ordersView.innerHTML = '<div class="orders-empty">Orderkällan är inte tillgänglig. Inga fraktsedelssiffror kan visas.</div>';
    return;
  }
  const panel = freightPayload?.panels?.[activeFreightPanel];
  if (!panel) {
    ordersView.innerHTML = '<div class="orders-empty">Hämtar fraktsedlar…</div>';
    return;
  }
  const query = search.value.trim().toLowerCase();
  const visibleItems = sortLookupItems(panel.orders.filter(({ order }) => {
    if (!query) return true;
    const context = order.context || {};
    return [order.orderNumber, context.customerNo, context.customerName, context.deliveryName,
      context.routeGroup, context.deliveryMethodName, context.freightConsignmentFresh,
      context.freightConsignmentFrozen, ...(context.freightConsignmentNumbers || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(query);
  }), lookupSort);
  const selectableVisible = visibleItems.filter(({ order, documentType, documentReady }) => documentReady
    && pendingOrderDocuments(order, [documentType]).length);
  const selectedItems = panel.orders.filter(({ order, documentType, documentReady }) => documentReady
    && pendingOrderDocuments(order, [documentType]).length && selectedFreightOrders.has(String(order.orderNumber)));
  const rows = visibleItems.flatMap(({ order, documentType, documentReady, printStatus, bookings }) => {
    const context = order.context || {};
    const virtualStatus = documentType && simulated(order.orderNumber, documentType);
    const selectable = documentReady && pendingOrderDocuments(order, [documentType]).length > 0;
    const status = panel.documentTracking
      ? documentReady ? virtualStatus ? 'Simulerat utskriven · riktig status oförändrad' : `Dokument finns · ${statusLabel(printStatus)}` : 'Fraktdokument saknas'
      : 'Avgång visas · ingen utskrift här';
    const bookingRows = bookings?.length ? bookings : [{ kind: '–', number: '–' }];
    return bookingRows.map((booking, index) => `<tr data-order="${escapeHtml(order.orderNumber)}" class="${index ? 'freight-booking-extra' : ''}">${index ? '' : `${panel.documentTracking ? `<td rowspan="${bookingRows.length}"><input class="freight-select" type="checkbox" data-select-freight-order="${escapeHtml(order.orderNumber)}" aria-label="Markera fraktdokument för order ${escapeHtml(order.orderNumber)}" ${selectable ? '' : 'disabled title="Dokument saknas eller är redan utskrivet/simulerat"'} ${selectable && selectedFreightOrders.has(String(order.orderNumber)) ? 'checked' : ''}></td>` : ''}<td rowspan="${bookingRows.length}"><strong>${escapeHtml(order.orderNumber)}</strong></td><td rowspan="${bookingRows.length}">${escapeHtml(context.customerName || context.deliveryName || '–')}</td><td rowspan="${bookingRows.length}">${escapeHtml(context.dispatchTime || '–')} · ${escapeHtml(context.deliveryMethodName || context.routeGroup || '–')}</td>`}<td><span class="freight-booking-kind">${escapeHtml(booking.kind)}</span> <strong>${escapeHtml(booking.number)}</strong></td>${index ? '' : `<td rowspan="${bookingRows.length}"><span class="order-status ${virtualStatus ? 'simulated' : documentReady ? 'ready' : panel.documentTracking ? 'missing' : ''}">${escapeHtml(status)}</span>${documentType ? `<small class="freight-type">${documentType === 'pallet' ? 'Fraktdokument/etikett' : 'Fraktsedel'}</small>` : ''}</td>`}</tr>`);
  }).join('');
  const name = freightNames[activeFreightPanel];
  const bookingCount = panel.orders.reduce((sum, item) => sum + (item.bookings?.length || 0), 0);
  const overview = panel.documentTracking
    ? `${panel.ready} av ${panel.total} order har fraktdokument. ${panel.waiting} väntar på dokument. ${bookingCount} bokningsrader.`
    : `${panel.departureCount} avgångar, ${panel.total} order. Inga dokument skrivs ut från denna grupp ännu.`;
  const reviewRows = (freightPlan?.orders || []).map((order) => {
    const bookingText = order.bookings?.length
      ? order.bookings.map((booking) => `${escapeHtml(booking.kind)}: ${escapeHtml(booking.number)}`).join(' · ')
      : 'Bokningsnummer saknas';
    return `<li><strong>${escapeHtml(order.orderNumber)} · ${escapeHtml(order.customerName || '–')}</strong><span>${escapeHtml(order.dispatchTime || '–')} · ${escapeHtml(order.deliveryMethodName || order.deliveryMethod || '–')}</span><small>${bookingText}</small><small>${order.document.type === 'pallet' ? 'Fraktdokument/etikett' : 'Fraktsedel'}: ${escapeHtml(statusLabel(order.document.printStatus))}</small></li>`;
  }).join('');
  const sectionNames = { 'frozen-freight': 'Fryst fraktsedel', 'cooling-freight': 'Kyld fraktsedel', freight: 'Fraktsedel' };
  const reviewSections = (freightPlan?.sections || []).map((section) => {
    const label = section.sectionType.startsWith('pallet-label-') ? 'Etikett' : sectionNames[section.sectionType] || 'Fraktdokument';
    const pages = section.documents.map((document) => document.pages ? `sida ${escapeHtml(document.pages)}` : 'hela dokumentet').join(' · ');
    const copies = section.documents.some((document) => document.pageCopies > 1)
      ? ` · ${section.documents.map((document) => `${document.pageCopies} exemplar`).join(' · ')}` : '';
    return `<li><strong>Order ${escapeHtml(section.orderNumber)} · ${label}</strong><small>${pages}${copies}</small></li>`;
  }).join('');
  const selection = panel.documentTracking
    ? `<div class="dispatch-selection freight-selection"><label><input id="selectAllFreightReady" type="checkbox" ${selectableVisible.length ? '' : 'disabled'} ${selectableVisible.length > 0 && selectableVisible.every(({ order }) => selectedFreightOrders.has(String(order.orderNumber))) ? 'checked' : ''}> Markera alla med dokument i listan</label><span>${selectedItems.length} valda av ${panel.ready} med dokument</span><button id="reviewFreightSelection" type="button" ${selectedItems.length ? '' : 'disabled'}>Granska fraktdokument</button><button class="print-selected" type="button" ${simulationEnabled && selectedItems.length ? '' : 'disabled'} title="${simulationEnabled ? 'Endast virtuell utskrift' : 'Utskrift är spärrad i läsläget'}">${simulationEnabled ? 'Simulera valda' : 'Skriv ut valda'}</button></div>`
    : '';
  const review = panel.documentTracking && freightReviewOpen && selectedItems.length
    ? `<section class="dispatch-review freight-review" aria-label="Granskning av fraktdokument"><h2>Valda fraktdokument · ${selectedItems.length} order</h2><p>Servern kontrollerar grupp, PDF-sidor och ordning mot aktuell data. Kylt och fryst visas som egna bokningsrader men väljs per order. Inga följesedlar ingår och ingen utskrift startas.</p>${freightReviewPending ? '<p>Kontrollerar PDF-sidor…</p>' : freightPlanError ? `<p class="freight-plan-error">${escapeHtml(freightPlanError)}</p>` : `<ol>${reviewRows}</ol><h3>Verifierad sidordning</h3><ol>${reviewSections}</ol>`}</section>`
    : '';
  ordersView.innerHTML = `<header><div><h1>${name}</h1><p>${overview} Klicka på en order för detaljer.</p></div>${lookupSortControl()}</header>${selection}${rows ? `<table class="orders-table"><thead><tr>${panel.documentTracking ? '<th>Välj</th>' : ''}<th>Order</th><th>Kund</th><th>Avgång / körsätt</th><th>Bokningsnummer</th><th>Fraktdokument</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga order i denna grupp för valt datum och sökning.</div>'}${review}`;
  if (panel.documentTracking) {
    ordersView.querySelector('.print-selected').addEventListener('click', () => {
      const items = selectedItems.flatMap(({ order, documentType }) => pendingOrderDocuments(order, [documentType]));
      openVerifiedFreightSimulation(`${name} · valda fraktdokument`, items, activeFreightPanel);
    });
    ordersView.querySelector('#selectAllFreightReady').addEventListener('change', (event) => {
      for (const { order } of selectableVisible) {
        if (event.currentTarget.checked) selectedFreightOrders.add(String(order.orderNumber));
        else selectedFreightOrders.delete(String(order.orderNumber));
      }
      clearFreightReview();
      renderFreightList();
    });
    ordersView.querySelector('#reviewFreightSelection').addEventListener('click', async () => {
      const request = ++freightPlanRequest;
      const panelId = activeFreightPanel;
      const date = deliveryDate.value;
      freightReviewOpen = true;
      freightReviewPending = true;
      freightPlan = null;
      freightPlanError = '';
      renderFreightList();
      try {
        const response = await fetch('/api/dashboard/freight-packet-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deliveryDate: date, panelId, orderNumbers: selectedItems.map(({ order }) => String(order.orderNumber)) })
        });
        const payload = await response.json();
        if (request !== freightPlanRequest || activeFreightPanel !== panelId || deliveryDate.value !== date) return;
        if (!response.ok || !payload.valid) freightPlanError = (payload.errors || [payload.error || 'Kunde inte granska fraktdokument.']).join(' ');
        else freightPlan = payload;
      } catch (error) {
        if (request !== freightPlanRequest) return;
        freightPlanError = error.message;
      }
      if (request === freightPlanRequest) {
        freightReviewPending = false;
        renderFreightList();
      }
    });
    ordersView.querySelectorAll('[data-select-freight-order]').forEach((checkbox) => {
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', (event) => {
        const number = event.currentTarget.dataset.selectFreightOrder;
        if (event.currentTarget.checked) selectedFreightOrders.add(number);
        else selectedFreightOrders.delete(number);
        clearFreightReview();
        renderFreightList();
      });
    });
  }
  ordersView.querySelectorAll('[data-order]').forEach((row) => row.addEventListener('click', () => {
    const item = panel.orders.find(({ order }) => String(order.orderNumber) === row.dataset.order);
    if (item) openOrderDetails(item.order);
  }));
}

async function loadFreightDashboard(refresh = false) {
  const request = ++freightRequest;
  freightPayload = null;
  selectedFreightOrders.clear();
  clearFreightReview();
  const params = new URLSearchParams({ deliveryDate: deliveryDate.value });
  if (refresh) params.set('refresh', '1');
  dashboardSource.textContent = 'Hämtar följesedlar, fraktsedlar, returer, hämtningar och kedjor. Övriga kunder väntar på DocSmt-regeln.';
  if (activeView === 'freight') ordersView.innerHTML = '<div class="orders-empty">Hämtar fraktsedlar…</div>';
  try {
    const response = await fetch(`/api/dashboard/freight?${params}`);
    if (!response.ok) throw new Error('Kunde inte hämta fraktsedlar.');
    const payload = await response.json();
    if (request !== freightRequest) return;
    freightPayload = payload;
    renderFreightCards(payload);
    if (activeView === 'freight') renderFreightList();
  } catch (error) {
    if (request !== freightRequest) return;
    freightPayload = null;
    renderFreightCards({ deliveryDate: deliveryDate.value, contextStatus: { available: false } });
    dashboardSource.textContent = error.message;
    if (activeView === 'freight') ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`;
  }
}

const dispatchNames = { early: 'Tidig', morning: 'Förmiddag', afternoon: 'Eftermiddag' };

function renderDispatchCards(payload) {
  const available = payload.contextStatus?.available !== false;
  document.querySelectorAll('[data-dispatch-slot]').forEach((card) => {
    const slot = payload.slots?.[card.dataset.dispatchSlot];
    card.querySelector('b em').textContent = available ? slot?.ready ?? 0 : '–';
    card.querySelector('.dispatch-total').textContent = available ? slot?.total ?? 0 : '–';
    const candidates = available ? (slot?.orders || []).filter((item) => item.ready)
      .flatMap(({ order }) => packetCandidates(order)) : [];
    const simulatedCount = (slot?.orders || []).filter(({ order }) => simulated(order.orderNumber, 'packingSlip')
      || simulated(order.orderNumber, 'attachment')).length;
    setVirtualCount(card, simulatedCount);
    setVirtualQuick(card, `${dispatchNames[card.dataset.dispatchSlot]} · klara följesedlar`, candidates,
      'Varje order har följesedel följd av partibilaga; ordningen kommer från leveransprioritet och körsätt.');
  });
  const caution = document.querySelector('#dispatchCaution');
  const notes = [];
  if (!available) notes.push('Orderkälla saknas – egna bilars avgångar kan inte visas.');
  else {
    if (payload.unassignedCount) notes.push(`${payload.unassignedCount} egna bil-order utan giltig avgångstid finns i Alla order.`);
    if (payload.registrationTextMatches) notes.push(`${payload.registrationTextMatches} order matchades preliminärt via registreringsnumrets text.`);
  }
  caution.textContent = notes.join(' ');
  caution.hidden = notes.length === 0;
}

function renderDispatchList() {
  if (dispatchPayload?.contextStatus?.available === false) {
    ordersView.innerHTML = '<div class="orders-empty">Orderkällan är inte tillgänglig. Följesedelsavgångarna kan inte visas.</div>';
    return;
  }
  const slot = dispatchPayload?.slots?.[activeDispatchSlot];
  if (!slot) {
    ordersView.innerHTML = '<div class="orders-empty">Hämtar följesedlar…</div>';
    return;
  }
  const query = search.value.trim().toLowerCase();
  const visibleItems = sortLookupItems(slot.orders.filter(({ order }) => {
    if (!query) return true;
    const context = order.context || {};
    return [order.orderNumber, context.customerNo, context.customerName, context.deliveryName,
      context.deliveryMethodName, context.dispatchTime].filter(Boolean).join(' ').toLowerCase().includes(query);
  }), lookupSort);
  const readyVisible = visibleItems.filter(({ order, ready }) => ready && packetCandidates(order).length);
  const selectedItems = slot.orders.filter(({ order, ready }) => ready && packetCandidates(order).length
    && selectedDispatchOrders.has(String(order.orderNumber)));
  const rows = visibleItems.map(({ order, ready, matchSource }) => {
    const context = order.context || {};
    const missing = [!order.documents?.packingSlip && 'Följesedel', !order.documents?.attachment && 'Partibilaga'].filter(Boolean);
    const packingBlocked = order.packingBlocked || context.packingBlocked;
    const virtualStatus = virtualPrintLabel(order.orderNumber, ['packingSlip', 'attachment']);
    const selectable = ready && packetCandidates(order).length > 0;
    const state = virtualStatus || (ready ? 'Klar för utskrift' : packingBlocked ? 'Pågående plock' : `Saknar ${missing.join(' och ') || 'dokument'}`);
    return `<tr data-order="${escapeHtml(order.orderNumber)}"><td><input class="dispatch-select" type="checkbox" data-select-order="${escapeHtml(order.orderNumber)}" aria-label="Markera order ${escapeHtml(order.orderNumber)}" ${selectable ? '' : 'disabled title="Ordern är inte klar eller redan simulerad"'} ${selectable && selectedDispatchOrders.has(String(order.orderNumber)) ? 'checked' : ''}></td><td><strong>${escapeHtml(order.orderNumber)}</strong></td><td>${escapeHtml(context.customerName || context.deliveryName || '–')}</td><td>${escapeHtml(context.dispatchTime || '–')}</td><td>${escapeHtml(context.deliveryMethodName || context.deliveryMethod || '–')}${matchSource === 'registration-text' ? '<small class="freight-type">Regnr identifierat via text</small>' : ''}</td><td><span class="order-status ${virtualStatus ? 'simulated' : ready ? 'ready' : packingBlocked ? '' : 'missing'}">${escapeHtml(state)}</span></td></tr>`;
  }).join('');
  const reviewRows = selectedItems.map(({ order, matchSource }) => {
    const context = order.context || {};
    return `<li><strong>${escapeHtml(order.orderNumber)} · ${escapeHtml(context.customerName || context.deliveryName || '–')}</strong><span>${escapeHtml(context.dispatchTime || '–')} · ${escapeHtml(context.deliveryMethodName || context.deliveryMethod || '–')}</span><small>Följesedel: ${escapeHtml(statusLabel(order.documents?.packingSlip?.printStatus))} · Partibilaga: ${escapeHtml(statusLabel(order.documents?.attachment?.printStatus))}${matchSource === 'registration-text' ? ' · Regnr matchat preliminärt' : ''}</small></li>`;
  }).join('');
  const review = dispatchReviewOpen && selectedItems.length
    ? `<section class="dispatch-review" aria-label="Granskning av vald bunt"><h2>Vald bunt · ${selectedItems.length} order</h2><p>Sorterad efter orderns DelPri och körsätt. Varje order består av följesedel + partibilaga. Detta är endast en granskning; ingen utskrift startas.</p><ol>${reviewRows}</ol></section>`
    : '';
  ordersView.innerHTML = `<header><div><h1>${dispatchNames[activeDispatchSlot]}</h1><p>${slot.ready} av ${slot.total} order har följesedel och partibilaga och är färdigplockade. Utskriftsbunten behåller ordningen efter orderns DelPri och körsätt; sorteringsvalet ändrar bara listan. Ingen riktig utskrift från denna vy.</p></div>${lookupSortControl()}</header><div class="dispatch-selection"><label><input id="selectAllDispatchReady" type="checkbox" ${readyVisible.length ? '' : 'disabled'} ${readyVisible.length > 0 && readyVisible.every(({ order }) => selectedDispatchOrders.has(String(order.orderNumber))) ? 'checked' : ''}> Markera alla klara i listan</label><span>${selectedItems.length} valda av ${slot.ready} klara</span><button id="reviewDispatchSelection" type="button" ${selectedItems.length ? '' : 'disabled'}>Granska vald bunt</button><button class="print-selected" type="button" ${simulationEnabled && selectedItems.length ? '' : 'disabled'} title="${simulationEnabled ? 'Endast virtuell utskrift' : 'Utskrift är spärrad i läsläget'}">${simulationEnabled ? 'Simulera valda' : 'Skriv ut valda'}</button></div>${rows ? `<table class="orders-table"><thead><tr><th>Välj</th><th>Order</th><th>Kund</th><th>Leveransprioritet</th><th>Körsätt</th><th>Följesedlar</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga order i denna avgång för valt datum och sökning.</div>'}${review}`;
  ordersView.querySelector('.print-selected').addEventListener('click', () => {
    openVirtualPrint(`${dispatchNames[activeDispatchSlot]} · valda följesedlar`,
      selectedItems.flatMap(({ order }) => packetCandidates(order)),
      'Följesedel och partibilaga visas tillsammans per order i leveransordning.');
  });
  ordersView.querySelector('#selectAllDispatchReady').addEventListener('change', (event) => {
    for (const { order } of readyVisible) {
      if (event.currentTarget.checked) selectedDispatchOrders.add(String(order.orderNumber));
      else selectedDispatchOrders.delete(String(order.orderNumber));
    }
    dispatchReviewOpen = false;
    renderDispatchList();
  });
  ordersView.querySelector('#reviewDispatchSelection').addEventListener('click', () => {
    dispatchReviewOpen = true;
    renderDispatchList();
  });
  ordersView.querySelectorAll('[data-select-order]').forEach((checkbox) => {
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => {
      const number = event.currentTarget.dataset.selectOrder;
      if (event.currentTarget.checked) selectedDispatchOrders.add(number);
      else selectedDispatchOrders.delete(number);
      dispatchReviewOpen = false;
      renderDispatchList();
    });
  });
  ordersView.querySelectorAll('[data-order]').forEach((row) => row.addEventListener('click', () => {
    const item = slot.orders.find(({ order }) => String(order.orderNumber) === row.dataset.order);
    if (item) openOrderDetails(item.order);
  }));
}

async function loadDispatchDashboard(refresh = false) {
  const request = ++dispatchRequest;
  dispatchPayload = null;
  selectedDispatchOrders.clear();
  dispatchReviewOpen = false;
  const params = new URLSearchParams({ deliveryDate: deliveryDate.value });
  if (refresh) params.set('refresh', '1');
  document.querySelectorAll('[data-dispatch-slot]').forEach((card) => {
    card.querySelector('b em').textContent = '–';
    card.querySelector('.dispatch-total').textContent = '–';
  });
  document.querySelector('#dispatchCaution').hidden = true;
  if (activeView === 'dispatch') ordersView.innerHTML = '<div class="orders-empty">Hämtar följesedlar…</div>';
  try {
    const response = await fetch(`/api/dashboard/dispatch?${params}`);
    if (!response.ok) throw new Error('Kunde inte hämta följesedelsavgångar.');
    const payload = await response.json();
    if (request !== dispatchRequest) return;
    dispatchPayload = payload;
    renderDispatchCards(payload);
    if (activeView === 'dispatch') renderDispatchList();
  } catch (error) {
    if (request !== dispatchRequest) return;
    renderDispatchCards({ contextStatus: { available: false } });
    if (activeView === 'dispatch') ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`;
  }
}

const chainNames = { 'sushi-yama': 'Sushi Yama', chopchop: 'ChopChop' };
const chainTransportNames = { own: 'Egna bilar', remote: 'Fjärrgods', unclassified: 'Körsätt att kontrollera' };

function renderChainCards(payload) {
  const available = payload.contextStatus?.available !== false;
  document.querySelectorAll('[data-chain-panel]').forEach((card) => {
    const panel = payload.panels?.[card.dataset.chainPanel];
    const printed = card.querySelector('.chain-count em');
    const count = card.querySelector('.chain-count span');
    const badge = card.querySelector('strong i');
    const unknown = card.querySelector('.chain-unknown');
    printed.textContent = available ? panel?.printed ?? 0 : '–';
    count.textContent = available ? panel?.total ?? 0 : '–';
    badge.textContent = available ? panel?.waiting ?? 0 : '';
    badge.hidden = !available || !panel?.waiting;
    const ownTotal = panel?.own.total ?? 0;
    const remoteTotal = panel?.remote.total ?? 0;
    const remoteRemaining = remoteTotal - (panel?.remote.printed ?? 0);
    card.querySelector('.chain-own').textContent = available
      ? ownTotal ? `Egna bilar — ${panel.own.printed}/${ownTotal} utskrivna` : 'Egna bilar — inga order'
      : 'Egna bilar — status saknas';
    card.querySelector('.chain-remote').textContent = available
      ? remoteTotal ? `Fjärrgods — ${remoteRemaining} kvar att skriva ut` : 'Fjärrgods — inga order'
      : 'Fjärrgods — status saknas';
    card.querySelector('.done').classList.toggle('inactive', !available || ownTotal === 0);
    card.querySelector('.alert').classList.toggle('inactive', !available || remoteRemaining === 0);
    unknown.hidden = !available || !panel?.unclassified.total;
    unknown.textContent = panel?.unclassified.total
      ? `${panel.unclassified.total} order med körsätt att kontrollera`
      : '';
    const candidates = available ? (panel?.orders || []).filter((item) => item.ready && !item.printed)
      .flatMap(({ order }) => packetCandidates(order)) : [];
    const simulatedCount = (panel?.orders || []).filter(({ order }) => simulated(order.orderNumber, 'packingSlip')
      || simulated(order.orderNumber, 'attachment')).length;
    setVirtualCount(card, simulatedCount);
    setVirtualQuick(card, `${chainNames[card.dataset.chainPanel]} · klara följesedlar`, candidates,
      'Egna bilars order kan också simuleras via Tidig/FM/EM; samma dokument markeras då här automatiskt.');
  });
}

function renderChainList() {
  if (chainPayload?.contextStatus?.available === false) {
    ordersView.innerHTML = '<div class="orders-empty">Orderkällan är inte tillgänglig. Kedjeorder kan inte visas.</div>';
    return;
  }
  const panel = chainPayload?.panels?.[activeChainPanel];
  if (!panel) {
    ordersView.innerHTML = '<div class="orders-empty">Hämtar kedjeorder…</div>';
    return;
  }
  const query = search.value.trim().toLowerCase();
  const visibleItems = sortLookupItems(panel.orders.filter(({ order }) => {
    if (!query) return true;
    const context = order.context || {};
    return [order.orderNumber, context.customerNo, context.customerName, context.deliveryName,
      context.deliveryMethodName, context.dispatchTime].filter(Boolean).join(' ').toLowerCase().includes(query);
  }), lookupSort);
  const selectableVisible = visibleItems.filter(({ order, ready, printed }) => ready && !printed && packetCandidates(order).length);
  const selectedItems = panel.orders.filter(({ order, ready, printed }) => ready && !printed
    && packetCandidates(order).length && selectedChainOrders.has(String(order.orderNumber)));
  const rows = visibleItems.map(({ order, printed, ready, transport }) => {
    const context = order.context || {};
    const missing = [!order.documents?.packingSlip && 'följesedel', !order.documents?.attachment && 'partibilaga'].filter(Boolean);
    const updated = [order.documents?.packingSlip, order.documents?.attachment]
      .some((document) => document?.printStatus === 'reprint');
    const virtualStatus = virtualPrintLabel(order.orderNumber, ['packingSlip', 'attachment']);
    const state = virtualStatus || (printed ? 'Utskriven' : order.packingBlocked || context.packingBlocked
      ? 'Pågående plock'
      : missing.length ? `Saknar ${missing.join(' och ')}`
        : updated ? 'Uppdaterad – återutskrift behövs'
          : ready ? 'Behöver utskrift' : 'Inte klar');
    const selectable = ready && !printed && packetCandidates(order).length > 0;
    return `<tr data-order="${escapeHtml(order.orderNumber)}"><td><input class="dispatch-select" type="checkbox" data-select-chain-order="${escapeHtml(order.orderNumber)}" aria-label="Markera order ${escapeHtml(order.orderNumber)}" ${selectable ? '' : 'disabled'} ${selectable && selectedChainOrders.has(String(order.orderNumber)) ? 'checked' : ''}></td><td><strong>${escapeHtml(order.orderNumber)}</strong></td><td>${escapeHtml(context.customerName || context.deliveryName || '–')}</td><td>${escapeHtml(context.dispatchTime || '–')} · ${escapeHtml(context.deliveryMethodName || '–')}</td><td>${escapeHtml(chainTransportNames[transport])}</td><td><span class="order-status ${virtualStatus ? 'simulated' : printed ? 'ready' : 'missing'}">${escapeHtml(state)}</span></td></tr>`;
  }).join('');
  const selection = `<div class="dispatch-selection"><label><input id="selectAllChainReady" type="checkbox" ${selectableVisible.length ? '' : 'disabled'} ${selectableVisible.length > 0 && selectableVisible.every(({ order }) => selectedChainOrders.has(String(order.orderNumber))) ? 'checked' : ''}> Markera klara som behöver utskrift</label><span>${selectedItems.length} valda</span><button id="reviewChainSelection" type="button" ${selectedItems.length ? '' : 'disabled'}>Granska valda</button><button class="print-selected" type="button" ${simulationEnabled && selectedItems.length ? '' : 'disabled'} title="${simulationEnabled ? 'Endast virtuell utskrift' : 'Utskrift är spärrad i läsläget'}">${simulationEnabled ? 'Simulera valda' : 'Skriv ut valda'}</button></div>`;
  const review = chainReviewOpen && selectedItems.length
    ? `<section class="dispatch-review"><h2>Valda följesedlar · ${selectedItems.length} order</h2><p>Klicka på en orderrad för att granska följesedel och partibilaga som PDF. Ingen utskrift startas.</p><ol>${selectedItems.map(({ order }) => `<li><strong>Order ${escapeHtml(order.orderNumber)} · ${escapeHtml(order.context?.customerName || '–')}</strong><small>Följesedel: ${escapeHtml(statusLabel(order.documents?.packingSlip?.printStatus))} · Partibilaga: ${escapeHtml(statusLabel(order.documents?.attachment?.printStatus))}</small></li>`).join('')}</ol></section>`
    : '';
  ordersView.innerHTML = `<header><div><h1>${chainNames[activeChainPanel]}</h1><p>${panel.printed} av ${panel.total} order har både följesedel och partibilaga utskrivna. Röda siffran visar order som återstår. Okända körsätt markeras separat.</p></div>${lookupSortControl()}</header>${selection}${rows ? `<table class="orders-table"><thead><tr><th>Välj</th><th>Order</th><th>Kund</th><th>Avgång / körsätt</th><th>Transport</th><th>Dokumentstatus</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga kedjeorder för valt datum och sökning.</div>'}${review}`;
  ordersView.querySelector('.print-selected').addEventListener('click', () => {
    openVirtualPrint(`${chainNames[activeChainPanel]} · valda följesedlar`,
      selectedItems.flatMap(({ order }) => packetCandidates(order)),
      'Följesedel och partibilaga visas tillsammans per order.');
  });
  ordersView.querySelector('#selectAllChainReady').addEventListener('change', (event) => {
    for (const { order } of selectableVisible) {
      if (event.currentTarget.checked) selectedChainOrders.add(String(order.orderNumber));
      else selectedChainOrders.delete(String(order.orderNumber));
    }
    chainReviewOpen = false;
    renderChainList();
  });
  ordersView.querySelector('#reviewChainSelection').addEventListener('click', () => {
    chainReviewOpen = true;
    renderChainList();
  });
  ordersView.querySelectorAll('[data-select-chain-order]').forEach((checkbox) => {
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => {
      const number = event.currentTarget.dataset.selectChainOrder;
      if (event.currentTarget.checked) selectedChainOrders.add(number);
      else selectedChainOrders.delete(number);
      chainReviewOpen = false;
      renderChainList();
    });
  });
  ordersView.querySelectorAll('[data-order]').forEach((row) => row.addEventListener('click', () => {
    const item = panel.orders.find(({ order }) => String(order.orderNumber) === row.dataset.order);
    if (item) openOrderDetails(item.order);
  }));
}

async function loadChainDashboard(refresh = false) {
  const request = ++chainRequest;
  chainPayload = null;
  selectedChainOrders.clear();
  chainReviewOpen = false;
  const params = new URLSearchParams({ deliveryDate: deliveryDate.value });
  if (refresh) params.set('refresh', '1');
  if (activeView === 'chains') ordersView.innerHTML = '<div class="orders-empty">Hämtar kedjeorder…</div>';
  try {
    const response = await fetch(`/api/dashboard/chains?${params}`);
    if (!response.ok) throw new Error('Kunde inte hämta kedjeorder.');
    const payload = await response.json();
    if (request !== chainRequest) return;
    chainPayload = payload;
    renderChainCards(payload);
    if (activeView === 'chains') renderChainList();
  } catch (error) {
    if (request !== chainRequest) return;
    chainPayload = null;
    renderChainCards({ contextStatus: { available: false } });
    if (activeView === 'chains') ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`;
  }
}

function simulationSelectionForOrder(order) {
  const number = String(order.orderNumber);
  for (const [panelId, panel] of Object.entries(freightPayload?.panels || {})) {
    const item = panel.orders?.find((entry) => String(entry.order.orderNumber) === number);
    if (item && panel.documentTracking) return {
      label: `${freightNames[panelId]} · order ${number}`,
      panelId,
      items: pendingOrderDocuments(item.order, [item.documentType].filter(Boolean))
    };
  }
  for (const slot of Object.values(dispatchPayload?.slots || {})) {
    const item = slot.orders?.find((entry) => String(entry.order.orderNumber) === number);
    if (item) return { label: `Följesedlar · order ${number}`, items: item.ready ? packetCandidates(item.order) : [] };
  }
  for (const panel of Object.values(chainPayload?.panels || {})) {
    const item = panel.orders?.find((entry) => String(entry.order.orderNumber) === number);
    if (item) return { label: `Kedjeföljesedlar · order ${number}`, items: item.ready && !item.printed ? packetCandidates(item.order) : [] };
  }
  return { label: `Order ${number}`, items: [] };
}

function openOrderDetails(order) {
  const context = order.context || {};
  const documents = Object.values(order.documents || {});
  const simulationSelection = simulationSelectionForOrder(order);
  const bookingRows = [
    context.freightConsignmentFresh ? `<dt>Bokning kylt</dt><dd>${escapeHtml(context.freightConsignmentFresh)}</dd>` : '',
    context.freightConsignmentFrozen ? `<dt>Bokning fryst</dt><dd>${escapeHtml(context.freightConsignmentFrozen)}</dd>` : ''
  ].join('') || (context.freightConsignmentNumbers?.length ? `<dt>Bokningsnummer</dt><dd>${escapeHtml(context.freightConsignmentNumbers.join(', '))}</dd>` : '');
  const documentRows = documents.length ? documents.map((document) => `<li><span>${escapeHtml(documentNames[document.type] || document.typeLabel || document.type || 'Dokument')} · ${documentPreviewLink(document)}</span><span class="document-status ${simulated(order.orderNumber, document.type) ? 'simulated' : escapeHtml(document.printStatus || '')}">${escapeHtml(simulated(order.orderNumber, document.type) ? 'Simulerat utskriven' : statusLabel(document.printStatus))}</span></li>`).join('') : '<li><span>Inga dokument hittades</span></li>';
  title.textContent = `Order ${order.orderNumber}`;
  detail.innerHTML = `<dl><dt>Kund</dt><dd>${escapeHtml(context.customerName || 'Okänd kund')}</dd><dt>Leverans</dt><dd>${escapeHtml(context.deliveryDate || '–')} · ${escapeHtml(context.dispatchTime || '–')}</dd><dt>Körsätt</dt><dd>${escapeHtml(context.deliveryMethodName || '–')}</dd><dt>Orderstatus</dt><dd>${escapeHtml(statusLabel(order.packetStatus))}</dd>${bookingRows}</dl><div><strong>Dokument</strong><ul class="order-documents">${documentRows}</ul></div><button class="quick-print" type="button" ${simulationEnabled && simulationSelection.items.length ? '' : 'disabled'}>${simulationEnabled ? 'Simulera utskrift' : 'Skriv ut order'}</button>`;
  detail.querySelector('.quick-print').addEventListener('click', () => {
    dialog.close();
    if (simulationSelection.panelId) openVerifiedFreightSimulation(simulationSelection.label, simulationSelection.items, simulationSelection.panelId);
    else openVirtualPrint(simulationSelection.label, simulationSelection.items);
  });
  dialog.showModal();
}

function renderOrders(payload, view) {
  const names = { alla: 'Alla order', plock: 'Pågående plock', uppdaterade: 'Uppdaterade', saknade: 'Saknade' };
  const orders = payload.orders || [];
  total.textContent = payload.summary?.totalOrders ?? 0;
  packing.textContent = payload.summary?.blockedOrders ?? 0;
  updateUpdatedBadge(payload.summary?.reprintOrders ?? 0);
  const rows = orders.map((order) => { const c = order.context || {}; return `<tr data-order="${escapeHtml(order.orderNumber)}"><td><strong>${escapeHtml(order.orderNumber)}</strong></td><td>${escapeHtml(c.customerName || '–')}</td><td>${escapeHtml(c.dispatchTime || '–')}</td><td><span class="order-status ${escapeHtml(order.packetStatus)}">${escapeHtml(statusLabel(order.packetStatus))}</span></td></tr>`; }).join('');
  ordersView.innerHTML = `<header><div><h1>${names[view]}</h1><p>${orders.length} order för valt leveransdatum. Klicka på en rad för detaljer.</p></div><span class="read-only">Endast läsning</span></header>${rows ? `<table class="orders-table"><thead><tr><th>Order</th><th>Kund</th><th>Avgång</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga order hittades för valt datum och filter.</div>'}`;
  ordersView.querySelectorAll('[data-order]').forEach((row) => row.addEventListener('click', () => openOrderDetails(orders.find((item) => String(item.orderNumber) === row.dataset.order))));
}

async function loadOrders(view, refresh = false) {
  const params = new URLSearchParams({ status: statuses[view], deliveryDate: deliveryDate.value, q: search.value.trim() }); if (refresh) params.set('refresh', '1'); ordersView.innerHTML = '<div class="orders-empty">Hämtar order…</div>';
  try { const response = await fetch(`/api/orders?${params}`); if (!response.ok) throw new Error('Kunde inte hämta order.'); renderOrders(await response.json(), view); } catch (error) { ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`; }
}

const returnDepartureLabels = { early: 'Tidig', morning: 'Förmiddag', afternoon: 'Eftermiddag', unscheduled: 'Utan avgångstid' };

function openReturnDetails(context) {
  title.textContent = `Returorder ${context.orderNumber}`;
  detail.innerHTML = `<dl><dt>Kund</dt><dd>${escapeHtml(context.customerName || context.deliveryName || '–')}</dd><dt>Leveransdatum</dt><dd>${escapeHtml(context.deliveryDate || '–')}</dd><dt>Avgång</dt><dd>${escapeHtml(returnDepartureLabels[context.returnDeparture] || 'Utan avgångstid')} · ${escapeHtml(context.dispatchTime || '–')}</dd><dt>Returregel</dt><dd>Gr3 30 · Retur hämtas</dd></dl><p>Returdokument och utskriftsmall är ännu inte verifierade.</p><button class="quick-print" type="button" disabled title="Returdokument och utskriftsregel är inte verifierade">Skriv ut retur</button>`;
  dialog.showModal();
}

function renderReturnCard(payload) {
  const available = payload.contextStatus?.available !== false;
  const card = document.querySelector('[data-returns]');
  const count = available ? payload.summary?.totalReturns ?? 0 : null;
  card.querySelector('[data-return-total]').textContent = count ?? '–';
  const badge = card.querySelector('strong i');
  badge.textContent = count ?? '';
  badge.hidden = !count;
  const byDeparture = payload.summary?.byDeparture || {};
  const rows = Object.entries(returnDepartureLabels)
    .filter(([key]) => available && byDeparture[key] > 0)
    .map(([key, label]) => `<p><b>${label}</b><span>${byDeparture[key]} retur${byDeparture[key] === 1 ? '' : 'er'}</span></p>`)
    .join('');
  card.querySelector('.return-breakdown').innerHTML = available
    ? rows || '<p>Inga bokade returer för valt datum.</p>'
    : '<p>Returdata är inte tillgänglig.</p>';
}

function renderReturnList(payload) {
  if (payload.contextStatus?.available === false) {
    ordersView.innerHTML = '<div class="orders-empty">Returdata är inte tillgänglig.</div>';
    return;
  }
  const query = search.value.trim().toLowerCase();
  const returns = (payload.returns || []).filter((context) => !query || [context.orderNumber,
    context.customerNo, context.customerName, context.deliveryName, context.dispatchTime]
    .filter(Boolean).join(' ').toLowerCase().includes(query));
  const selected = returns.filter((context) => selectedReturnOrders.has(String(context.orderNumber)));
  const rows = returns.map((context) => `<tr data-return-order="${escapeHtml(context.orderNumber)}"><td><input class="dispatch-select" type="checkbox" data-select-return-order="${escapeHtml(context.orderNumber)}" aria-label="Markera retur ${escapeHtml(context.orderNumber)}" ${selectedReturnOrders.has(String(context.orderNumber)) ? 'checked' : ''}></td><td><strong>${escapeHtml(context.orderNumber)}</strong></td><td>${escapeHtml(context.customerName || context.deliveryName || '–')}</td><td>${escapeHtml(returnDepartureLabels[context.returnDeparture] || 'Utan avgångstid')} · ${escapeHtml(context.dispatchTime || '–')}</td><td><span class="order-status missing">Retur att hämta</span></td></tr>`).join('');
  const selection = `<div class="dispatch-selection"><label><input id="selectAllReturns" type="checkbox" ${returns.length ? '' : 'disabled'} ${returns.length && returns.every((context) => selectedReturnOrders.has(String(context.orderNumber))) ? 'checked' : ''}> Markera alla i listan</label><span>${selected.length} valda</span><button id="reviewReturnSelection" type="button" ${selected.length ? '' : 'disabled'}>Granska valda</button><button class="print-selected" type="button" disabled title="Returdokument och utskriftsregel är inte verifierade">Skriv ut valda</button></div>`;
  const review = returnReviewOpen && selected.length
    ? `<section class="dispatch-review"><h2>Valda returer · ${selected.length}</h2><p>Avgången kommer från orderns DelPri; utskriftsmallen är inte verifierad.</p><ol>${selected.map((context) => `<li><strong>Order ${escapeHtml(context.orderNumber)} · ${escapeHtml(context.customerName || context.deliveryName || '–')}</strong><small>${escapeHtml(returnDepartureLabels[context.returnDeparture] || 'Utan avgångstid')} · ${escapeHtml(context.dispatchTime || '–')}</small></li>`).join('')}</ol></section>`
    : '';
  ordersView.innerHTML = `<header><div><h1>Returer</h1><p>${payload.summary?.totalReturns ?? 0} bokade returer att hämta. Gr3 30 visas oavsett körsätt; avgången baseras på orderns DelPri.</p></div><span class="read-only">Endast läsning</span></header>${selection}${rows ? `<table class="orders-table"><thead><tr><th>Välj</th><th>Order</th><th>Kund</th><th>Avgång</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga returer för valt datum och sökning.</div>'}${review}`;
  ordersView.querySelector('#selectAllReturns').addEventListener('change', (event) => {
    for (const context of returns) {
      if (event.currentTarget.checked) selectedReturnOrders.add(String(context.orderNumber));
      else selectedReturnOrders.delete(String(context.orderNumber));
    }
    returnReviewOpen = false;
    renderReturnList(payload);
  });
  ordersView.querySelector('#reviewReturnSelection').addEventListener('click', () => {
    returnReviewOpen = true;
    renderReturnList(payload);
  });
  ordersView.querySelectorAll('[data-select-return-order]').forEach((checkbox) => {
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => {
      const number = event.currentTarget.dataset.selectReturnOrder;
      if (event.currentTarget.checked) selectedReturnOrders.add(number);
      else selectedReturnOrders.delete(number);
      returnReviewOpen = false;
      renderReturnList(payload);
    });
  });
  ordersView.querySelectorAll('[data-return-order]').forEach((row) => row.addEventListener('click', () => {
    const context = (payload.returns || []).find((item) => String(item.orderNumber) === row.dataset.returnOrder);
    if (context) openReturnDetails(context);
  }));
}

async function loadReturnDashboard(refresh = false) {
  const request = ++returnRequest;
  returnPayload = null;
  selectedReturnOrders.clear();
  returnReviewOpen = false;
  const params = new URLSearchParams({ deliveryDate: deliveryDate.value });
  if (refresh) params.set('refresh', '1');
  if (activeView === 'returns') ordersView.innerHTML = '<div class="orders-empty">Hämtar returer…</div>';
  try {
    const response = await fetch(`/api/returns?${params}`);
    if (!response.ok) throw new Error('Kunde inte hämta returer.');
    const payload = await response.json();
    if (request !== returnRequest) return;
    returnPayload = payload;
    renderReturnCard(payload);
    if (activeView === 'returns') renderReturnList(payload);
  } catch (error) {
    if (request !== returnRequest) return;
    returnPayload = null;
    renderReturnCard({ contextStatus: { available: false } });
    if (activeView === 'returns') ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`;
  }
}

const pickupKindLabels = { customer: 'Kundhämtning', courier: 'Budbil', taxi: 'Taxi' };
function pickupCandidate(context) {
  return simulated(context.orderNumber, 'pickup') ? []
    : [{ deliveryDate: deliveryDate.value, orderNumber: String(context.orderNumber), type: 'pickup' }];
}
function simulatePickup(context) {
  openVirtualPrint(`Hämtning/bud/taxi · order ${context.orderNumber}`, pickupCandidate(context),
    context.swishPayment
      ? 'Swishorder ska använda fakturamall, men den mallen är inte verifierad här; endast utskriftssteget simuleras.'
      : 'Dokumentmallen är inte verifierad; endast utskriftssteget simuleras.');
}

function openPickupDetails(context) {
  title.textContent = `Order ${context.orderNumber}`;
  detail.innerHTML = `<dl><dt>Kund</dt><dd>${escapeHtml(context.customerName || context.deliveryName || '–')}</dd><dt>Leveransdatum</dt><dd>${escapeHtml(context.deliveryDate || '–')}</dd><dt>Leveranssätt</dt><dd>${escapeHtml(context.staffOrder ? 'Personalorder · kundhämtning' : pickupKindLabels[context.pickupKind] || '–')} (${escapeHtml(context.deliveryMethod || '–')})</dd><dt>Tid enligt order</dt><dd>${escapeHtml(context.dispatchTime || 'Ej angiven')}</dd><dt>Betalning</dt><dd>${context.swishPayment ? 'Swish betalning vid hämtning' : 'Ingen Swish-markering'}</dd><dt>Teststatus</dt><dd>${simulated(context.orderNumber, 'pickup') ? 'Simulerat utskriven · inte på riktigt' : 'Ej simulerad'}</dd></dl><button class="quick-print" type="button" ${simulationEnabled && pickupCandidate(context).length ? '' : 'disabled'}>${simulationEnabled ? 'Simulera utskrift' : 'Skriv ut order'}</button>`;
  detail.querySelector('.quick-print').addEventListener('click', () => { dialog.close(); simulatePickup(context); });
  dialog.showModal();
}

function renderPickupCard(payload) {
  const available = payload.contextStatus?.available !== false;
  const pickups = available ? payload.pickups || [] : [];
  const ordinaryPickups = pickups.filter((context) => !context.staffOrder);
  const staffCount = available ? payload.summary?.staff ?? pickups.filter((context) => context.staffOrder).length : null;
  document.querySelector('#pickupCount').textContent = available ? payload.summary?.total ?? pickups.length : '–';
  const preview = ordinaryPickups.slice(0, 3).map((context) => {
    const kind = context.pickupKind;
    return `<div class="pickup-item"><button class="pickup-row" data-pickup-order="${escapeHtml(context.orderNumber)}" aria-label="Visa order ${escapeHtml(context.orderNumber)}"><strong>${escapeHtml(context.customerName || context.deliveryName || `Order ${context.orderNumber}`)}</strong><span class="pill ${kind === 'customer' ? 'pickup' : 'courier'}">${escapeHtml(pickupKindLabels[kind] || 'Okänt')}</span>${context.swishPayment ? '<span class="pill swish">Swish betalning</span>' : ''}${simulated(context.orderNumber, 'pickup') ? '<span class="pill virtual-pill">Simulerat</span>' : ''}</button><button class="quick-print" data-sim-pickup="${escapeHtml(context.orderNumber)}" type="button" ${simulationEnabled && pickupCandidate(context).length ? '' : 'disabled'}>${simulationEnabled ? 'Simulera' : 'Skriv ut'}</button></div>`;
  }).join('');
  const list = document.querySelector('.pickup-list');
  list.innerHTML = available
    ? `${preview || '<p class="pickup-empty">Inga övriga hämtningar, bud- eller taxiorder för valt datum.</p>'}<div class="pickup-item"><button class="pickup-row staff-row" id="staffOrders" type="button" aria-label="Visa personalorder"><strong>Personalorder</strong><span class="pill staff">Kundhämtning</span><span class="staff-count">${staffCount} order</span></button><button class="quick-print" id="simulateStaff" type="button" ${simulationEnabled && pickups.some((context) => context.staffOrder && pickupCandidate(context).length) ? '' : 'disabled'}>${simulationEnabled ? 'Simulera' : 'Skriv ut'}</button></div>`
    : '<p class="pickup-empty">Orderdata är inte tillgänglig.</p>';
  list.querySelectorAll('[data-pickup-order]').forEach((row) => row.addEventListener('click', () => {
    const context = pickups.find((item) => String(item.orderNumber) === row.dataset.pickupOrder);
    if (context) openPickupDetails(context);
  }));
  list.querySelector('#staffOrders')?.addEventListener('click', () => {
    setActive('staff');
    renderPickupList(payload, true);
  });
  list.querySelectorAll('[data-sim-pickup]').forEach((button) => button.addEventListener('click', () => {
    const context = pickups.find((item) => String(item.orderNumber) === button.dataset.simPickup);
    if (context) simulatePickup(context);
  }));
  list.querySelector('#simulateStaff')?.addEventListener('click', () => {
    openVirtualPrint('Personalorder · kundhämtning', pickups.filter((context) => context.staffOrder)
      .flatMap(pickupCandidate), 'Dokumentmallen är inte verifierad; endast utskriftssteget simuleras.');
  });
  const more = document.querySelector('.pickup-more');
  more.textContent = `Visa alla ${pickups.length} order`;
  more.hidden = ordinaryPickups.length <= 3;
}

function renderPickupList(payload, onlyStaff = false) {
  if (payload.contextStatus?.available === false) {
    ordersView.innerHTML = '<div class="orders-empty">Orderdata för hämtningar, bud och taxi är inte tillgänglig.</div>';
    return;
  }
  const query = search.value.trim().toLowerCase();
  const pickups = (payload.pickups || []).filter((context) => (!onlyStaff || context.staffOrder) && (!query || [context.orderNumber,
    context.customerNo, context.customerName, context.deliveryName, context.dispatchTime,
    pickupKindLabels[context.pickupKind], context.staffOrder && 'Personalorder']
    .filter(Boolean).join(' ').toLowerCase().includes(query)));
  const rows = pickups.map((context) => `<tr data-pickup-order="${escapeHtml(context.orderNumber)}"><td><strong>${escapeHtml(context.orderNumber)}</strong></td><td>${escapeHtml(context.customerName || context.deliveryName || '–')}</td><td>${escapeHtml(context.dispatchTime || '–')}</td><td><span class="pill ${context.staffOrder ? 'staff' : context.pickupKind === 'customer' ? 'pickup' : 'courier'}">${escapeHtml(context.staffOrder ? 'Personalorder · kundhämtning' : pickupKindLabels[context.pickupKind] || 'Okänt')}</span>${context.swishPayment ? ' <span class="pill swish">Swish betalning</span>' : ''}${simulated(context.orderNumber, 'pickup') ? ' <span class="pill virtual-pill">Simulerat utskriven</span>' : ''}</td><td><button class="quick-print" data-sim-pickup="${escapeHtml(context.orderNumber)}" type="button" ${simulationEnabled && pickupCandidate(context).length ? '' : 'disabled'}>${simulationEnabled ? 'Simulera' : 'Skriv ut'}</button></td></tr>`).join('');
  const heading = onlyStaff ? 'Personalorder' : 'Hämtningar, bud & taxi';
  const count = onlyStaff ? payload.summary?.staff ?? pickups.length : payload.summary?.total ?? pickups.length;
  ordersView.innerHTML = `<header><div><h1>${heading}</h1><p>${count} order för valt datum. ${onlyStaff ? 'Personalorder är kundhämtningar med Actor.R12 = 60 och Ord.DelMt = 6.' : 'Swish-markeringen kommer från kundens Actor.CPmtTrm = 1.'}</p></div><span class="read-only">Endast läsning</span></header>${rows ? `<table class="orders-table"><thead><tr><th>Order</th><th>Kund</th><th>Tid</th><th>Hämtsätt och betalning</th><th>Utskrift</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="orders-empty">Inga order för valt datum och sökning.</div>'}`;
  ordersView.querySelectorAll('[data-pickup-order]').forEach((row) => row.addEventListener('click', () => {
    const context = (payload.pickups || []).find((item) => String(item.orderNumber) === row.dataset.pickupOrder);
    if (context) openPickupDetails(context);
  }));
  ordersView.querySelectorAll('[data-sim-pickup]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const context = (payload.pickups || []).find((item) => String(item.orderNumber) === button.dataset.simPickup);
    if (context) simulatePickup(context);
  }));
}

async function loadPickupDashboard(refresh = false) {
  const request = ++pickupRequest;
  pickupPayload = null;
  const params = new URLSearchParams({ deliveryDate: deliveryDate.value });
  if (refresh) params.set('refresh', '1');
  document.querySelector('#pickupCount').textContent = '–';
  document.querySelector('.pickup-list').innerHTML = '<p class="pickup-empty">Hämtar order…</p>';
  document.querySelector('.pickup-more').hidden = true;
  if (activeView === 'pickups' || activeView === 'staff') ordersView.innerHTML = '<div class="orders-empty">Hämtar hämtningar, bud och taxi…</div>';
  try {
    const response = await fetch(`/api/pickups?${params}`);
    if (!response.ok) throw new Error('Kunde inte hämta hämtningar, bud och taxi.');
    const payload = await response.json();
    if (request !== pickupRequest) return;
    pickupPayload = payload;
    renderPickupCard(payload);
    if (activeView === 'pickups' || activeView === 'staff') renderPickupList(payload, activeView === 'staff');
  } catch (error) {
    if (request !== pickupRequest) return;
    renderPickupCard({ contextStatus: { available: false } });
    if (activeView === 'pickups' || activeView === 'staff') ordersView.innerHTML = `<div class="orders-empty">${escapeHtml(error.message)}</div>`;
  }
}

document.querySelectorAll('[data-title]').forEach((button) => button.addEventListener('click', () => { title.textContent = button.dataset.title; detail.textContent = button.dataset.detail; dialog.showModal(); }));
simulationToggle.addEventListener('click', () => {
  simulationEnabled = !simulationEnabled;
  refreshSimulationDisplays();
  if (statuses[activeView]) loadOrders(activeView);
});
document.querySelector('#simulationReset').addEventListener('click', () => {
  if (!window.confirm('Rensa alla virtuella utskrifter i denna webbläsarflik? Riktiga utskriftsstatusar påverkas inte.')) return;
  virtualPrinter.clear();
  refreshSimulationDisplays();
  if (statuses[activeView]) loadOrders(activeView);
});
document.querySelector('#simulationHistory').addEventListener('click', showVirtualHistory);
document.querySelector('#simulationClose').addEventListener('click', () => simulationDialog.close());
document.querySelector('#simulationCancel').addEventListener('click', () => simulationDialog.close());
document.querySelector('#simulationConfirm').addEventListener('click', () => {
  if (!simulationEnabled || !proposedSimulation) return;
  const job = virtualPrinter.addJob(proposedSimulation.label, proposedSimulation.items);
  simulationDialog.close();
  if (!job) return showToast('Inga nya virtuella dokument att markera.');
  refreshSimulationDisplays();
  if (statuses[activeView]) loadOrders(activeView);
  showToast(`${new Set(job.items.map((item) => item.orderNumber)).size} order simulerade · inga riktiga utskrifter.`);
});
simulationDialog.addEventListener('close', () => { proposedSimulation = null; });
document.querySelector('#backToDashboard').addEventListener('click', () => setActive('printward'));
dashboardSort.addEventListener('change', (event) => {
  lookupSort = event.currentTarget.value;
  if (activeView === 'freight') renderFreightList();
  else if (activeView === 'dispatch') renderDispatchList();
  else if (activeView === 'chains') renderChainList();
});
dialog.addEventListener('close', () => setActive('printward'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialog.open && activeView !== 'printward') {
    event.preventDefault();
    setActive('printward');
  }
});
document.querySelectorAll('[data-dispatch-slot]').forEach((button) => button.addEventListener('click', () => {
  selectedDispatchOrders.clear();
  dispatchReviewOpen = false;
  activeDispatchSlot = button.dataset.dispatchSlot;
  setActive('dispatch');
  renderDispatchList();
}));
document.querySelectorAll('[data-chain-panel]').forEach((button) => button.addEventListener('click', () => {
  selectedChainOrders.clear();
  chainReviewOpen = false;
  activeChainPanel = button.dataset.chainPanel;
  setActive('chains');
  renderChainList();
}));
document.querySelectorAll('[data-freight-panel]').forEach((button) => button.addEventListener('click', () => {
  selectedFreightOrders.clear();
  clearFreightReview();
  activeFreightPanel = button.dataset.freightPanel;
  setActive('freight');
  renderFreightList();
}));
document.querySelectorAll('.nav-tab').forEach((button) => button.addEventListener('click', () => { const view = button.dataset.view; setActive(view); if (view !== 'printward') loadOrders(view); }));
document.querySelector('[data-returns]').addEventListener('click', () => {
  selectedReturnOrders.clear();
  returnReviewOpen = false;
  setActive('returns');
  if (returnPayload) renderReturnList(returnPayload);
  else loadReturnDashboard();
});
document.querySelector('.pickup-more').addEventListener('click', () => {
  setActive('pickups');
  if (pickupPayload) renderPickupList(pickupPayload);
  else loadPickupDashboard();
});
document.querySelector('#refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.textContent = '↻ Uppdaterar…';
  await Promise.all([loadFreightDashboard(true), loadDispatchDashboard(true), loadChainDashboard(true), loadReturnDashboard(true), loadPickupDashboard(true)]);
  if (statuses[activeView]) await loadOrders(activeView, true);
  button.textContent = '↻ Uppdatera';
  showToast('Översikten är uppdaterad');
});
search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (activeView === 'freight') {
    selectedFreightOrders.clear();
    clearFreightReview();
    renderFreightList();
  }
  else if (activeView === 'dispatch') {
    selectedDispatchOrders.clear();
    dispatchReviewOpen = false;
    renderDispatchList();
  }
  else if (activeView === 'chains') {
    selectedChainOrders.clear();
    chainReviewOpen = false;
    renderChainList();
  }
  else if (activeView === 'returns' && returnPayload) {
    selectedReturnOrders.clear();
    returnReviewOpen = false;
    renderReturnList(returnPayload);
  }
  else if ((activeView === 'pickups' || activeView === 'staff') && pickupPayload) renderPickupList(pickupPayload, activeView === 'staff');
  else {
    if (activeView === 'printward') setActive('alla');
    if (statuses[activeView]) loadOrders(activeView);
  }
});
function dateChanged() {
  loadFreightDashboard();
  loadDispatchDashboard();
  loadChainDashboard();
  loadReturnDashboard();
  loadPickupDashboard();
  if (statuses[activeView]) loadOrders(activeView);
}
deliveryDate.addEventListener('change', dateChanged);
document.querySelector('.active-date').addEventListener('click', () => { deliveryDate.value = todayInStockholm(); dateChanged(); });
document.querySelector('.active-date + .control-button').addEventListener('click', () => { deliveryDate.value = followingDate(deliveryDate.value); dateChanged(); });
deliveryDate.value = todayInStockholm();
updateSimulationStatus();
loadFreightDashboard();
loadDispatchDashboard();
loadChainDashboard();
loadReturnDashboard();
loadPickupDashboard();
