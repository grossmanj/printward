import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmWindowsSpool, hasNewPrintedEvent, newestPrintedEventId, parsePrintedEvents } from '../src/windows-spool.js';

test('Windows print events are matched by queue and a newer record ID', () => {
  const events = parsePrintedEvents('[{"recordId":1651,"printer":"kf-direkt","document":"Skriv ut dokument"}]');
  assert.equal(newestPrintedEventId(events), 1651);
  assert.equal(hasNewPrintedEvent(events, 1650, 'KF-DIREKT'), true);
  assert.equal(hasNewPrintedEvent(events, 1651, 'kf-direkt'), false);
  assert.equal(hasNewPrintedEvent(events, 1650, 'SecurePrint'), false);
});

test('Windows spool confirmation waits for a matching event', async () => {
  let calls = 0;
  await confirmWindowsSpool({
    printerName: 'kf-direkt', baseline: 1651, attempts: 2,
    query: async () => {
      calls += 1;
      return calls === 1 ? [] : [{ recordId: 1652, printer: 'kf-direkt' }];
    },
    wait: async () => {}
  });
  assert.equal(calls, 2);
});

test('Windows spool confirmation fails closed if nothing reaches the selected queue', async () => {
  await assert.rejects(confirmWindowsSpool({
    printerName: 'kf-direkt', baseline: 1651, attempts: 2,
    query: async () => [{ recordId: 1652, printer: 'SecurePrint' }],
    wait: async () => {}
  }), /did not confirm a completed spool job/);
});
