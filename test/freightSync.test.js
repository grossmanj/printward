import assert from 'node:assert/strict';
import test from 'node:test';

import { mergePdfBuffers, syncFreightDocuments } from '../src/freightSync.js';
import { analyzeFreightBookingPdf, createPlaceholderPdf } from '../src/pdf.js';

test('normal DSV sync writes verified labels and waybills for each booking', async () => {
  const calls = [];
  let uploadedBody;
  const chilled = '1990353_Chilled';
  const frozen = '1990353_Froozen';
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', outputPrefix: 'freight/test/', dryRun: false,
    allowAll: true, syncLimit: 1
  } }, {
    shipments: [{ orderNumber: '1990353', deliveryMethod: 47,
      consignments: [{ kind: 'fresh', consignmentNo: chilled }, { kind: 'frozen', consignmentNo: frozen }] }],
    storage: {
      async getObjectMetadata() { return null; },
      async uploadObjectIfChanged(_name, body) { uploadedBody = body; return { uploaded: true }; }
    },
    nshiftClient: { async printDocuments(numbers, options) {
      calls.push([numbers[0], options?.printOperation]);
      const label = options?.printOperation === 'print';
      return [{ name: label ? 'label.pdf' : 'waybill.pdf', type: label ? 1 : 2,
        body: createPlaceholderPdf(`${label ? 'ETIKETT' : 'FRAKTSEDEL'} ${numbers[0]}`) }];
    } }
  });
  assert.equal(result.uploaded, 1);
  assert.deepEqual(calls, [[chilled, 'print'], [chilled, 'printWaybill'], [frozen, 'print'], [frozen, 'printWaybill']]);
  const analysis = await analyzeFreightBookingPdf(uploadedBody, {
    freightConsignmentFresh: chilled, freightConsignmentFrozen: frozen
  });
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.frozenLabelPages, [3]);
});

test('opt-in DSV repair replaces incomplete PDF, preserving it if nShift lacks a label', async () => {
  const booking = '200158234964';
  const shipment = { orderNumber: '1993020', deliveryMethod: 47,
    consignments: [{ kind: 'frozen', consignmentNo: booking }] };
  const oldBody = createPlaceholderPdf(`FRAKTSEDEL ${booking}`);
  let uploads = 0;
  let failLabel = true;
  const config = { nshift: { outputBucket: 'test-bucket', dryRun: false,
    allowAll: true, repairExistingDsv: true, syncLimit: 1 } };
  const overrides = {
    shipments: [shipment],
    storage: {
      async getObjectMetadata() { return { generation: 'old-generation' }; },
      async getObject(_name, _source, generation) {
        assert.equal(generation, 'old-generation');
        return { body: oldBody };
      },
      async uploadObjectIfChanged(_name, body) {
        uploads += 1;
        assert.notDeepEqual(body, oldBody);
        return { uploaded: true };
      }
    },
    nshiftClient: { async printDocuments(numbers, options) {
      assert.deepEqual(numbers, [booking]);
      const label = options?.printOperation === 'print';
      if (label && failLabel) return [];
      return [{ name: 'document.pdf', type: label ? 1 : 2,
        body: createPlaceholderPdf(`${label ? 'ETIKETT' : 'FRAKTSEDEL'} ${booking}`) }];
    } }
  };
  const failed = await syncFreightDocuments(config, overrides);
  assert.equal(failed.failed, 1);
  assert.equal(uploads, 0);
  failLabel = false;
  const repaired = await syncFreightDocuments(config, overrides);
  assert.equal(repaired.uploaded, 1);
  assert.equal(uploads, 1);
});

