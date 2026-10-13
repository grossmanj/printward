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

test('pickup dashboard exposes print readiness and only creates non-cash slip jobs', async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'printward-pickup-test-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, 'orders.json');
  const contexts = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'mock-order-context.json'), 'utf8'));
  const pickup = contexts.find((context) => context.orderNumber === '1001');
  const courier = contexts.find((context) => context.orderNumber === '1002');
  const taxi = contexts.find((context) => context.orderNumber === '1004');
  pickup.deliveryMethod = 6;
  pickup.orderPaymentTerm = 2;
  courier.deliveryMethod = 16;
  courier.deliveryDate = '2026-06-25';
  courier.orderPaymentTerm = 1;
  taxi.deliveryMethod = 44;
  taxi.orderPaymentTerm = 2;
  await fs.writeFile(fixturePath, JSON.stringify(contexts));

  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    MOCK_ORDER_CONTEXT: fixturePath
  });
  const pickupResponse = await request(handler, '/api/pickups?deliveryDate=2026-06-25');
  assert.equal(pickupResponse.status, 200);
  const { pickups } = await pickupResponse.json();
  assert.equal(pickups.find((item) => item.orderNumber === '1001').ready, true);
  assert.equal(pickups.find((item) => item.orderNumber === '1002').cashInvoiceRequired, true);
  assert.equal(pickups.find((item) => item.orderNumber === '1002').ready, false);
  assert.equal(pickups.find((item) => item.orderNumber === '1004').ready, true);

  const body = (orderNumbers, panelId = 'pickups') => JSON.stringify({
    kind: 'pickup', panelId, deliveryDate: '2026-06-25', orderNumbers
  });
  const cash = await request(handler, '/api/dashboard/print-jobs', { method: 'POST', body: body(['1002']) });
  assert.equal(cash.status, 409);
  assert.match((await cash.json()).errors[0], /invoice form 365/);
  const unrelated = await request(handler, '/api/dashboard/print-jobs', { method: 'POST', body: body(['1001'], 'staff') });
  assert.equal(unrelated.status, 409);
  const created = await request(handler, '/api/dashboard/print-jobs', { method: 'POST', body: body(['1001', '1004']) });
  assert.equal(created.status, 201);
  const { manifest, job } = await created.json();
  assert.deepEqual(manifest.orders.map((order) => order.documents.map((document) => document.type)), [
    ['packingSlip', 'attachment'], ['packingSlip', 'attachment']
  ]);
  assert.equal(job.notes, 'Dashboard pickup: pickups (2026-06-25)');
});

test('own-car manifest captures the current order registration and fails closed for an unknown slip form', async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'printward-route-stamp-test-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, 'orders.json');
  const contexts = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'mock-order-context.json'), 'utf8'));
  const order = contexts.find((context) => context.orderNumber === '1001');
  assert.ok(order);
  order.deliveryMethodName = 'UEJ 64A';
  await fs.writeFile(fixturePath, JSON.stringify(contexts));

  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false',
    PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    MOCK_ORDER_CONTEXT: fixturePath
  });
  const created = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST', body: JSON.stringify({
      kind: 'dispatch', panelId: 'early', deliveryDate: '2026-06-25', orderNumbers: ['1001']
    })
  });
  assert.equal(created.status, 201);
  const { manifest } = await created.json();
  const slip = manifest.orders[0].documents.find((document) => document.type === 'packingSlip');
  const attachment = manifest.orders[0].documents.find((document) => document.type === 'attachment');
  assert.equal(slip.routeRegistration, 'UEJ 64A');
  assert.equal(attachment.routeRegistration, undefined);

  const printable = await request(handler, slip.url);
  assert.equal(printable.status, 500);
  assert.match((await printable.json()).error, /not a verified Visma form/);
  const withoutVersion = new URL(slip.url);
  withoutVersion.searchParams.delete('generation');
  if (slip.generation) {
    const changedVersion = await request(handler, withoutVersion.toString());
    assert.equal(changedVersion.status, 409);
  }
  const preview = await request(handler, `/api/documents?name=${encodeURIComponent(slip.name)}&source=primary`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
});

