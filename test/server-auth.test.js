import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

import { loadConfig, projectRoot } from '../src/config.js';
import { createRequestHandler } from '../src/server.js';

async function createAuthHandler(t, envOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'printward-auth-test-'));
  const config = loadConfig({
    PRINTWARD_AUTH_ENABLED: 'true',
    PRINTWARD_LOGIN_USER: 'operator',
    PRINTWARD_LOGIN_PASSWORD: 'secret',
    PRINTWARD_SESSION_SECRET: 'session-secret',
    GCS_MODE: 'mock',
    ORDER_CONTEXT_MODE: 'mock',
    MOCK_GCS_OBJECTS: path.join(projectRoot, 'data', 'mock-gcs-objects.json'),
    MOCK_ORDER_CONTEXT: path.join(projectRoot, 'data', 'mock-order-context.json'),
    DATA_FILE: path.join(dir, 'state.json'),
    ORDERS_CACHE_WARMUP: 'false',
    REQUIRED_DOCUMENT_TYPES: 'packingSlip,attachment',
    VISIBLE_DOCUMENT_TYPES: 'packingSlip,attachment',
    ...envOverrides
  });
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  return createRequestHandler(config);
}

async function request(handler, pathOrUrl, options = {}) {
  const url = new URL(pathOrUrl, 'http://127.0.0.1');
  const body = options.body === undefined || options.body === null
    ? null
    : Buffer.from(String(options.body));

  const req = Readable.from(body ? [body] : []);
  req.method = options.method || 'GET';
  req.url = `${url.pathname}${url.search}`;
  req.headers = {
    host: url.host,
    ...(options.headers || {})
  };
  if (body) req.headers['content-length'] = String(body.length);

  const headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 200;
  res.req = req;
  res.writeHead = (statusCode, headerMap = {}) => {
    res.statusCode = statusCode;
    for (const [name, value] of Object.entries(headerMap)) {
      headers[name.toLowerCase()] = value;
    }
    return res;
  };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Writable.prototype.end.call(res);
  };

  await handler(req, res);
  const responseBody = Buffer.concat(chunks);
  return {
    status: res.statusCode,
    bytes: responseBody,
    headers: {
      get(name) {
        const value = headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value || null;
      }
    },
    json: async () => JSON.parse(responseBody.toString('utf8') || '{}'),
    text: async () => responseBody.toString('utf8')
  };
}

test('large JSON responses use gzip only when the client accepts it', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_AUTH_ENABLED: 'false' });
  const endpoint = '/api/orders?deliveryDate=2026-06-24';
  const plain = await request(handler, endpoint);
  const compressed = await request(handler, endpoint, { headers: { 'accept-encoding': 'gzip, deflate' } });
  const declined = await request(handler, endpoint, { headers: { 'accept-encoding': 'gzip;q=0, deflate' } });

  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.ok(compressed.bytes.length < plain.bytes.length);
  assert.deepEqual(JSON.parse(gunzipSync(compressed.bytes)), await plain.json());
  assert.equal(declined.headers.get('content-encoding'), null);
  assert.equal(declined.bytes.toString('utf8'), plain.bytes.toString('utf8'));
});

test('dashboard static assets are compressed for gzip-capable browsers', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_AUTH_ENABLED: 'false' });
  const plain = await request(handler, '/printward-dashboard.js');
  const compressed = await request(handler, '/printward-dashboard.js', {
    headers: { 'accept-encoding': 'gzip, deflate' }
  });

  assert.equal(plain.status, 200);
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.ok(compressed.bytes.length < plain.bytes.length);
  assert.deepEqual(gunzipSync(compressed.bytes), plain.bytes);
});

test('dashboard print endpoint requires an explicit feature flag and a fresh eligible group', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_AUTH_ENABLED: 'false' });
  const body = JSON.stringify({
    kind: 'dispatch', panelId: 'early', deliveryDate: '2026-06-25', orderNumbers: ['1001']
  });
  const blocked = await request(handler, '/api/dashboard/print-jobs', { method: 'POST', body });
  assert.equal(blocked.status, 403);

  const enabled = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true', PRINTWARD_LEGACY_PRINT_ENABLED: 'false'
  });
  const legacy = await request(enabled, '/api/print-jobs', { method: 'POST', body });
  assert.equal(legacy.status, 403);
  const wrongGroup = await request(enabled, '/api/dashboard/print-jobs', {
    method: 'POST', body: JSON.stringify({
      kind: 'freight', panelId: 'best-transport', deliveryDate: '2026-06-25', orderNumbers: ['1001']
    })
  });
  assert.equal(wrongGroup.status, 409);

  const created = await request(enabled, '/api/dashboard/print-jobs', { method: 'POST', body });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.deepEqual(payload.manifest.orders.map((order) => order.documents.map((document) => document.type)), [
    ['packingSlip', 'attachment']
  ]);
  assert.equal(payload.job.notes, 'Dashboard dispatch: early (2026-06-25)');
});