test('opt-in DSV repair skips a PDF already complete for its current booking', async () => {
  const booking = '200158234964';
  const complete = await mergePdfBuffers([
    createPlaceholderPdf(`ETIKETT ${booking}`),
    createPlaceholderPdf(`FRAKTSEDEL ${booking}`)
  ]);
  let calls = 0;
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', dryRun: false, allowAll: true,
    repairExistingDsv: true, syncLimit: 1
  } }, {
    shipments: [{ orderNumber: '1993020', deliveryMethod: 47,
      consignments: [{ kind: 'frozen', consignmentNo: booking }] }],
    storage: {
      async getObjectMetadata() { return { generation: 'complete-generation' }; },
      async getObject() { return { body: complete }; }
    },
    nshiftClient: { async printDocuments() { calls += 1; return []; } }
  });
  assert.equal(result.skipped, 1);
  assert.equal(calls, 0);
});

test('one-order DSV label test uploads only a verified label-first packet', async () => {
  const calls = [];
  let uploadedBody;
  const booking = '200158213419';
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'demo-bucket', outputPrefix: 'freight/demo/',
    dryRun: false, forceRefresh: true, allowAll: false,
    allowedOrderNumbers: ['1987847'], dsvLabelTestOrderNumber: '1987847',
    dsvLabelTestConsignmentNumber: booking, syncLimit: 1
  } }, {
    shipments: [{
      orderNumber: '1987847', deliveryMethod: 47, supplierNo: 50063993,
      consignments: [{ kind: 'fresh', consignmentNo: booking }]
    }],
    storage: {
      async uploadObjectIfChanged(name, body) {
        assert.equal(name, 'freight/demo/freight1987847.pdf');
        uploadedBody = body;
        return { uploaded: true, skipped: false, name };
      }
    },
    nshiftClient: {
      async printDocuments(numbers, options) {
        calls.push({ numbers, options });
        if (options.printType === 1) return [{ type: 1, name: 'label.pdf', contentType: 'application/pdf', body: createPlaceholderPdf(`ETIKETT ${booking}`) }];
        return [{ type: 2, name: 'waybill.pdf', contentType: 'application/pdf', body: createPlaceholderPdf(`FRAKTSEDEL ${booking}`) }];
      }
    }
  });
  assert.equal(result.uploaded, 1);
  assert.deepEqual(calls.map(({ options }) => [options.printOperation, options.printType]), [['print', 1], ['printWaybill', undefined]]);
  const analysis = await analyzeFreightBookingPdf(uploadedBody, { freightConsignmentFresh: booking });
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.coolingFreightPages, [2]);
});

test('two-booking DSV label test retains distinct chilled and frozen documents', async () => {
  const calls = [];
  let uploadedBody;
  const chilled = '1990353_Chilled';
  const frozen = '1990353_Froozen';
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'demo-bucket', outputPrefix: 'freight/demo/',
    dryRun: false, forceRefresh: true, allowAll: false,
    allowedOrderNumbers: ['1990353'], dsvLabelTestOrderNumber: '1990353',
    dsvLabelTestConsignmentNumbers: [chilled, frozen], syncLimit: 1
  } }, {
    shipments: [{ orderNumber: '1990353', deliveryMethod: 47, supplierNo: 50063993,
      consignments: [{ kind: 'fresh', consignmentNo: chilled }, { kind: 'frozen', consignmentNo: frozen }] }],
    storage: { async uploadObjectIfChanged(_name, body) { uploadedBody = body; return { uploaded: true }; } },
    nshiftClient: { async printDocuments(numbers, options) {
      calls.push({ numbers, options });
      const word = options.printType === 1 ? 'ETIKETT' : 'FRAKTSEDEL';
      return [{ type: options.printType || 2, name: `${word}.pdf`, contentType: 'application/pdf',
        body: createPlaceholderPdf(`${word} ${numbers[0]}`) }];
    } }
  });
  assert.equal(result.uploaded, 1);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ numbers }) => numbers[0]), [chilled, chilled, frozen, frozen]);
  const analysis = await analyzeFreightBookingPdf(uploadedBody, {
    freightConsignmentFresh: chilled, freightConsignmentFrozen: frozen
  });
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.coolingFreightPages, [2]);
  assert.deepEqual(analysis.frozenLabelPages, [3]);
  assert.deepEqual(analysis.frozenFreightPages, [4]);
});

