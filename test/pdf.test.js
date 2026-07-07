import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import {
  createCenteredTextPdf,
  extractKylFreightSection,
  extractPdfPages,
  inferKylPalletLabelPages,
  repeatPdfPages
} from '../src/pdf.js';

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
  const source = await PDFDocument.create();
  source.addPage([100, 100]);
  source.addPage([110, 110]);
  source.addPage([200, 200]);
  source.addPage([210, 210]);
  source.addPage([220, 220]);
  source.addPage([300, 300]);
  source.addPage([310, 310]);
  source.addPage([320, 320]);
  const body = await source.save();

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

  assert.deepEqual(frozen.getPages().map((page) => page.getWidth()), [300, 310, 320]);
  assert.deepEqual(cooling.getPages().map((page) => page.getWidth()), [200, 210, 220]);
});

test('infers Kyl label pages when requested label count is wrong', async () => {
  const source = await PDFDocument.create();
  source.addPage([100, 100]);
  source.addPage([110, 110]);
  source.addPage([200, 200]);
  source.addPage([210, 210]);
  source.addPage([220, 220]);
  source.addPage([300, 300]);
  source.addPage([310, 310]);
  source.addPage([320, 320]);
  const body = await source.save();

  assert.equal(await inferKylPalletLabelPages(body, {
    hasCooling: true,
    hasFrozen: true
  }), 2);

  const frozen = await PDFDocument.load(await extractKylFreightSection(body, {
    section: 'frozenFreight',
    labelPages: 1,
    hasCooling: true,
    hasFrozen: true
  }));

  assert.deepEqual(frozen.getPages().map((page) => page.getWidth()), [300, 310, 320]);
});
