import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/printward-dashboard.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/printward-dashboard.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../src/local-agent.js', import.meta.url), 'utf8');

test('overview quick-print controls start disabled and require server print capability', () => {
  const buttons = [...html.matchAll(/<button class="quick-print"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 12);
  for (const button of buttons) assert.match(button, /\bdisabled\b/);
  assert.equal((html.match(/>Visa avgångar<\/span>/g) || []).length, 5);
  assert.match(script, /realPrintingEnabled = payload\.dashboardPrintingEnabled === true/);
  assert.match(script, /\/api\/dashboard\/print-jobs/);
});

test('print and agent controls share the filter row after distributor', () => {
  const toolbar = html.match(/<section class="toolbar"[\s\S]*?<\/section>/)?.[0];
  assert.ok(toolbar);
  assert.match(toolbar, /Distributör: Alla[\s\S]*class="simulation-toolbar"/);
  assert.match(toolbar, /id="simulationToggle"[\s\S]*id="simulationStatus"[\s\S]*id="printerSettingsButton"/);
  assert.equal((html.match(/class="simulation-toolbar"/g) || []).length, 1);
});

test('Windows dashboard printing rejects an old agent without spool confirmation', () => {
  assert.match(agent, /spoolConfirmation: true/);
  assert.match(script, /details\.platform === 'win32' && !details\.spoolConfirmation/);
  assert.match(script, /agent\.platform === 'win32' && !agent\.spoolConfirmation/);
  assert.match(script, /Print Agent är redo, men skrivarköerna kunde inte hämtas/);
});

test('document review links use the selected PDF generation', () => {
  assert.match(script, /if \(document\.generation\) params\.set\('generation', document\.generation\)/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
});

test('virtual print review identifies stapled order packets separately from real jobs', () => {
  assert.match(html, /id="simulationToggle"/);
  assert.match(html, /id="simulationHistory"/);
  assert.match(html, /type="module" src="\/printward-dashboard\.js"/);
  assert.match(script, /Följesedel → Partibilaga|types\.map\(\(type\) => simulationNames\[type\]\)\.join\(' → '\)/);
  assert.match(script, /Planerad bunt: de här två ska häftas ihop för denna order/);
  assert.match(script, /Fraktdokument\/etiketter separat · ingen följesedel/);
  assert.match(script, /if \(simulationEnabled\) openVirtualPrint/);
});

test('dispatch, freight and chain lookups expose view-only delivery-method sorting', () => {
  assert.equal((script.match(/sortLookupItems\((?:panel|slot)\.orders\.filter/g) || []).length, 3);
  assert.match(html, /<select id="dashboardSort"[^>]*>.*<option value="method">Sortera: Körsätt<\/option>/);
  assert.match(script, /dashboardSort\.addEventListener\('change'/);
  assert.match(script, /activeView === 'freight'\) renderFreightList\(\)/);
  assert.match(script, /activeView === 'dispatch'\) renderDispatchList\(\)/);
  assert.match(script, /activeView === 'chains'\) renderChainList\(\)/);
});

test('freight lookup wires separate review and print controls before selection handlers', () => {
  assert.match(script, /<button id="reviewFreightSelection"[^>]*>Granska valda<\/button><button class="print-selected"/);
  assert.match(script, /ordersView\.querySelector\('\.print-selected'\)\.addEventListener\('click'/);
  assert.match(script, /ordersView\.querySelector\('#selectAllFreightReady'\)\.addEventListener\('change'/);
  assert.match(script, /ordersView\.querySelectorAll\('\[data-select-freight-order\]'\)/);
});

test('follow-slip lookup has clickable method bundles and searchable route codes', () => {
  assert.match(html, /aria-label="Sök ort, kund, registreringsnummer, rutt, order eller bokningsnummer"/);
  assert.match(script, /groupDispatchItems\(visibleItems\)/);
  assert.match(script, /matchesDispatchSearch\(item, query\)/);
  assert.match(script, /data-dispatch-group=/);
  assert.match(script, /aria-expanded=/);
  assert.match(script, /querySelector\('\.dispatch-group-body'\)\.hidden = !expanded/);
  assert.match(script, /data-print-dispatch-group=/);
  assert.match(script, /data-show-dispatch-order=/);
  assert.match(script, /data-show-freight-order=/);
  assert.match(script, /data-show-chain-order=/);
  assert.doesNotMatch(script, /dialog\.addEventListener\('close',[^]*closeLookup\(\)/);
});

test('freight bulk leaves orders without chilled/frozen booking visible but unselected', () => {
  assert.match(script, /function hasTemperatureBooking\(order\)/);
  assert.match(script, /const selectableVisible = visibleItems\.filter\(freightBulkCandidate\)/);
  assert.match(script, /panel\.orders\.filter\(freightBulkCandidate\)/);
  assert.match(script, /Bokningsnummer saknas · kvar i listan/);
  assert.match(script, /Markera alla utskriftsbara i listan/);
  assert.match(script, /printDashboardItems\(kind, panelId, label, items, \{ bulkFreight: kind === 'freight' \}\)/);
  assert.match(script, /bulkFreight: selectedItems\.length > 1/);
  assert.match(script, /body: JSON\.stringify\(\{[^]*bulkFreight,/);
});

test('own-car cards show Edmarks departure times and clarify ready versus total', () => {
  assert.match(html, /<time>Före 08:00<\/time>/);
  assert.match(html, /<time>09:00–10:00<\/time>/);
  assert.match(html, /<time>13:00–16:00<\/time>/);
  assert.match(script, /redan utskrivna räknas inte som klara/);
});

test('overview search opens an all-status, date-scoped lookup with city and route columns', () => {
  assert.match(script, /search: 'all'/);
  assert.match(script, /if \(activeView === 'printward'\) navigateToLookup\('search'\)/);
  assert.match(script, /deliveryDate: deliveryDate\.value, q: search\.value\.trim\(\)/);
  assert.match(script, /<h1>\$\{names\[view\]\}<\/h1>/);
  assert.match(script, /<th>Ort<\/th><th>Körsätt \/ regnr<\/th>/);
});

test('browser Back and Forward navigate between overview and lookups without print actions', () => {
  assert.match(script, /history\.pushState\(state, ''\)/);
  assert.match(script, /history\.replaceState\(state, ''\)/);
  assert.match(script, /history\.back\(\)/);
  assert.match(script, /window\.addEventListener\('popstate', \(event\) => restoreLookup\(event\.state\?\.printwardLookup\)\)/);
  assert.match(script, /#backToDashboard'\)\.addEventListener\('click', closeLookup\)/);
  assert.match(script, /event\.key === 'Escape'[\s\S]*closeLookup\(\)/);
});
