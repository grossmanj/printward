import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import {
  analyzeKylPalletPdf,
  createCenteredTextPdf,
  createPlaceholderPdf,
  extractKylFreightSection,
  extractPdfPages,
  inferKylPalletLabelPages,
  repeatPdfPages
} from '../src/pdf.js';

async function createMarkerPdf(pages) {
  const merged = await PDFDocument.create();
  for (const text of pages) {
    const source = await PDFDocument.load(createPlaceholderPdf(text));
    const copied = await merged.copyPages(source, source.getPageIndices());
    copied.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

test('creates a one page centered text PDF', async () => {
  const pdf = await PDFDocument.load(createCenteredTextPdf('YLG 19P'));
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getPage(0).getWidth(), 612);
  assert.equal(pdf.getPage(0).getHeight(), 792);
});

test('repeats each PDF page before moving to the next page', async () => {
  const source = await PDFDocument.create();
  source.addPage([100, 200]);
  source.addPage([300, 400]);

  const repeated = await PDFDocument.load(await repeatPdfPages(await source.save(), 4));
  const pageSizes = repeated.getPages().map((page) => [
    page.getWidth(),
    page.getHeight()
  ]);

  assert.deepEqual(pageSizes, [
    [100, 200],
    [100, 200],
    [100, 200],
    [100, 200],
    [300, 400],
    [300, 400],
    [300, 400],
    [300, 400]
  ]);
});

test('extracts selected PDF pages', async () => {
  const source = await PDFDocument.create();
  source.addPage([100, 200]);
  source.addPage([300, 400]);
  source.addPage([500, 600]);

  const extracted = await PDFDocument.load(await extractPdfPages(await source.save(), '2-3'));
  const pageSizes = extracted.getPages().map((page) => [
    page.getWidth(),
    page.getHeight()
  ]);

  assert.deepEqual(pageSizes, [
    [300, 400],
    [500, 600]
  ]);
});

test('extracts Kyl frozen and cooling freight sections after pallet pages', async () => {
  const body = await createMarkerPdf([
    'Kolli-ID 1 1962465_Cooling',
    'Kolli-ID 2 1962465_Froozen',
    'FRAKTSEDEL 1962465_Cooling Kyla +2-+8c',
    'FRAKTSEDEL 1962465_Cooling Kyla +2-+8c',
    'FRAKTSEDEL 1962465_Cooling Kyla +2-+8c',
    'FRAKTSEDEL 1962465_Froozen Fryst',
    'FRAKTSEDEL 1962465_Froozen Fryst',
    'FRAKTSEDEL 1962465_Froozen Fryst'
  ]);

  const frozen = await PDFDocument.load(await extractKylFreightSection(body, {
    section: 'frozenFreight',
    labelPages: 2,
    hasCooling: true,
    hasFrozen: true
  }));
  const cooling = await PDFDocument.load(await extractKylFreightSection(body, {
    section: 'coolingFreight',
    labelPages: 2,
    hasCooling: true,
    hasFrozen: true
  }));

  assert.equal(frozen.getPageCount(), 3);
  assert.equal(cooling.getPageCount(), 3);
  assert.deepEqual((await analyzeKylPalletPdf(await frozen.save())).frozenFreightPages, [1, 2, 3]);
  assert.deepEqual((await analyzeKylPalletPdf(await cooling.save())).coolingFreightPages, [1, 2, 3]);
});

test('classifies variable Kyl pallet label pages from page text', async () => {
  const body = await createMarkerPdf([
    'Kolli-ID 1 1962465_Cooling',
    'Kolli-ID 2 1962465_Froozen',
    'Kolli-ID 3 1962465_Froozen',
    'FRAKTSEDEL 1962465_Cooling Kyla +2-+8c',
    'FRAKTSEDEL 1962465_Cooling Kyla +2-+8c',
    'FRAKTSEDEL 1962465_Froozen Fryst',
    'FRAKTSEDEL 1962465_Froozen Fryst',
    'FRAKTSEDEL 1962465_Froozen Fryst'
  ]);
  const analysis = await analyzeKylPalletPdf(body);

  assert.equal(await inferKylPalletLabelPages(body, {
    hasCooling: true,
    hasFrozen: true
  }), 3);
  assert.deepEqual(analysis.labelPages, [1, 2, 3]);
  assert.deepEqual(analysis.coolingFreightPages, [4, 5]);
  assert.deepEqual(analysis.frozenFreightPages, [6, 7, 8]);

  const frozen = await PDFDocument.load(await extractKylFreightSection(body, {
    section: 'frozenFreight',
    labelPages: 1,
    hasCooling: true,
    hasFrozen: true
  }));

  assert.equal(frozen.getPageCount(), 3);
  assert.deepEqual((await analyzeKylPalletPdf(await frozen.save())).frozenFreightPages, [1, 2, 3]);
});