test('cash-payment order cannot create a packing-slip job through dashboard or legacy printing', async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'printward-cash-order-test-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, 'orders.json');
  const contexts = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'mock-order-context.json'), 'utf8'));
  const cashOrder = contexts.find((context) => context.orderNumber === '1001');
  assert.ok(cashOrder);
  cashOrder.orderPaymentTerm = 1;
  await fs.writeFile(fixturePath, JSON.stringify(contexts));

  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false',
    PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    PRINTWARD_LEGACY_PRINT_ENABLED: 'true',
    MOCK_ORDER_CONTEXT: fixturePath
  });
  const dashboard = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'dispatch', panelId: 'early', deliveryDate: '2026-06-25', orderNumbers: ['1001'] })
  });
  assert.equal(dashboard.status, 409);
  assert.match(JSON.stringify(await dashboard.json()), /requires Visma invoice/);

  const legacy = await request(handler, '/api/print-jobs', {
    method: 'POST',
    body: JSON.stringify({ deliveryDate: '2026-06-25', orderNumbers: ['1001'], documentTypes: ['packingSlip', 'attachment'] })
  });
  assert.equal(legacy.status, 409);
  assert.match((await legacy.json()).error, /Cash-payment orders require a Visma invoice/);
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
    'frozen-freight-packet', 'cooling-freight-packet'
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
    ['freight', undefined], ['freight', 4]
  ]);
  assert.equal(dsvPayload.manifest.orders[0].sectionType, 'cooling-dsv-packet');
  assert.equal(dsvPayload.manifest.orders[0].documents[1].copyMode, 'perDocument');
  assert.match(dsvPayload.manifest.orders[0].documents[1].url, /copyMode=perDocument/);
});

test('bulk freight job skips missing documents without weakening selected-order printing', async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'printward-freight-bulk-test-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, 'orders.json');
  const contexts = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'mock-order-context.json'), 'utf8'));
  const good = contexts.find((context) => context.orderNumber === '900001');
  assert.ok(good);
  contexts.push({ ...good, orderNumber: '900006', customerName: 'Saknar fraktdokument' });
  await fs.writeFile(fixturePath, JSON.stringify(contexts));
  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false',
    PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    PRINTWARD_LEGACY_PRINT_ENABLED: 'false',
    VISIBLE_DOCUMENT_TYPES: 'pallet,packingSlip,attachment,freight',
    MOCK_ORDER_CONTEXT: fixturePath
  });
  const selection = {
    kind: 'freight', panelId: 'kyl-and-frys', deliveryDate: '2026-06-24',
    orderNumbers: ['900001', '900006']
  };

  const strict = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST', body: JSON.stringify(selection)
  });
  assert.equal(strict.status, 409);

  const bulk = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST', body: JSON.stringify({ ...selection, bulkFreight: true })
  });
  assert.equal(bulk.status, 201);
  const payload = await bulk.json();
  assert.deepEqual(new Set(payload.manifest.orders.map((order) => order.orderNumber)), new Set(['900001']));
  assert.deepEqual(payload.skipped.map((item) => item.orderNumber), ['900006']);
  assert.match(payload.skipped[0].reason, /no available freight document/);

  const none = await request(handler, '/api/dashboard/print-jobs', {
    method: 'POST', body: JSON.stringify({ ...selection, orderNumbers: ['900006'], bulkFreight: true })
  });
  assert.equal(none.status, 409);
  assert.deepEqual((await none.json()).skipped.map((item) => item.orderNumber), ['900006']);
});

test('selected Kyl orders can be registered as already printed without creating a job', async (t) => {
  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    VISIBLE_DOCUMENT_TYPES: 'pallet,packingSlip,attachment,freight'
  });
  const endpoint = '/api/dashboard/freight?deliveryDate=2026-06-24&refresh=1';
  const before = await (await request(handler, endpoint)).json();
  const panel = before.panels['kyl-and-frys'];
  const item = panel.orders.find(({ order }) => order.orderNumber === '900001');
  assert.ok(item?.documentReady);
  const document = item.order.documents[item.documentType];
  const body = JSON.stringify({ deliveryDate: '2026-06-24', panelId: 'kyl-and-frys',
    orderNumbers: ['900001'], user: 'Edmark', documentVersions: {
      '900001': { name: document.name, source: document.source, generation: document.generation,
        updated: document.updated }
    } });
  const marked = await request(handler, '/api/dashboard/freight-mark-printed', { method: 'POST', body });
  assert.equal(marked.status, 200);
  assert.deepEqual((await marked.json()).marked, ['900001']);
  const after = await (await request(handler, endpoint)).json();
  assert.equal(after.panels['kyl-and-frys'].printed, panel.printed + 1);
  const updated = after.panels['kyl-and-frys'].orders.find(({ order }) => order.orderNumber === '900001');
  assert.equal(updated.printStatus, 'printed');
  const jobs = await (await request(handler, '/api/print-jobs')).json();
  assert.deepEqual(jobs.jobs, []);
  const repeated = await request(handler, '/api/dashboard/freight-mark-printed', { method: 'POST', body });
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).alreadyPrinted, ['900001']);
});

