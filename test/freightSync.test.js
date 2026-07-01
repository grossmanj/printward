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
