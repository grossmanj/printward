import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrintProgressQueue } from '../src/printProgressQueue.js';

test('progress reports stay ordered without blocking the caller between sections', async () => {
  const started = [];
  const releases = [];
  const queue = createPrintProgressQueue(async (value) => {
    started.push(value);
    await new Promise((resolve) => releases.push(resolve));
  });

  queue.enqueue(0);
  queue.enqueue(1);
  await Promise.resolve();
  assert.deepEqual(started, [0]);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  releases.shift()();
  await queue.drain();
});

test('a failed progress update skips later indexes and lets final drain finish', async () => {
  const started = [];
  const warnings = [];
  const queue = createPrintProgressQueue(async (value) => {
    started.push(value);
    if (value === 0) throw new Error('temporary status failure');
  }, (message) => warnings.push(message));
  queue.enqueue(0);
  queue.enqueue(1);
  await queue.drain();
  assert.deepEqual(started, [0]);
  assert.deepEqual(warnings, ['temporary status failure']);
});
