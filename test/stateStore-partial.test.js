import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StateStore, buildPrintIndex, summarizeJobProgress } from '../src/stateStore.js';
import { buildOrders } from '../src/documents.js';

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'printward-partial-test-'));
  try {
    await run(new StateStore(path.join(directory, 'state.json')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function section(orderNumber, temperature) {
  return {
    orderNumber,
    sectionType: `${temperature}-dsv-packet`,
    documents: [{ type: 'freight', source: 'freight', name: `freight${orderNumber}.pdf`, generation: '42' }]
  };
}

test('failed Windows batch records only whole orders with every section spool-confirmed', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      orders: [section('201', 'frozen'), section('201', 'cooling'), section('202', 'frozen'), section('202', 'cooling')]
    });
    const result = await store.completeJob(job.id, {
      status: 'failed',
      error: 'Later section did not reach Windows spooler',
      results: [
        { orderNumber: '201', spoolConfirmed: true },
        { orderNumber: '201', spoolConfirmed: true },
        { orderNumber: '202', spoolConfirmed: true }
      ]
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.confirmedOrderNumbers, ['201']);
    const state = await store.getState();
    assert.deepEqual(new Set(state.printEvents.map((event) => event.orderNumber)), new Set(['201']));
  });
});

test('failed batch does not trust missing, mismatched or unconfirmed section results', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({ orders: [section('301', 'frozen'), section('302', 'cooling')] });
    const result = await store.completeJob(job.id, {
      status: 'failed',
      results: [{ orderNumber: '302', spoolConfirmed: true }]
    });
    assert.deepEqual(result.confirmedOrderNumbers, []);
    assert.equal((await store.getState()).printEvents.length, 0);
  });
});

test('section progress counts whole orders and rejects out-of-order or unconfirmed callbacks', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      orders: [section('401', 'frozen'), section('401', 'cooling'), section('402', 'frozen')],
      notes: 'Dashboard freight'
    });
    await assert.rejects(store.updateJobProgress(job.id, {
      sectionIndex: 1, orderNumber: '401', spoolConfirmed: true
    }), /out of order/);
    await assert.rejects(store.updateJobProgress(job.id, {
      sectionIndex: 0, orderNumber: '401', spoolConfirmed: false
    }), /Invalid/);
    const first = await store.updateJobProgress(job.id, {
      sectionIndex: 0, orderNumber: '401', spoolConfirmed: true
    });
    assert.deepEqual(summarizeJobProgress(first), {
      status: 'printing', totalSections: 3, completedSections: 1, remainingSections: 2,
      totalOrders: 2, completedOrders: 0, remainingOrders: 2, currentOrderNumber: '401',
      updatedAt: first.updatedAt, error: ''
    });
    await store.updateJobProgress(job.id, { sectionIndex: 0, orderNumber: '401', spoolConfirmed: true });
    const second = await store.updateJobProgress(job.id, {
      sectionIndex: 1, orderNumber: '401', spoolConfirmed: true
    });
    assert.equal(summarizeJobProgress(second).completedOrders, 1);
    const stopped = await store.completeJob(job.id, { status: 'failed', error: 'Paper jam' });
    assert.deepEqual(stopped.confirmedOrderNumbers, ['401']);
    assert.equal(summarizeJobProgress(stopped).remainingOrders, 1);
    await assert.rejects(store.updateJobProgress(job.id, {
      sectionIndex: 2, orderNumber: '402', spoolConfirmed: true
    }), /out of order/);
  });
});

test('a success callback with only one of two Finland temperature sections remains failed', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      orders: [section('501', 'frozen'), section('501', 'cooling')], notes: 'Dashboard Finland'
    });
    const result = await store.completeJob(job.id, {
      status: 'printed', results: [{ orderNumber: '501', spoolConfirmed: true }]
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.confirmedOrderNumbers, []);
    assert.equal(summarizeJobProgress(result).remainingOrders, 1);
  });
});

test('dashboard success cannot mark an order printed without section confirmations', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({ orders: [section('601', 'frozen')], notes: 'Dashboard freight' });
    const result = await store.completeJob(job.id, { status: 'printed' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.confirmedOrderNumbers, []);
  });
});

test('manual freight status is idempotent and belongs only to the marked PDF generation', async () => {
  await withStore(async (store) => {
    const document = { orderNumber: '701', type: 'pallet', name: 'pallet701.pdf', source: 'primary',
      generation: '11', updated: '2026-10-13T08:00:00Z' };
    assert.deepEqual(await store.markDocumentsPrinted([document], 'Edmark'), ['701']);
    assert.deepEqual(await store.markDocumentsPrinted([document], 'Edmark'), []);
    const state = await store.getState();
    assert.equal(state.jobs.length, 0);
    assert.equal(state.printEvents.length, 1);
    assert.equal(state.printEvents[0].method, 'manual');
    assert.equal(state.printEvents[0].printedBy, 'Edmark');
    const current = buildOrders([document], buildPrintIndex(state));
    assert.equal(current[0].documents.pallet.printStatus, 'printed');
    const replaced = buildOrders([{ ...document, generation: '12', updated: '2026-10-13T09:00:00Z' }], buildPrintIndex(state));
    assert.equal(replaced[0].documents.pallet.printStatus, 'reprint');
  });
});
