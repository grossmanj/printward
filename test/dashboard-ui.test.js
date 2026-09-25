import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/printward-dashboard.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/printward-dashboard.js', import.meta.url), 'utf8');

test('overview quick-print controls remain disabled in the read-only dashboard', () => {
  const buttons = [...html.matchAll(/<button class="quick-print"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 12);
  for (const button of buttons) assert.match(button, /\bdisabled\b/);
  assert.equal((html.match(/>Visa avgångar<\/span>/g) || []).length, 5);
  assert.doesNotMatch(script, /\/api\/print-jobs/);
});

test('document review links use the selected PDF generation', () => {
  assert.match(script, /if \(document\.generation\) params\.set\('generation', document\.generation\)/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
});

test('virtual print review identifies stapled order packets without submitting real print jobs', () => {
  assert.match(html, /id="simulationToggle"/);
  assert.match(html, /id="simulationHistory"/);
  assert.match(html, /type="module" src="\/printward-dashboard\.js"/);
  assert.match(script, /Följesedel → Partibilaga|types\.map\(\(type\) => simulationNames\[type\]\)\.join\(' → '\)/);
  assert.match(script, /Planerad bunt: de här två ska häftas ihop för denna order/);
  assert.match(script, /Fraktdokument\/etiketter separat · ingen följesedel/);
  assert.doesNotMatch(script, /\/api\/print-jobs/);
});

test('dispatch, freight and chain lookups expose view-only delivery-method sorting', () => {
  assert.equal((script.match(/sortLookupItems\((?:panel|slot)\.orders\.filter/g) || []).length, 3);
  assert.match(html, /<select id="dashboardSort"[^>]*>.*<option value="method">Sortera: Körsätt<\/option>/);
  assert.match(script, /dashboardSort\.addEventListener\('change'/);
  assert.match(script, /activeView === 'freight'\) renderFreightList\(\)/);
  assert.match(script, /activeView === 'dispatch'\) renderDispatchList\(\)/);
  assert.match(script, /activeView === 'chains'\) renderChainList\(\)/);
  assert.doesNotMatch(script, /\/api\/print-jobs/);
});