test('DSV label test refuses to upload when nShift returns no label', async () => {
  let uploads = 0;
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'demo-bucket', dryRun: false, forceRefresh: true,
    allowAll: false, allowedOrderNumbers: ['1987847'], dsvLabelTestOrderNumber: '1987847',
    dsvLabelTestConsignmentNumber: 'DSV-1', syncLimit: 1
  } }, {
    shipments: [{ orderNumber: '1987847', deliveryMethod: 47,
      consignments: [{ kind: 'fresh', consignmentNo: 'DSV-1' }] }],
    storage: { async uploadObjectIfChanged() { uploads += 1; } },
    nshiftClient: { async printDocuments() { return []; } }
  });
  assert.equal(result.failed, 1);
  assert.equal(uploads, 0);
  assert.match(result.results[0].error, /no PDF label/);
});

test('DSV label test rejects a second booking before any nShift call', async () => {
  let calls = 0;
  await assert.rejects(syncFreightDocuments({ nshift: {
    outputBucket: 'demo-bucket', dryRun: false, forceRefresh: true,
    allowAll: false, allowedOrderNumbers: ['1987847'], dsvLabelTestOrderNumber: '1987847',
    dsvLabelTestConsignmentNumber: 'DSV-1', syncLimit: 1
  } }, {
    shipments: [{ orderNumber: '1987847', deliveryMethod: 47,
      consignments: [{ kind: 'fresh', consignmentNo: 'DSV-1' }, { kind: 'frozen', consignmentNo: 'DSV-2' }] }],
    nshiftClient: { async printDocuments() { calls += 1; return []; } }
  }), /exactly one allow-listed DSV order and its exact one or two bookings/);
  assert.equal(calls, 0);
});

test('syncs one freight PDF per order and skips upload in dry run', async () => {
  const config = {
    nshift: {
      outputBucket: 'pdf-service-bucket',
      outputPrefix: 'freight/9992/',
      dryRun: true
    }
  };

  const result = await syncFreightDocuments(config, {
    shipments: [
      {
        orderNumber: '1001',
        consignments: [
          { kind: 'fresh', consignmentNo: 'FRESH1' },
          { kind: 'frozen', consignmentNo: 'FROZEN1' }
        ]
      }
    ],
    nshiftClient: {
      async printDocuments(consignmentNumbers) {
        return consignmentNumbers.map((consignmentNo) => ({
          name: `${consignmentNo}.pdf`,
          contentType: 'application/pdf',
          body: createPlaceholderPdf(consignmentNo)
        }));
      }
    }
  });

  assert.equal(result.total, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].objectName, 'freight/9992/freight1001.pdf');
  assert.equal(result.results[0].skipped, true);
});

test('skips existing freight PDFs before calling nShift', async () => {
  let printCalls = 0;
  let uploadCalls = 0;
  const config = {
    nshift: {
      outputBucket: 'pdf-service-bucket',
      outputPrefix: 'freight/2/',
      dryRun: false,
      forceRefresh: false,
      allowAll: true,
      syncLimit: 1
    }
  };

  const result = await syncFreightDocuments(config, {
    shipments: [
      {
        orderNumber: '1001',
        consignments: [{ kind: 'fresh', consignmentNo: 'FRESH1' }]
      },
      {
        orderNumber: '1002',
        consignments: [{ kind: 'fresh', consignmentNo: 'FRESH2' }]
      }
    ],
    storage: {
      async getObjectMetadata(name) {
        if (name !== 'freight/2/freight1001.pdf') return null;
        return {
          name,
          generation: '123',
          updated: '2026-07-02T07:30:00.000Z'
        };
      },
      async uploadObjectIfChanged(name) {
        uploadCalls += 1;
        assert.equal(name, 'freight/2/freight1002.pdf');
        return { uploaded: true, skipped: false, name };
      }
    },
    nshiftClient: {
      async printDocuments(consignmentNumbers) {
        printCalls += 1;
        assert.deepEqual(consignmentNumbers, ['FRESH2']);
        return [{
          name: 'FRESH2.pdf',
          contentType: 'application/pdf',
          body: createPlaceholderPdf('FRESH2')
        }];
      }
    }
  });

  assert.equal(printCalls, 1);
  assert.equal(uploadCalls, 1);
  assert.equal(result.total, 2);
  assert.equal(result.uploaded, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].existing, true);
  assert.equal(result.results[0].generation, '123');
  assert.equal(result.results[1].orderNumber, '1002');
  assert.equal(result.results[1].uploaded, true);
});