test('dashboard freight print job contains only verified Kyl sections', async (t) => {
  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false',
    PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    PRINTWARD_LEGACY_PRINT_ENABLED: 'false',
    VISIBLE_DOCUMENT_TYPES: 'pallet,packingSlip,attachment,freight'
  });
  const response = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'freight', panelId: 'kyl-and-frys',
      deliveryDate: '2026-06-24', orderNumbers: ['900001']
    })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.deepEqual(payload.manifest.orders.map((section) => section.sectionType), [
    'kyl-freight-packet'
  ]);
  assert.ok(payload.manifest.orders.every((section) => section.documents.every((document) => document.type === 'pallet')));

  const dsv = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'freight', panelId: 'dsv-finland',
      deliveryDate: '2026-06-24', orderNumbers: ['900004']
    })
  });
  assert.equal(dsv.status, 201);
  const dsvPayload = await dsv.json();
  assert.deepEqual(dsvPayload.manifest.orders[0].documents.map((document) => [document.type, document.pageCopies]), [
    ['freight', 4]
  ]);
});

async function openEventStream(handler, pathOrUrl, options = {}) {
  const url = new URL(pathOrUrl, 'http://127.0.0.1');
  const req = new Readable({
    read() {}
  });
  req.method = options.method || 'GET';
  req.url = `${url.pathname}${url.search}`;
  req.headers = {
    host: url.host,
    accept: 'text/event-stream',
    ...(options.headers || {})
  };

  const headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 200;
  res.writeHead = (statusCode, headerMap = {}) => {
    res.statusCode = statusCode;
    for (const [name, value] of Object.entries(headerMap)) {
      headers[name.toLowerCase()] = value;
    }
    return res;
  };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Writable.prototype.end.call(res);
  };

  await handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    status: res.statusCode,
    headers: {
      get(name) {
        const value = headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value || null;
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    close() {
      req.destroy();
      res.destroy();
    }
  };
}

