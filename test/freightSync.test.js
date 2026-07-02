import assert from 'node:assert/strict';
import test from 'node:test';

import { syncFreightDocuments } from '../src/freightSync.js';
import { createPlaceholderPdf } from '../src/pdf.js';

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
