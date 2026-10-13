import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import {
  analyzeFreightBookingPdf,
  analyzeKylPalletPdf,
  createCenteredTextPdf,
  createPlaceholderPdf,
  extractKylFreightSection,
  extractPdfPages,
  inferKylPalletLabelPages,
  repeatPdfPages,
  stampVismaPackingSlipRegistration
} from '../src/pdf.js';

async function createVismaSlipFixture({ title = 'Följesedel NettoNetto(2050).pdf', field = true } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const page = pdf.addPage([593.794276, 840.440741]);
  if (field) {
    const content = [
      'BT',
      '1 0 0 -1 316.5165 277.021 Tm',
      '/Times-Roman 10 Tf',
      '[(Transportsätt)] TJ',
      'ET',
      'BT',
      '1 0 0 -1 316.5165 291.1942 Tm',
      '/Times-Roman 10 Tf',
      '[(SYD)] TJ',
      'ET'
    ].join('\n');
    const stream = pdf.context.flateStream(Buffer.from(content, 'latin1'));
    page.node.addContentStream(pdf.context.register(stream));
  }
  return Buffer.from(await pdf.save());
}

test('replaces only the verified Visma slip transport field on the print copy', async () => {
  const source = await createVismaSlipFixture();
  const stamped = await stampVismaPackingSlipRegistration(source, 'UEJ 64A');
  const pdf = await PDFDocument.load(stamped);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), 'Följesedel NettoNetto(2050).pdf');
  assert.notDeepEqual(stamped, source);

  const alternate = await createVismaSlipFixture({ title: 'Följesedel NettoNetto(2101).pdf' });
  assert.ok((await stampVismaPackingSlipRegistration(alternate, 'UEJ 64A')).length > 0);
});

test('rejects unverified Visma layouts and invalid registration text', async () => {
  const wrongForm = await createVismaSlipFixture({ title: 'Another form.pdf' });
  const missingField = await createVismaSlipFixture({ field: false });
  await assert.rejects(stampVismaPackingSlipRegistration(wrongForm, 'UEJ 64A'), /not a verified Visma form/);
  await assert.rejects(stampVismaPackingSlipRegistration(missingField, 'UEJ 64A'), /transport field could not be verified/);
  await assert.rejects(stampVismaPackingSlipRegistration(await createVismaSlipFixture(), 'SYD'), /verified vehicle registration/);
});

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

test('repeats a complete booking PDF before the next copy', async () => {
  const source = await PDFDocument.create();
  source.addPage([100, 200]);
  source.addPage([300, 400]);

  const repeated = await PDFDocument.load(await repeatPdfPages(await source.save(), 3, 'perDocument'));
  assert.deepEqual(repeated.getPages().map((page) => page.getWidth()), [100, 300, 100, 300, 100, 300]);
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

test('keeps labels first when a Kyl packet selects later frozen pages before chilled pages', async () => {
  const source = await PDFDocument.create();
  for (const width of [101, 102, 103, 104, 105, 106]) source.addPage([width, 200]);

  const packet = await PDFDocument.load(await extractPdfPages(await source.save(), '1-2,5-6,3-4'));
  assert.deepEqual(packet.getPages().map((page) => page.getWidth()), [101, 102, 105, 106, 103, 104]);
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
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.frozenLabelPages, [2, 3]);
  assert.deepEqual(analysis.unknownLabelPages, []);
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

test('matches Kyl labels to the correct booking number before separating staples', async () => {
  const body = await createMarkerPdf([
    'Kolli-ID 0068602499',
    'Kolli-ID 0068594456',
    'FRAKTSEDEL Froozen',
    'FRAKTSEDEL Cooling'
  ]);
  const analysis = await analyzeKylPalletPdf(body, {
    freightConsignmentFresh: '0068602499',
    freightConsignmentFrozen: '0068594456'
  });
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.frozenLabelPages, [2]);
  assert.deepEqual(analysis.unknownLabelPages, []);
});

test('matches DSV labels and waybills to the right booking despite mixed PDF page order', async () => {
  const body = await createMarkerPdf([
    'FRAKTSEDEL CHILLED-400',
    'ETIKETT FROZEN-400',
    'FRAKTSEDEL FROZEN-400',
    'ETIKETT CHILLED-400'
  ]);
  const analysis = await analyzeFreightBookingPdf(body, {
    freightConsignmentFresh: 'CHILLED-400',
    freightConsignmentFrozen: 'FROZEN-400'
  });
  assert.deepEqual(analysis.coolingLabelPages, [4]);
  assert.deepEqual(analysis.coolingFreightPages, [1]);
  assert.deepEqual(analysis.frozenLabelPages, [2]);
  assert.deepEqual(analysis.frozenFreightPages, [3]);
  assert.deepEqual(analysis.unknownPages, []);
});