async function waitForText(stream, text, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (stream.text().includes(text)) return stream.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for event stream text: ${text}`);
}

test('auth blocks app/API until login succeeds', async (t) => {
  const handler = await createAuthHandler(t);

  const root = await request(handler, '/');
  assert.equal(root.status, 303);
  assert.equal(root.headers.get('location'), '/login');

  const health = await request(handler, '/api/health');
  assert.equal(health.status, 401);

  const css = await request(handler, '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');

  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /printward_session=/);

  const authedHealth = await request(handler, '/api/health', {
    headers: { cookie }
  });
  assert.equal(authedHealth.status, 200);
});

test('demo login and root land on the dashboard without changing the default home', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_LOGIN_LANDING_PAGE: 'dashboard' });
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/printward-dashboard.html');

  const cookie = login.headers.get('set-cookie');
  const root = await request(handler, '/', { headers: { cookie } });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get('location'), '/printward-dashboard.html');

  const dashboard = await request(handler, '/printward-dashboard.html', { headers: { cookie } });
  assert.equal(dashboard.status, 200);
});

test('read-only service blocks print jobs but permits freight preflight', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_READ_ONLY: 'true' });
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');
  assert.equal(login.status, 303);

  const health = await request(handler, '/api/health', { headers: { cookie } });
  assert.equal((await health.json()).readOnly, true);

  for (const endpoint of ['/api/defaults', '/api/print-jobs', '/api/print-jobs/anything/retry', '/api/print-jobs/anything/complete']) {
    const response = await request(handler, endpoint, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 403, endpoint);
  }

  const freightPlan = await request(handler, '/api/dashboard/freight-plan', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(freightPlan.status, 400);
});

test('job token allows local agent to fetch only documents in that print job', async (t) => {
  const handler = await createAuthHandler(t);
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');

  const createJob = await request(handler, '/api/print-jobs', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      user: 'operator',
      orderNumbers: ['1001'],
      documentTypes: ['packingSlip']
    })
  });
  assert.equal(createJob.status, 201);

  const payload = await createJob.json();
  const documentUrl = payload.manifest.orders[0].documents[0].url;
  assert.match(documentUrl, /jobId=/);
  assert.match(documentUrl, /token=/);

  const document = await request(handler, documentUrl);
  assert.equal(document.status, 200);
  assert.match(document.headers.get('content-type'), /application\/pdf/);

  const tampered = new URL(documentUrl);
  tampered.searchParams.set('token', 'bad-token');
  const invalidToken = await request(handler, tampered.toString());
  assert.equal(invalidToken.status, 401);

  const otherDocument = new URL(documentUrl);
  otherDocument.searchParams.set('name', 'parti1001.pdf');
  const outsideJob = await request(handler, otherDocument.toString());
  assert.equal(outsideJob.status, 401);
});

test('print job history lists jobs and can create exact retry packets', async (t) => {
  const handler = await createAuthHandler(t);
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');

  const createJob = await request(handler, '/api/print-jobs', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      user: 'operator',
      orderNumbers: ['1001'],
      documentTypes: ['packingSlip'],
      printerName: 'Office Printer',
      options: {
        printerName: 'Office Printer',
        copies: 1,
        staple: true
      }
    })
  });
  assert.equal(createJob.status, 201);

  const created = await createJob.json();
  assert.deepEqual(created.job.orders[0].documents.map((document) => document.type), ['packingSlip', 'attachment']);
  assert.match(created.manifest.orders[0].documents[0].url, /generation=1001001/);

  const completeJob = await request(handler, `/api/print-jobs/${created.job.id}/complete`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      status: 'printed',
      user: 'operator',
      printerName: 'Office Printer'
    })
  });
  assert.equal(completeJob.status, 200);

  const history = await request(handler, '/api/print-jobs?limit=5', {
    headers: { cookie }
  });
  assert.equal(history.status, 200);
  const historyPayload = await history.json();
  assert.equal(historyPayload.jobs[0].id, created.job.id);
  assert.equal(historyPayload.jobs[0].status, 'printed');
  assert.deepEqual(historyPayload.jobs[0].orderNumbers, ['1001']);
  assert.equal(historyPayload.jobs[0].documentCount, 2);
  assert.equal(historyPayload.jobs[0].changes.hasChanges, false);

  const retryJob = await request(handler, `/api/print-jobs/${created.job.id}/retry`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      user: 'operator',
      printerName: 'Office Printer'
    })
  });
  assert.equal(retryJob.status, 201);
  const retryPayload = await retryJob.json();
  assert.notEqual(retryPayload.job.id, created.job.id);
  assert.deepEqual(retryPayload.job.orders[0].documents.map((document) => document.type), ['packingSlip', 'attachment']);
  assert.equal(retryPayload.job.orders[0].documents[0].generation, '1001001');
  assert.match(retryPayload.manifest.orders[0].documents[0].url, /generation=1001001/);
});

test('combo print jobs include generated delivery method separator pages', async (t) => {
  const handler = await createAuthHandler(t);
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');

  const createJob = await request(handler, '/api/print-jobs', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      user: 'operator',
      orderNumbers: ['1001', '1004'],
      deliveryDate: '2026-06-25',
      documentTypes: ['packingSlip', 'attachment'],
      includeComboSeparators: true
    })
  });
  assert.equal(createJob.status, 201);

  const payload = await createJob.json();
  assert.equal(payload.manifest.orders.length, 4);
  assert.equal(payload.manifest.orders[0].isSeparator, true);
  assert.equal(payload.manifest.orders[0].separatorLabel, 'Truck 12 Stockholm');
  assert.equal(payload.manifest.orders[0].documents[0].source, 'generated');
  assert.equal(payload.manifest.orders[0].documents[0].type, 'comboSeparator');
  assert.match(payload.manifest.orders[0].documents[0].url, /source=generated/);
  assert.equal(payload.manifest.orders[1].orderNumber, '1001');
  assert.equal(payload.manifest.orders[2].isSeparator, true);
  assert.equal(payload.manifest.orders[2].separatorLabel, 'Goteborg truck 31');
  assert.equal(payload.manifest.orders[3].orderNumber, '1004');

  const separator = await request(handler, payload.manifest.orders[0].documents[0].url);
  assert.equal(separator.status, 200);
  assert.match(separator.headers.get('content-type'), /application\/pdf/);

  const completeJob = await request(handler, `/api/print-jobs/${payload.job.id}/complete`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      status: 'printed',
      user: 'operator',
      printerName: 'Office Printer'
    })
  });
  assert.equal(completeJob.status, 200);

  const history = await request(handler, '/api/print-jobs?limit=1', {
    headers: { cookie }
  });
  assert.equal(history.status, 200);
  const historyPayload = await history.json();
  assert.deepEqual(historyPayload.jobs[0].orderNumbers, ['1001', '1004']);
  assert.equal(historyPayload.jobs[0].orderCount, 2);
  assert.equal(historyPayload.jobs[0].documentCount, 4);
});

test('print job events stream broadcasts job changes', async (t) => {
  const handler = await createAuthHandler(t);
  const login = await request(handler, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');

  const stream = await openEventStream(handler, '/api/events', {
    headers: { cookie }
  });
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  assert.match(stream.text(), /connected/);

  const createJob = await request(handler, '/api/print-jobs', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      user: 'operator',
      orderNumbers: ['1001'],
      documentTypes: ['packingSlip']
    })
  });
  assert.equal(createJob.status, 201);
  const created = await createJob.json();

  const createdText = await waitForText(stream, 'print-job-created');
  assert.match(createdText, new RegExp(created.job.id));

  const completeJob = await request(handler, `/api/print-jobs/${created.job.id}/complete`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      status: 'printed',
      user: 'operator',
      printerName: 'Office Printer'
    })
  });
  assert.equal(completeJob.status, 200);

  const completedText = await waitForText(stream, 'print-job-completed');
  assert.match(completedText, new RegExp(created.job.id));
});