test('syncs pallet documents for Kyl och Frysexpressen shipments with booked consignments', async () => {
  const calls = [];
  const config = {
    nshift: {
      outputBucket: 'pdf-service-bucket',
      outputPrefix: 'freight/9992/',
      dryRun: true,
      palletPrintOperation: 'print',
      palletPrintType: 2
    }
  };

  const result = await syncFreightDocuments(config, {
    shipments: [
      {
        orderNumber: '1001',
        distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
        freightPalletCopies: 0,
        consignments: [{ kind: 'fresh', consignmentNo: 'FRESH1' }]
      }
    ],
    nshiftClient: {
      async printDocuments(consignmentNumbers, options = {}) {
        calls.push({ consignmentNumbers, options });
        return [{
          name: `${options.printType === 2 ? 'pallet' : 'freight'}.pdf`,
          contentType: 'application/pdf',
          body: createPlaceholderPdf(options.printType === 2 ? 'Pallet' : 'Freight')
        }];
      }
    }
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, {});
  assert.equal(calls[1].options.printOperation, 'print');
  assert.equal(calls[1].options.printType, 2);
  assert.equal(result.results[0].objectName, 'freight/9992/freight1001.pdf');
  assert.equal(result.results[0].palletObjectName, 'freight/9992/pallet1001.pdf');
  assert.equal(result.results[0].palletCopies, 0);
  assert.equal(result.results[0].palletSkipped, true);
});

test('backfills missing pallet PDFs without refetching existing freight PDFs', async () => {
  let printCalls = 0;
  const uploaded = [];
  const config = {
    nshift: {
      outputBucket: 'pdf-service-bucket',
      outputPrefix: 'freight/2/',
      dryRun: false,
      forceRefresh: false,
      allowAll: true,
      syncLimit: 1,
      palletPrintOperation: 'print',
      palletPrintType: 2
    }
  };

  const result = await syncFreightDocuments(config, {
    shipments: [
      {
        orderNumber: '1001',
        distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
        freightPalletCopies: 0,
        consignments: [{ kind: 'fresh', consignmentNo: 'FRESH1' }]
      }
    ],
    storage: {
      async getObjectMetadata(name) {
        if (name === 'freight/2/freight1001.pdf') {
          return { name, generation: '123', updated: '2026-07-02T07:30:00.000Z' };
        }
        return null;
      },
      async uploadObjectIfChanged(name) {
        uploaded.push(name);
        return { uploaded: true, skipped: false, name };
      }
    },
    nshiftClient: {
      async printDocuments(consignmentNumbers, options = {}) {
        printCalls += 1;
        assert.deepEqual(consignmentNumbers, ['FRESH1']);
        assert.equal(options.printType, 2);
        return [{
          name: 'pallet.pdf',
          contentType: 'application/pdf',
          body: createPlaceholderPdf('Pallet')
        }];
      }
    }
  });

  assert.equal(printCalls, 1);
  assert.deepEqual(uploaded, ['freight/2/pallet1001.pdf']);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].freightSkipped, true);
  assert.equal(result.results[0].palletUploaded, true);
});
