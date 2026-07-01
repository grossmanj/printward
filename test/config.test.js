import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('live storage defaults to order documents until freight source is configured', () => {
  const config = loadConfig({
    GCS_BUCKET: 'pdf-service-bucket',
    GCS_PREFIX: '9992/'
  });

  assert.equal(config.gcs.mode, 'live');
  assert.equal(config.gcs.bucket, 'pdf-service-bucket');
  assert.equal(config.gcs.prefix, '9992/');
  assert.deepEqual(config.documentTypes.required, ['packingSlip', 'attachment']);
  assert.deepEqual(config.documentTypes.visible, ['packingSlip', 'attachment']);
});

test('freight source opt-in adds freight documents to the workflow', () => {
  const config = loadConfig({
    GCS_BUCKET: 'pdf-service-bucket',
    GCS_PREFIX: '2/',
    FREIGHT_GCS_BUCKET: 'freight-bucket',
    FREIGHT_GCS_PREFIX: 'freight/'
  });

  assert.equal(config.freightGcs.mode, 'live');
  assert.deepEqual(config.documentTypes.required, ['packingSlip', 'attachment', 'freight']);
  assert.deepEqual(config.documentTypes.visible, ['packingSlip', 'attachment', 'freight']);
});

test('nShift freight sync defaults to a separate freight prefix', () => {
  const config = loadConfig({
    GCS_BUCKET: 'pdf-service-bucket',
    GCS_PREFIX: '9992/'
  });

  assert.equal(config.nshift.outputBucket, 'pdf-service-bucket');
  assert.equal(config.nshift.outputPrefix, 'freight/9992/');
  assert.deepEqual(config.nshift.bookedStatuses, [2, 8]);
  assert.equal(config.nshift.fetchEnabled, false);
});
