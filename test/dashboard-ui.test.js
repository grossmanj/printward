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
  assert.match(script, /<button id="reviewFreightSelection"[^>]*>Granska utskriftsbara<\/button><button class="print-selected"/);
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

test('freight bulk skips missing bookings while manual Kyl status can select their existing PDFs', () => {
  assert.match(script, /function hasTemperatureBooking\(order\)/);
  assert.match(script, /const selectableVisible = visibleItems\.filter\(freightManualMarkCandidate\)/);
  assert.match(script, /const printableSelectedItems = selectedItems\.filter\(freightBulkCandidate\)/);
  assert.match(script, /Ingen utskriftsbar bokning · ny utskrift spärrad/);
  assert.match(script, /Markera alla med fraktdokument i listan/);
  assert.match(script, /printDashboardItems\(kind, panelId, label, items, \{ bulkFreight: kind === 'freight' \}\)/);
  assert.match(script, /bulkFreight: printableSelectedItems\.length > 1/);
  assert.match(script, /body: JSON\.stringify\(\{[^]*bulkFreight,/);
});

test('Kyl manual mark confirms selected orders, sends no print job, and reloads the overview', () => {
  assert.match(script, /activeFreightPanel === 'kyl-and-frys' \? `<button id="markFreightPrinted"/);
  assert.match(script, /window\.confirm\(`Markera \$\{count\} Kyl & Frys-order som redan utskrivna/);
  assert.match(script, /fetch\('\/api\/dashboard\/freight-mark-printed'/);
  assert.match(script, /documentVersions, user:/);
  assert.match(script, /closeLookup\(\);\s*await loadFreightDashboard\(true\)/);
});

test('all tracked freight cards use a compact count and keep print status visible without a booking', () => {
  assert.equal((html.match(/class="freight-total"/g) || []).length, 3);
  assert.equal((html.match(/order utskrivna<\/small>/g) || []).length, 3);
  assert.doesNotMatch(html, /<small>med PDF(?: \(ej verifierade\))?<\/small>|<small>med dokument<\/small>/);
  assert.doesNotMatch(html, /med dokument|med PDF \(ej verifierade\)/);
  assert.equal((html.match(/class="freight-card-note"/g) || []).length, 3);
  assert.match(script, /panel\?\.documentTracking \? panel\.printed : panel\?\.departureCount/);
  assert.match(script, /\$\{Math\.max\(0, \(panel\?\.total \?\? 0\) - \(panel\?\.printed \?\? 0\)\)\} återstår/);
  assert.match(script, /PDF finns · \$\{statusLabel\(printStatus\)\}/);
  assert.match(script, /const bookingWarning = panel\.documentTracking && !hasTemperatureBooking\(order\)/);
  assert.match(script, /PDF-innehållet kontrolleras först vid granskning eller utskrift/);
  assert.match(script, /if \(jobCreated\) \{\s*try \{\s*await refreshAfterPrint\(\)/);
  assert.match(script, /async function refreshAfterPrint\(\) \{\s*await Promise\.all\(\[loadFreightDashboard\(true\)/);
});

test('own-car cards show Edmarks departure times and clarify ready versus total', () => {
  assert.match(html, /Alla order för valt leveransdatum, även de som inte ingår i en utskriftsgrupp/);
  assert.equal((html.match(/redo för utskrift av/g) || []).length, 3);
  assert.match(html, /<time>Senast 08:00<\/time>/);
  assert.match(html, /<time>09:00–10:00<\/time>/);
  assert.match(html, /<time>Från 13:00<\/time>/);
  assert.equal((html.match(/class="dispatch-printed"/g) || []).length, 3);
  assert.equal((html.match(/class="dispatch-not-ready"/g) || []).length, 3);
  assert.match(script, /Registrerat utskrivna betyder bekräftade av skrivarkön/);
});

test('dashboard exposes spool progress and only manual recovery of unfinished whole orders', () => {
  assert.match(html, /id="printJobProgress"/);
  assert.match(html, /id="resumePrintJob"/);
  assert.match(script, /completedSections.*totalSections/s);
  assert.match(script, /Kontrollera först vad som faktiskt kommit ut ur skrivaren/);
  assert.match(script, /\/api\/print-jobs\/\$\{encodeURIComponent\(previousJobId\)\}\/resume/);
  assert.match(script, /printward:lastPrintJobId/);
});

test('completed print progress can be dismissed and does not return on reload', () => {
  assert.match(html, /id="closePrintJobProgress"[^>]*aria-label="Dölj utskriftskörning"/);
  assert.match(html, /id="printJobProgressTitle"/);
  assert.match(script, /closePrintProgressButton\.addEventListener\('click', \(\) => \{\s*printProgressPanel\.hidden = true/);
  assert.match(script, /printProgressPanel\.classList\.toggle\('is-complete', status === 'printed'\)/);
  assert.match(script, /Skickat till skrivarkön/);
  assert.match(script, /if \(localStorage\.getItem\('printward:lastPrintJobId'\) === progressJobId\) localStorage\.removeItem\('printward:lastPrintJobId'\)/);
  assert.match(script, /if \(progressJobId !== jobId \|\| progress\.status === 'printed'\) return/);
  assert.match(script, /status === 'failed'[\s\S]*?printProgressPanel\.hidden = false/);
});

test('dashboard polls visible data every two minutes without clearing an active selection', () => {
  assert.match(html, /id="syncStatus"/);
  assert.match(script, /const AUTO_REFRESH_MS = 120_000/);
  assert.match(script, /setInterval\(maybeAutoRefresh, 15_000\)/);
  assert.match(script, /document\.addEventListener\('visibilitychange', maybeAutoRefresh\)/);
  assert.match(script, /activeView === 'dispatch' && \(selectedDispatchOrders\.size \|\| dispatchReviewOpen\)/);
  assert.match(script, /if \(!background\) \{\s*dispatchPayload = null;\s*selectedDispatchOrders\.clear\(\)/);
  assert.match(script, /refreshDashboard\('auto', true\)/);
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
