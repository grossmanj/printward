import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import { repeatPdfPages } from '../src/pdf.js';

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
