import assert from 'node:assert/strict';
import test from 'node:test';
import { createVirtualPrinter } from '../public/printward-virtual-printer.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('virtual printer tracks documents locally and never duplicates a simulated document', () => {
  const storage = memoryStorage();
  const printer = createVirtualPrinter(storage);
  const slip = { deliveryDate: '2026-09-25', orderNumber: '1988145', type: 'packingSlip' };
  const attachment = { ...slip, type: 'attachment' };
  const freight = { ...slip, type: 'freight' };
  assert.equal(printer.addJob('FM', [slip, attachment, slip]).items.length, 2);
  assert.equal(printer.has(slip.deliveryDate, slip.orderNumber, slip.type), true);
  assert.equal(printer.has(slip.deliveryDate, slip.orderNumber, 'freight'), false);
  assert.equal(printer.addJob('Kyl', [slip, freight]).items.length, 1);
  assert.equal(printer.jobs().length, 2);
  assert.equal(createVirtualPrinter(storage).has(slip.deliveryDate, slip.orderNumber, 'freight'), true);
  printer.clear();
  assert.equal(createVirtualPrinter(storage).jobs().length, 0);
});

test('virtual printer ignores invalid or corrupt local data', () => {
  const storage = memoryStorage();
  storage.setItem('printward-virtual-printer-v1', '{');
  const printer = createVirtualPrinter(storage);
  assert.equal(printer.addJob('invalid', [{ deliveryDate: '2026-09-25', orderNumber: '1', type: 'unknown' }]), null);
  assert.equal(printer.jobs().length, 0);
});
