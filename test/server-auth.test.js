import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { tmpdir } from 'node:os';

import { loadConfig, projectRoot } from '../src/config.js';
import { createRequestHandler } from '../src/server.js';

async function createAuthHandler(t) {
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
    VISIBLE_DOCUMENT_TYPES: 'packingSlip,attachment'
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
