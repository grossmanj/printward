import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import { createCenteredTextPdf, repeatPdfPages } from '../src/pdf.js';

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