test('manual freight status rejects stale, missing and unauthorized selections', async (t) => {
  const enabled = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    VISIBLE_DOCUMENT_TYPES: 'pallet,packingSlip,attachment,freight'
  });
  const endpoint = '/api/dashboard/freight-mark-printed';
  const base = { deliveryDate: '2026-06-24', panelId: 'kyl-and-frys', orderNumbers: ['900001'] };
  const stale = await request(enabled, endpoint, { method: 'POST',
    body: JSON.stringify({ ...base, documentVersions: { '900001': { name: 'wrong.pdf' } } }) });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed/);
  const missing = await request(enabled, endpoint, { method: 'POST',
    body: JSON.stringify({ ...base, documentVersions: {} }) });
  assert.equal(missing.status, 409);
  const wrongPanel = await request(enabled, endpoint, { method: 'POST',
    body: JSON.stringify({ ...base, panelId: 'dsv-finland' }) });
  assert.equal(wrongPanel.status, 400);

  const readOnly = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_READ_ONLY: 'true', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true'
  });
  assert.equal((await request(readOnly, endpoint, { method: 'POST', body: JSON.stringify(base) })).status, 403);
  const loginRequired = await createAuthHandler(t, { PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true' });
  assert.equal((await request(loginRequired, endpoint, { method: 'POST', body: JSON.stringify(base) })).status, 401);
});

test('Kyl manual status accepts an existing PDF even without a booking number', async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'printward-manual-no-booking-test-'));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDir, 'orders.json');
  const contexts = JSON.parse(await fs.readFile(path.join(projectRoot, 'data', 'mock-order-context.json'), 'utf8'));
  const context = contexts.find((item) => item.orderNumber === '900001');
  context.freightConsignmentFresh = '';
  context.freightConsignmentFrozen = '';
  context.freightConsignmentNumbers = [];
  await fs.writeFile(fixturePath, JSON.stringify(contexts));
  const handler = await createAuthHandler(t, {
    PRINTWARD_AUTH_ENABLED: 'false', PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true',
    VISIBLE_DOCUMENT_TYPES: 'pallet,packingSlip,attachment,freight', MOCK_ORDER_CONTEXT: fixturePath
  });
  const before = await (await request(handler, '/api/dashboard/freight?deliveryDate=2026-06-24')).json();
  const item = before.panels['kyl-and-frys'].orders.find(({ order }) => order.orderNumber === '900001');
  assert.equal(item.bookings.length, 0);
  const document = item.order.documents.pallet;
  const marked = await request(handler, '/api/dashboard/freight-mark-printed', { method: 'POST',
    body: JSON.stringify({ deliveryDate: '2026-06-24', panelId: 'kyl-and-frys', orderNumbers: ['900001'],
      documentVersions: { '900001': { name: document.name, source: document.source,
        generation: document.generation, updated: document.updated } } }) });
  assert.equal(marked.status, 200);
  assert.equal((await marked.json()).count, 1);
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

test('agent progress needs the job token and a failed dashboard packet can resume its original snapshot once', async (t) => {
  const handler = await createAuthHandler(t, { PRINTWARD_DASHBOARD_PRINT_ENABLED: 'true' });
  const login = await request(handler, '/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password: 'secret' })
  });
  const cookie = login.headers.get('set-cookie');
  const createdResponse = await request(handler, '/api/print-jobs', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ orderNumbers: ['1001', '1002'], documentTypes: ['packingSlip'], notes: 'Dashboard dispatch' })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const progressPath = `/api/print-jobs/${created.job.id}/progress`;
  assert.equal((await request(handler, progressPath)).status, 401);
  assert.equal((await request(handler, progressPath, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sectionIndex: 0, orderNumber: '1001', spoolConfirmed: true })
  })).status, 401);
  const progressUrl = new URL(created.manifest.progressUrl);
  const accepted = await request(handler, progressUrl.toString(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sectionIndex: 0, orderNumber: '1001', spoolConfirmed: true })
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).progress.completedOrders, 1);
  const stopped = await request(handler, created.manifest.callbackUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'failed', error: 'Paper jam' })
  });
  assert.equal(stopped.status, 200);
  const resume = await request(handler, `/api/print-jobs/${created.job.id}/resume`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(resume.status, 201);
  const resumed = await resume.json();
  assert.deepEqual(resumed.confirmedOrderNumbers, ['1001']);
  assert.deepEqual(resumed.remainingOrderNumbers, ['1002']);
  assert.deepEqual(resumed.job.orders.map((section) => section.orderNumber), ['1002']);
  assert.deepEqual(resumed.job.orders[0].documents, created.job.orders[1].documents);
  const again = await request(handler, `/api/print-jobs/${created.job.id}/resume`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(again.status, 409);
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
