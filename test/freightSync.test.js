import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchBookedFreightShipments, mergePdfBuffers, syncFreightDocuments } from '../src/freightSync.js';
import { analyzeFreightBookingPdf, analyzeKylPalletPdf, createPlaceholderPdf } from '../src/pdf.js';

async function kylPacket(booking, kind = 'fresh') {
  const temperature = kind === 'frozen' ? 'Froozen' : 'Cooling';
  return mergePdfBuffers([
    createPlaceholderPdf(`ETIKETT ${booking}`),
    createPlaceholderPdf(`FRAKTSEDEL ${temperature} ${booking}`)
  ]);
}

test('limits the read-only SQL candidate query to allow-listed orders before TOP', async () => {
  const bindings = new Map();
  let query = '';
  let closed = false;
  const sqlConnection = {
    sql: { Int: 'int' },
    pool: {
      request() {
        return {
          input(name, _type, value) { bindings.set(name, value); return this; },
          async query(value) { query = value; return { recordset: [] }; }
        };
      },
      async close() { closed = true; }
    }
  };
  const config = {
    orderContext: { connectionString: 'test' },
    nshift: { bookedStatuses: [2, 8], candidateLimit: 2,
      allowedOrderNumbers: ['1991586', '1993751'] }
  };
  assert.deepEqual(await fetchBookedFreightShipments(config, { sqlConnection }), []);
  assert.match(query, /SELECT TOP \(@limit\)/);
  assert.match(query, /AND f\.Val1 IN \(@status0,@status1\)/);
  assert.match(query, /AND f\.OrdNo IN \(@allowedOrder0,@allowedOrder1\)/);
  assert.equal(bindings.get('allowedOrder0'), 1991586);
  assert.equal(bindings.get('allowedOrder1'), 1993751);
  assert.equal(closed, true);
});

test('rejects invalid SQL order allow-lists before connecting', async () => {
  await assert.rejects(fetchBookedFreightShipments({
    orderContext: { connectionString: 'test' },
    nshift: { allowedOrderNumbers: ['1991586 OR 1=1'] }
  }), /positive numeric order numbers/);
});

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
          body: options.printType === 2
            ? await kylPacket('FRESH1')
            : createPlaceholderPdf('Freight')
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
          body: await kylPacket('FRESH1')
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

test('repairs only an incomplete Kyl pallet PDF with separate verified chilled and frozen bookings', async () => {
  const chilled = 'CHILLED-1';
  const frozen = 'FROZEN-1';
  const oldBody = await kylPacket(chilled);
  const calls = [];
  const uploaded = [];
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', outputPrefix: 'freight/2/', dryRun: false,
    allowAll: false, allowedOrderNumbers: ['1991586'], repairExistingKyl: true,
    syncLimit: 1, palletFetchEnabled: true
  } }, {
    shipments: [{ orderNumber: '1991586', distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      consignments: [{ kind: 'fresh', consignmentNo: chilled }, { kind: 'frozen', consignmentNo: frozen }] }],
    storage: {
      async getObjectMetadata(name) { return { generation: name.includes('pallet') ? 'old-pallet' : 'old-freight' }; },
      async getObject(name, _source, generation) {
        assert.equal(name, 'freight/2/pallet1991586.pdf');
        assert.equal(generation, 'old-pallet');
        return { body: oldBody };
      },
      async uploadObjectIfChanged(name, body) { uploaded.push({ name, body }); return { uploaded: true }; }
    },
    nshiftClient: { async printDocuments(numbers, options) {
      calls.push({ numbers, options });
      return [{ name: 'pallet.pdf', contentType: 'application/pdf',
        body: await kylPacket(numbers[0], numbers[0] === frozen ? 'frozen' : 'fresh') }];
    } }
  });
  assert.equal(result.failed, 0);
  assert.deepEqual(calls.map(({ numbers }) => numbers), [[chilled], [frozen]]);
  assert.deepEqual(uploaded.map(({ name }) => name), ['freight/2/pallet1991586.pdf']);
  const analysis = await analyzeKylPalletPdf(uploaded[0].body, {
    freightConsignmentFresh: chilled, freightConsignmentFrozen: frozen
  });
  assert.deepEqual(analysis.coolingLabelPages, [1]);
  assert.deepEqual(analysis.frozenLabelPages, [3]);
  assert.deepEqual(analysis.coolingFreightPages, [2]);
  assert.deepEqual(analysis.frozenFreightPages, [4]);
});

test('preserves existing Kyl pallet PDF when nShift omits frozen pages', async () => {
  const oldBody = await kylPacket('CHILLED-1');
  let uploads = 0;
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', dryRun: false, allowAll: false,
    allowedOrderNumbers: ['1991586'], repairExistingKyl: true,
    syncLimit: 1, palletFetchEnabled: true
  } }, {
    shipments: [{ orderNumber: '1991586', distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      consignments: [{ kind: 'fresh', consignmentNo: 'CHILLED-1' }, { kind: 'frozen', consignmentNo: 'FROZEN-1' }] }],
    storage: {
      async getObjectMetadata() { return { generation: 'old' }; },
      async getObject() { return { body: oldBody }; },
      async uploadObjectIfChanged() { uploads += 1; return { uploaded: true }; }
    },
    nshiftClient: { async printDocuments() {
      return [{ name: 'pallet.pdf', contentType: 'application/pdf', body: oldBody }];
    } }
  });
  assert.equal(result.failed, 1);
  assert.equal(uploads, 0);
  assert.match(result.results[0].error, /lacks a verified label or waybill/);
});

test('Kyl repair leaves a complete existing pallet PDF untouched', async () => {
  const completeBody = await mergePdfBuffers([
    await kylPacket('CHILLED-1'), await kylPacket('FROZEN-1', 'frozen')
  ]);
  let calls = 0;
  const result = await syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', dryRun: false, allowAll: false,
    allowedOrderNumbers: ['1991586'], repairExistingKyl: true,
    syncLimit: 1, palletFetchEnabled: true
  } }, {
    shipments: [{ orderNumber: '1991586', distributorName: 'Kyl- och Frysexpressen Mälardalen AB',
      consignments: [{ kind: 'fresh', consignmentNo: 'CHILLED-1' }, { kind: 'frozen', consignmentNo: 'FROZEN-1' }] }],
    storage: {
      async getObjectMetadata() { return { generation: 'complete' }; },
      async getObject() { return { body: completeBody }; }
    },
    nshiftClient: { async printDocuments() { calls += 1; return []; } }
  });
  assert.equal(result.skipped, 1);
  assert.equal(calls, 0);
});

test('Kyl repair refuses broad runs before nShift calls', async () => {
  let calls = 0;
  await assert.rejects(syncFreightDocuments({ nshift: {
    outputBucket: 'test-bucket', allowAll: true, repairExistingKyl: true
  } }, {
    shipments: [{ orderNumber: '1991586', consignments: [{ kind: 'fresh', consignmentNo: 'CHILLED-1' }] }],
    nshiftClient: { async printDocuments() { calls += 1; return []; } }
  }), /requires NSHIFT_ALLOW_ALL=false, an explicit order allow-list/);
  assert.equal(calls, 0);
});
