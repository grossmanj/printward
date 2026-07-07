import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { loadConfig } from './config.js';
import { createStorageClient } from './gcsClient.js';
import { attachOrderContexts, createOrderContextClient } from './orderContext.js';
import { createCenteredTextPdf, repeatPdfPages } from './pdf.js';
import {
  DOCUMENT_ORDER,
  DOCUMENT_TYPES,
  applyDocumentRequirements,
  buildOrders,
  filterOrders,
  orderToPrintSnapshot,
  summarizeDispatchCombos,
  summarizeOrders
} from './documents.js';
import { buildPrintIndex, createStateStore } from './stateStore.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function visibleDocumentTypes(config) {
  const visibleKeys = (config.documentTypes.visible || DOCUMENT_ORDER)
    .filter((type) => DOCUMENT_ORDER.includes(type));
  const visible = new Set(visibleKeys.length > 0 ? visibleKeys : DOCUMENT_ORDER);
  return Object.fromEntries(
    Object.entries(DOCUMENT_TYPES).filter(([key]) => visible.has(key))
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendHtml(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, {
    error: error.message || 'Unexpected error'
  });
}

function createEventHub() {
  const clients = new Set();
  let nextId = 0;

  function remove(client) {
    if (!clients.delete(client)) return;
    clearInterval(client.heartbeat);
  }

  function write(client, message) {
    try {
      client.res.write(message);
      return true;
    } catch {
      remove(client);
      return false;
    }
  }

  return {
    add(req, res) {
      const client = { res, heartbeat: null };
      clients.add(client);
      write(client, ': connected\n\n');
      client.heartbeat = setInterval(() => {
        write(client, `: keep-alive ${new Date().toISOString()}\n\n`);
      }, 25_000);
      client.heartbeat.unref?.();

      const cleanup = () => remove(client);
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      return client;
    },
    broadcast(type, payload = {}) {
      const id = String(++nextId);
      const data = JSON.stringify({
        id,
        type,
        at: new Date().toISOString(),
        ...payload
      });
      const message = `id: ${id}\nevent: printward\ndata: ${data}\n\n`;
      for (const client of [...clients]) write(client, message);
    },
    count() {
      return clients.size;
    }
  };
}

async function readBodyText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const text = await readBodyText(req);
  if (!text) return {};
  return JSON.parse(text);
}

function getOrigin(req) {
  const host = req.headers.host || '127.0.0.1';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${host}`;
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signValue(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookies(req) {
  const cookies = new Map();
  for (const item of String(req.headers.cookie || '').split(';')) {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join('=') || ''));
  }
  return cookies;
}

function createSessionToken(auth) {
  const payload = Buffer.from(JSON.stringify({
    user: auth.username,
    exp: Math.floor(Date.now() / 1000) + auth.maxAgeSeconds
  })).toString('base64url');
  return `${payload}.${signValue(payload, auth.sessionSecret)}`;
}

function verifySessionToken(token, auth) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return false;
  if (!safeEqual(signature, signValue(payload, auth.sessionSecret))) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.user === auth.username && Number(session.exp || 0) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isAuthenticatedRequest(req, auth) {
  if (!auth?.enabled) return true;
  return verifySessionToken(parseCookies(req).get(auth.cookieName), auth);
}

function cookieAttributes(req, auth, expires = false) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https';
  const maxAge = expires ? 0 : auth.maxAgeSeconds;
  return [
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    isHttps ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

function sessionCookie(req, auth) {
  return `${auth.cookieName}=${encodeURIComponent(createSessionToken(auth))}; ${cookieAttributes(req, auth)}`;
}

function expiredSessionCookie(req, auth) {
  return `${auth.cookieName}=; ${cookieAttributes(req, auth, true)}`;
}

function loginPage(auth, error = '') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Printward Login</title>
    <style>
      :root { color-scheme: light; --text: #14212a; --muted: #5c6d77; --line: #ccd8de; --primary: #0f6b6f; --bg: #edf2f4; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(180deg, #e5eef0 0, var(--bg) 260px); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(380px, calc(100vw - 32px)); background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 14px 34px rgba(20, 33, 42, 0.09); padding: 24px; }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
      .mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 8px; background: var(--primary); color: #fff; font-weight: 800; }
      h1 { margin: 0; font-size: 20px; line-height: 1.1; }
      label { display: grid; gap: 7px; margin-top: 14px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      input { min-height: 40px; border: 1px solid var(--line); border-radius: 7px; color: var(--text); font: inherit; padding: 8px 10px; }
      input:focus { border-color: var(--primary); outline: 3px solid rgba(17, 109, 110, 0.15); }
      button { width: 100%; min-height: 42px; margin-top: 18px; border: 1px solid var(--primary); border-radius: 7px; background: var(--primary); color: #fff; cursor: pointer; font: inherit; font-weight: 800; }
      .error { margin: 0 0 14px; padding: 10px 12px; border: 1px solid rgba(180, 35, 24, 0.22); border-radius: 7px; background: rgba(180, 35, 24, 0.08); color: #b42318; font-size: 13px; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><span class="mark">P</span><h1>Printward</h1></div>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/login">
        <label>Username <input name="username" autocomplete="username" value="${escapeHtml(auth.username)}" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" autofocus required></label>
        <button type="submit">Log in</button>
      </form>
    </main>
  </body>
</html>`;
}

function wantsJson(req, requestUrl) {
  return requestUrl.pathname.startsWith('/api/') || String(req.headers.accept || '').includes('application/json');
}

function redirectToLogin(res) {
  res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
  res.end();
}

async function handleAuthRoute(req, res, requestUrl, auth) {
  if (requestUrl.pathname === '/logout') {
    res.writeHead(303, {
      location: '/login',
      'set-cookie': expiredSessionCookie(req, auth),
      'cache-control': 'no-store'
    });
    res.end();
    return true;
  }

  if (requestUrl.pathname !== '/login') return false;

  if (req.method === 'GET') {
    if (isAuthenticatedRequest(req, auth)) {
      res.writeHead(303, { location: '/', 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    sendHtml(res, 200, loginPage(auth, requestUrl.searchParams.get('error') ? 'Invalid username or password.' : ''));
    return true;
  }

  if (req.method === 'POST') {
    const form = new URLSearchParams(await readBodyText(req));
    const username = form.get('username') || '';
    const password = form.get('password') || '';
    if (safeEqual(username, auth.username) && safeEqual(password, auth.password)) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': sessionCookie(req, auth),
        'cache-control': 'no-store'
      });
      res.end();
      return true;
    }

    res.writeHead(303, { location: '/login?error=1', 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
  return true;
}

function isPrintCompletionCallback(requestUrl) {
  return /^\/api\/print-jobs\/[^/]+\/complete$/.test(requestUrl.pathname)
    && Boolean(requestUrl.searchParams.get('token'));
}

function isPrintJobDocumentRequest(requestUrl) {
  return requestUrl.pathname === '/api/documents'
    && Boolean(requestUrl.searchParams.get('jobId'))
    && Boolean(requestUrl.searchParams.get('token'));
}

function isPublicAssetRequest(req, requestUrl) {
  return ['GET', 'HEAD'].includes(req.method || 'GET')
    && !requestUrl.pathname.startsWith('/api/')
    && /\.(css|js|mjs|ico|svg|png|jpe?g|webp|woff2?)$/i.test(requestUrl.pathname);
}

function requireLogin(req, res, requestUrl, auth) {
  if (
    !auth.enabled
    || isAuthenticatedRequest(req, auth)
    || isPublicAssetRequest(req, requestUrl)
    || isPrintCompletionCallback(requestUrl)
    || isPrintJobDocumentRequest(requestUrl)
  ) {
    return false;
  }

  if (wantsJson(req, requestUrl)) {
    sendJson(res, 401, { error: 'Login required.' });
  } else {
    redirectToLogin(res);
  }
  return true;
}

function buildManifest(req, job) {
  const origin = getOrigin(req);
  const callbackToken = job.callbackToken ? `?token=${encodeURIComponent(job.callbackToken)}` : '';
  const documentTokenParams = job.callbackToken
    ? `&jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(job.callbackToken)}`
    : '';
  const documentTransformParams = (document) => {
    const pageCopies = normalizedPageCopies(document.pageCopies);
    return pageCopies > 1
      ? `&copyMode=perPage&pageCopies=${encodeURIComponent(String(pageCopies))}`
      : '';
  };
  const documentVersionParams = (document) => {
    return document.generation ? `&generation=${encodeURIComponent(String(document.generation))}` : '';
  };
  return {
    jobId: job.id,
    callbackUrl: `${origin}/api/print-jobs/${job.id}/complete${callbackToken}`,
    orders: job.orders.map((order) => ({
      ...order,
      documents: order.documents.map((document) => ({
        ...document,
        url: `${origin}/api/documents?name=${encodeURIComponent(document.name)}&source=${encodeURIComponent(document.source || 'primary')}${documentTokenParams}${documentTransformParams(document)}${documentVersionParams(document)}`
      }))
    }))
  };
}

function jobIncludesDocument(job, name, source, generation = '') {
  return (job.orders || []).some((order) => {
    return (order.documents || []).some((document) => {
      return document.name === name
        && (document.source || 'primary') === source
        && (!generation || String(document.generation || '') === String(generation));
    });
  });
}

function isSeparatorOrder(order) {
  return Boolean(order?.isSeparator);
}

function isGeneratedDocument(document) {
  return (document?.source || '') === 'generated' || document?.type === 'comboSeparator';
}

function jobOrderNumbers(job) {
  return (job.orders || [])
    .filter((order) => !isSeparatorOrder(order))
    .map((order) => String(order.orderNumber || '').trim())
    .filter(Boolean);
}

function jobDocumentCount(job) {
  return (job.orders || []).reduce((total, order) => {
    if (isSeparatorOrder(order)) return total;
    return total + (order.documents || []).filter((document) => !isGeneratedDocument(document)).length;
  }, 0);
}

function documentChanged(previous, current) {
  if (!current) return true;
  if (previous.name !== current.name) return true;
  if ((previous.source || 'primary') !== (current.source || 'primary')) return true;
  if (previous.generation && current.generation && String(previous.generation) !== String(current.generation)) return true;
  if (!previous.generation || !current.generation) {
    return Boolean(previous.updated && current.updated && String(previous.updated) !== String(current.updated));
  }
  return false;
}

function summarizeJobChanges(job, currentByOrderNumber) {
  const details = [];

  for (const order of job.orders || []) {
    if (isSeparatorOrder(order)) continue;
    const currentOrder = currentByOrderNumber.get(String(order.orderNumber || ''));
    for (const document of order.documents || []) {
      if (isGeneratedDocument(document)) continue;
      const current = currentOrder?.documents?.[document.type];
      if (!current) {
        details.push({
          orderNumber: order.orderNumber,
          type: document.type,
          typeLabel: document.typeLabel || document.type,
          name: document.name,
          reason: 'missing'
        });
        continue;
      }

      if (!documentChanged(document, current)) continue;
      details.push({
        orderNumber: order.orderNumber,
        type: document.type,
        typeLabel: document.typeLabel || document.type,
        name: document.name,
        currentName: current.name,
        previousGeneration: document.generation || null,
        currentGeneration: current.generation || null,
        previousUpdated: document.updated || null,
        currentUpdated: current.updated || null,
        reason: 'changed'
      });
    }
  }

  return {
    hasChanges: details.length > 0,
    changedDocuments: details.filter((detail) => detail.reason === 'changed').length,
    missingDocuments: details.filter((detail) => detail.reason === 'missing').length,
    changedOrders: new Set(details.map((detail) => String(detail.orderNumber))).size,
    details: details.slice(0, 12)
  };
}

function summarizePrintJob(job, currentByOrderNumber = new Map()) {
  const orderNumbers = jobOrderNumbers(job);
  return {
    id: job.id,
    status: job.status || 'created',
    createdAt: job.createdAt || '',
    updatedAt: job.updatedAt || '',
    completedAt: job.completedAt || '',
    createdBy: job.createdBy || '',
    completedBy: job.completedBy || '',
    printerName: job.printerName || '',
    options: job.options || {},
    notes: job.notes || '',
    error: job.error || '',
    orderNumbers,
    orderCount: orderNumbers.length,
    documentCount: jobDocumentCount(job),
    changes: summarizeJobChanges(job, currentByOrderNumber)
  };
}

function comboKey(order = {}) {
  const context = order.context || {};
  return [
    context.deliveryDate || '',
    context.dispatchTime || '',
    context.deliveryMethodName || context.deliveryMethod || ''
  ].join('|');
}

function comboSeparatorText(order = {}) {
  const context = order.context || {};
  return context.deliveryMethodName || (context.deliveryMethod ? `Method ${context.deliveryMethod}` : 'No delivery method');
}

function safeGeneratedName(value) {
  return String(value || 'combo')
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'combo';
}

function createComboSeparatorSnapshot(order, index) {
  const text = comboSeparatorText(order);
  const orderNumber = `combo-separator-${index}`;
  return {
    orderNumber,
    isSeparator: true,
    separatorLabel: text,
    missingTypes: [],
    documents: [
      {
        name: `generated/combo-separator-${index}-${safeGeneratedName(text)}.pdf`,
        source: 'generated',
        fileName: `combo-${safeGeneratedName(text)}.pdf`,
        type: 'comboSeparator',
        typeLabel: 'Combo separator',
        orderNumber,
        contentType: 'application/pdf',
        generated: {
          kind: 'comboSeparator',
          text
        }
      }
    ]
  };
}

function buildPrintSnapshots(orders, selectedTypes, options = {}) {
  const printableOrders = orders.filter(Boolean);
  if (!options.includeComboSeparators) {
    return printableOrders
      .map((order) => orderToPrintSnapshot(order, selectedTypes))
      .filter((order) => order.documents.length > 0);
  }

  const groups = [];
  const byKey = new Map();
  for (const order of printableOrders) {
    const key = comboKey(order);
    if (!byKey.has(key)) {
      const group = {
        separatorOrder: order,
        orders: []
      };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).orders.push(order);
  }

  const snapshots = [];
  groups.forEach((group, index) => {
    const orderSnapshots = group.orders
      .map((order) => orderToPrintSnapshot(order, selectedTypes))
      .filter((order) => order.documents.length > 0);
    if (orderSnapshots.length === 0) return;
    snapshots.push(createComboSeparatorSnapshot(group.separatorOrder, index + 1));
    snapshots.push(...orderSnapshots);
  });

  return snapshots;
}

function includeRequiredDocumentTypes(selectedTypes, orders) {
  const selected = new Set(selectedTypes);
  for (const order of orders || []) {
    for (const type of order.requiredTypes || []) {
      selected.add(type);
    }
  }
  return DOCUMENT_ORDER.filter((type) => selected.has(type));
}

function findGeneratedDocument(job, name, source = 'generated') {
  for (const order of job.orders || []) {
    for (const document of order.documents || []) {
      if (document.name === name && (document.source || 'primary') === source) return document;
    }
  }
  return null;
}

async function isAuthorizedDocumentRequest(req, requestUrl, config, store) {
  if (!config.auth.enabled || isAuthenticatedRequest(req, config.auth)) return true;

  const jobId = requestUrl.searchParams.get('jobId') || '';
  const token = requestUrl.searchParams.get('token') || '';
  const name = requestUrl.searchParams.get('name') || '';
  const source = requestUrl.searchParams.get('source') || 'primary';
  const generation = requestUrl.searchParams.get('generation') || '';
  const job = jobId ? await store.getJob(jobId) : null;

  return Boolean(
    job
    && job.callbackToken
    && safeEqual(token, job.callbackToken)
    && jobIncludesDocument(job, name, source, generation)
  );
}

function normalizedDocumentTypesForConfig(documentTypes, config) {
  const configuredAllowed = (config.documentTypes.visible || DOCUMENT_ORDER)
    .filter((type) => DOCUMENT_ORDER.includes(type));
  const allowed = configuredAllowed.length > 0 ? configuredAllowed : DOCUMENT_ORDER;
  const requested = Array.isArray(documentTypes) && documentTypes.length > 0
    ? documentTypes
    : allowed;

  const normalized = requested.filter((type) => allowed.includes(type));
  return normalized.length > 0 ? normalized : allowed;
}

function normalizedPageCopies(value) {
  const copies = Math.trunc(Number(value || 1));
  if (!Number.isFinite(copies)) return 1;
  return Math.min(20, Math.max(1, copies));
}

function defaultsForConfig(defaults, config) {
  const documentTypes = normalizedDocumentTypesForConfig(defaults.documentTypes, config);
  return {
    ...defaults,
    documentTypes
  };
}

function createOrdersCache(config) {
  return {
    entries: new Map(),
    cacheMs: Math.max(0, Number(config.ordersCacheMs || 0))
  };
}

function invalidateOrdersCache(cache) {
  if (!cache) return;
  cache.entries.clear();
}

function ordersCacheKey(options = {}) {
  return options.deliveryDate ? `deliveryDate:${options.deliveryDate}` : 'all';
}

function getOrdersCacheEntry(cache, key) {
  if (!cache.entries.has(key)) {
    cache.entries.set(key, {
      value: null,
      expiresAt: 0,
      promise: null
    });
  }
  return cache.entries.get(key);
}

function prefixedObjectName(prefix, fileName) {
  const normalized = String(prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized ? `${normalized}/${fileName}` : fileName;
}

function expectedDocumentLookups(config, orderNumbers) {
  const visible = new Set((config.documentTypes.visible || DOCUMENT_ORDER).filter((type) => DOCUMENT_ORDER.includes(type)));
  const lookups = [];

  for (const orderNumber of orderNumbers) {
    if (visible.has('packingSlip')) {
      lookups.push({
        source: 'primary',
        name: prefixedObjectName(config.gcs.prefix, `order${orderNumber}.pdf`)
      });
    }

    if (visible.has('attachment')) {
      lookups.push({
        source: 'primary',
        name: prefixedObjectName(config.gcs.prefix, `parti${orderNumber}.pdf`)
      });
    }

    if (visible.has('freight') && config.freightGcs?.bucket) {
      lookups.push({
        source: 'freight',
        name: prefixedObjectName(config.freightGcs.prefix, `freight${orderNumber}.pdf`)
      });
    }
  }

  return lookups;
}

function createMissingDocumentOrder(orderNumber) {
  return {
    orderNumber,
    documents: {},
    duplicates: {},
    missingTypes: [],
    latestUpdated: null,
    printableDocumentCount: 0,
    packetStatus: 'missing'
  };
}

function addContextOnlyOrders(orders, contextByOrderNumber) {
  const existing = new Set(orders.map((order) => order.orderNumber));
  const missing = [];

  for (const orderNumber of contextByOrderNumber.keys()) {
    if (!existing.has(orderNumber)) {
      missing.push(createMissingDocumentOrder(orderNumber));
    }
  }

  return missing.length > 0 ? [...orders, ...missing] : orders;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listExpectedObjects(storage, config, orderNumbers) {
  if (typeof storage.getObjectMetadata !== 'function') {
    return storage.listObjects();
  }

  const lookups = expectedDocumentLookups(config, orderNumbers);
  const objects = await mapWithConcurrency(lookups, 50, async (lookup) => {
    const metadata = await storage.getObjectMetadata(lookup.name, lookup.source);
    if (!metadata) return null;
    return {
      name: metadata.name || lookup.name,
      source: lookup.source,
      size: Number(metadata.size || 0),
      updated: metadata.updated || metadata.timeCreated || null,
      generation: metadata.generation ? String(metadata.generation) : null,
      contentType: metadata.contentType || 'application/pdf'
    };
  });

  return objects.filter(Boolean);
}

async function buildDateScopedOrders(storage, store, orderContext, config, deliveryDate) {
  if (!deliveryDate || !orderContext || typeof orderContext.getByDeliveryDate !== 'function') {
    return null;
  }

  const [contextByOrderNumber, state] = await Promise.all([
    orderContext.getByDeliveryDate(deliveryDate),
    store.getState()
  ]);
  const orderNumbers = Array.from(contextByOrderNumber.keys());
  const objects = await listExpectedObjects(storage, config, orderNumbers);
  const orders = buildOrders(objects, buildPrintIndex(state), {
    requiredTypes: config.documentTypes.required || DOCUMENT_ORDER
  });
  const ordersWithContext = attachOrderContexts(addContextOnlyOrders(orders, contextByOrderNumber), contextByOrderNumber);

  return {
    orders: applyDocumentRequirements(ordersWithContext, config.documentTypes.required || DOCUMENT_ORDER),
    contextStatus: { mode: orderContext.mode || 'enabled', available: true }
  };
}

async function buildOrderNumberScopedOrders(storage, store, orderContext, config, orderNumbers) {
  const uniqueOrderNumbers = Array.from(new Set(orderNumbers.map(String).filter(Boolean)));
  const [contextByOrderNumber, state] = await Promise.all([
    orderContext ? orderContext.getByOrderNumbers(uniqueOrderNumbers) : Promise.resolve(new Map()),
    store.getState()
  ]);
  const objects = await listExpectedObjects(storage, config, uniqueOrderNumbers);
  const orders = buildOrders(objects, buildPrintIndex(state), {
    requiredTypes: config.documentTypes.required || DOCUMENT_ORDER
  });
  const ordersWithContext = attachOrderContexts(addContextOnlyOrders(orders, contextByOrderNumber), contextByOrderNumber);

  return {
    orders: applyDocumentRequirements(ordersWithContext, config.documentTypes.required || DOCUMENT_ORDER),
    contextStatus: { mode: orderContext?.mode || 'disabled', available: Boolean(orderContext) }
  };
}

async function buildCurrentOrders(storage, store, orderContext, config, options = {}) {
  if (Array.isArray(options.orderNumbers) && options.orderNumbers.length > 0) {
    return buildOrderNumberScopedOrders(storage, store, orderContext, config, options.orderNumbers);
  }

  if (options.deliveryDate) {
    try {
      const dateScoped = await buildDateScopedOrders(storage, store, orderContext, config, options.deliveryDate);
      if (dateScoped) return dateScoped;
    } catch (error) {
      return {
        orders: [],
        contextStatus: {
          mode: orderContext?.mode || 'enabled',
          available: false,
          error: error.message
        }
      };
    }
  }

  const [objects, state] = await Promise.all([storage.listObjects(), store.getState()]);
  const orders = buildOrders(objects, buildPrintIndex(state), {
    requiredTypes: config.documentTypes.required || DOCUMENT_ORDER
  });

  if (!orderContext) {
    return {
      orders: applyDocumentRequirements(orders, config.documentTypes.required || DOCUMENT_ORDER),
      contextStatus: { mode: 'disabled', available: false }
    };
  }

  try {
    const contextByOrderNumber = await orderContext.getByOrderNumbers(orders.map((order) => order.orderNumber));
    const ordersWithContext = attachOrderContexts(orders, contextByOrderNumber);
    return {
      orders: applyDocumentRequirements(ordersWithContext, config.documentTypes.required || DOCUMENT_ORDER),
      contextStatus: { mode: orderContext.mode || 'enabled', available: true }
    };
  } catch (error) {
    const ordersWithContext = attachOrderContexts(orders, new Map());
    return {
      orders: applyDocumentRequirements(ordersWithContext, config.documentTypes.required || DOCUMENT_ORDER),
      contextStatus: {
        mode: orderContext.mode || 'enabled',
        available: false,
        error: error.message
      }
    };
  }
}

async function refreshOrdersCache(storage, store, orderContext, config, cache, options = {}) {
  const key = ordersCacheKey(options);
  const entry = getOrdersCacheEntry(cache, key);

  if (!entry.promise) {
    entry.promise = buildCurrentOrders(storage, store, orderContext, config, options)
      .then((value) => {
        entry.value = value;
        entry.expiresAt = Date.now() + cache.cacheMs;
        return value;
      })
      .finally(() => {
        entry.promise = null;
      });
  }

  return entry.promise;
}

async function listCurrentOrders(storage, store, orderContext, config, cache, options = {}) {
  if (Array.isArray(options.orderNumbers) && options.orderNumbers.length > 0) {
    return buildCurrentOrders(storage, store, orderContext, config, options);
  }

  if (!cache || cache.cacheMs <= 0) {
    return buildCurrentOrders(storage, store, orderContext, config, options);
  }

  const entry = getOrdersCacheEntry(cache, ordersCacheKey(options));
  const now = Date.now();
  if (!options.refresh && entry.value && entry.expiresAt > now) {
    return entry.value;
  }

  if (!options.refresh && entry.value) {
    refreshOrdersCache(storage, store, orderContext, config, cache, options).catch((error) => {
      console.warn(`Order cache refresh failed: ${error.message}`);
    });
    return entry.value;
  }

  return refreshOrdersCache(storage, store, orderContext, config, cache, options);
}

async function listOrdersForPrintJob(storage, store, orderContext, config, cache, orderNumbers, deliveryDate) {
  const normalizedDeliveryDate = String(deliveryDate || '').trim();
  if (normalizedDeliveryDate) {
    const dateScoped = await listCurrentOrders(storage, store, orderContext, config, cache, {
      deliveryDate: normalizedDeliveryDate
    });
    const byOrderNumber = new Map(dateScoped.orders.map((order) => [order.orderNumber, order]));
    if (orderNumbers.every((orderNumber) => byOrderNumber.has(orderNumber))) {
      return {
        ...dateScoped,
        orders: orderNumbers.map((orderNumber) => byOrderNumber.get(orderNumber))
      };
    }
  }

  return listCurrentOrders(storage, store, orderContext, config, cache, { orderNumbers });
}

function todayInStockholm() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function scheduleOrdersCacheWarmup(storage, store, orderContext, config, cache, attempt = 1, options = {}) {
  const delayMs = attempt === 1 ? 1_000 : Math.min(30_000, attempt * 5_000);
  setTimeout(() => {
    refreshOrdersCache(storage, store, orderContext, config, cache, options)
      .then((snapshot) => {
        console.log(`Order cache warmed for ${ordersCacheKey(options)} with ${snapshot.orders.length} orders.`);
      })
      .catch((error) => {
        if (attempt >= 6) {
          console.warn(`Order cache warmup failed after ${attempt} attempts: ${error.message}`);
          return;
        }
        console.warn(`Order cache warmup attempt ${attempt} failed: ${error.message}`);
        scheduleOrdersCacheWarmup(storage, store, orderContext, config, cache, attempt + 1, options);
      });
  }, delayMs);
}

async function handleApi(req, res, requestUrl, context) {
  const { config, storage, store, orderContext, ordersCache, eventHub } = context;
  const pathname = requestUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      mode: config.gcs.mode,
      bucket: config.gcs.bucket || null,
      prefix: config.gcs.prefix || '',
      freightBucket: config.freightGcs.bucket || null,
      freightPrefix: config.freightGcs.prefix || '',
      storageSources: storage.sources || [],
      stateStore: config.stateStore.mode,
      requiredDocumentTypes: config.documentTypes.required,
      visibleDocumentTypes: config.documentTypes.visible,
      orderContext: await orderContext.health(),
      agentUrl: config.agent.defaultUrl
    });
    return;
  }

  if (pathname === '/api/events') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    eventHub.add(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/orders') {
    const refresh = ['1', 'true'].includes(String(requestUrl.searchParams.get('refresh') || '').toLowerCase());
    const deliveryDate = requestUrl.searchParams.get('deliveryDate') || '';
    const { orders, contextStatus } = await listCurrentOrders(storage, store, orderContext, config, ordersCache, { refresh, deliveryDate });
    const dateFiltered = filterOrders(orders, { deliveryDate });
    const filtered = filterOrders(dateFiltered, {
      q: requestUrl.searchParams.get('q') || '',
      status: requestUrl.searchParams.get('status') || 'all'
    });

    sendJson(res, 200, {
      orders: filtered,
      summary: {
        ...summarizeOrders(dateFiltered, { documentTypes: config.documentTypes.visible }),
        dispatchCombos: summarizeDispatchCombos(dateFiltered)
      },
      contextStatus,
      documentTypes: visibleDocumentTypes(config)
    });
    return;
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === 'GET' && orderMatch) {
    const orderNumber = decodeURIComponent(orderMatch[1]);
    const { orders } = await listCurrentOrders(storage, store, orderContext, config, ordersCache, {
      orderNumbers: [orderNumber]
    });
    const order = orders.find((item) => item.orderNumber === orderNumber);
    if (!order) {
      sendJson(res, 404, { error: `Order ${orderNumber} not found` });
      return;
    }
    sendJson(res, 200, { order });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/defaults') {
    const user = requestUrl.searchParams.get('user') || 'operator';
    const defaults = defaultsForConfig(await store.getDefaults(user), config);
    sendJson(res, 200, {
      defaults: {
        ...defaults,
        agentUrl: defaults.agentUrl || config.agent.defaultUrl
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/defaults') {
    const body = await readJsonBody(req);
    const defaults = defaultsForConfig(
      await store.saveDefaults(body.user, defaultsForConfig(body.defaults || {}, config)),
      config
    );
    sendJson(res, 200, { defaults });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/print-jobs') {
    const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit')) || 25, 100));
    const jobs = await store.listJobs({ limit });
    const orderNumbers = Array.from(new Set(jobs.flatMap(jobOrderNumbers)));
    let currentByOrderNumber = new Map();
    let contextStatus = { available: true };

    if (orderNumbers.length > 0) {
      try {
        const current = await listCurrentOrders(storage, store, orderContext, config, ordersCache, { orderNumbers });
        currentByOrderNumber = new Map(current.orders.map((order) => [order.orderNumber, order]));
        contextStatus = current.contextStatus || contextStatus;
      } catch (error) {
        contextStatus = {
          available: false,
          error: error.message
        };
      }
    }

    sendJson(res, 200, {
      jobs: jobs.map((job) => summarizePrintJob(job, currentByOrderNumber)),
      contextStatus
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/print-jobs') {
    const body = await readJsonBody(req);
    const orderNumbers = Array.isArray(body.orderNumbers) ? body.orderNumbers.map(String) : [];
    const selectedTypes = normalizedDocumentTypesForConfig(body.documentTypes || body.options?.documentTypes, config);

    if (orderNumbers.length === 0) {
      sendJson(res, 400, { error: 'At least one order number is required.' });
      return;
    }

    const { orders } = await listOrdersForPrintJob(
      storage,
      store,
      orderContext,
      config,
      ordersCache,
      orderNumbers,
      body.deliveryDate
    );
    const byOrderNumber = new Map(orders.map((order) => [order.orderNumber, order]));
    const packingBlockedOrders = orderNumbers
      .map((orderNumber) => byOrderNumber.get(orderNumber))
      .filter((order) => order && (order.packingBlocked || order.context?.packingBlocked || Number(order.context?.packingLinesLeft || 0) > 0));

    if (packingBlockedOrders.length > 0) {
      sendJson(res, 409, {
        error: 'One or more selected orders still have warehouse packing left.',
        blockedOrders: packingBlockedOrders.map((order) => ({
          orderNumber: order.orderNumber,
          packingDepartments: order.context?.packingDepartments || []
        }))
      });
      return;
    }

    const selectedOrders = orderNumbers
      .map((orderNumber) => byOrderNumber.get(orderNumber))
      .filter(Boolean);
    const printTypes = includeRequiredDocumentTypes(selectedTypes, selectedOrders);
    const snapshots = buildPrintSnapshots(selectedOrders, printTypes, {
      includeComboSeparators: body.includeComboSeparators === true
    });

    if (snapshots.length === 0) {
      sendJson(res, 400, { error: 'No printable documents were found for the selected orders.' });
      return;
    }

    const job = await store.createJob({
      createdBy: body.user,
      printerName: body.printerName || body.options?.printerName || '',
      options: body.options || {},
      orders: snapshots,
      notes: body.notes || '',
      callbackToken: randomToken()
    });
    eventHub.broadcast('print-job-created', {
      jobId: job.id,
      status: job.status,
      orderNumbers: jobOrderNumbers(job)
    });

    sendJson(res, 201, {
      job,
      manifest: buildManifest(req, job)
    });
    return;
  }

  const retryMatch = pathname.match(/^\/api\/print-jobs\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    const body = await readJsonBody(req);
    const previousJob = await store.getJob(retryMatch[1]);
    if (!previousJob) {
      sendJson(res, 404, { error: 'Print job not found.' });
      return;
    }

    const job = await store.createJob({
      createdBy: body.user || previousJob.createdBy,
      printerName: body.printerName || previousJob.printerName || '',
      options: body.options || previousJob.options || {},
      orders: structuredClone(previousJob.orders || []),
      notes: `Retry of ${previousJob.id}`,
      callbackToken: randomToken()
    });
    eventHub.broadcast('print-job-retried', {
      jobId: job.id,
      previousJobId: previousJob.id,
      status: job.status,
      orderNumbers: jobOrderNumbers(job)
    });

    sendJson(res, 201, {
      job,
      previousJob: summarizePrintJob(previousJob),
      manifest: buildManifest(req, job)
    });
    return;
  }

  const manifestMatch = pathname.match(/^\/api\/print-jobs\/([^/]+)\/manifest$/);
  if (req.method === 'GET' && manifestMatch) {
    const job = await store.getJob(manifestMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Print job not found.' });
      return;
    }
    sendJson(res, 200, { job, manifest: buildManifest(req, job) });
    return;
  }

  const completeMatch = pathname.match(/^\/api\/print-jobs\/([^/]+)\/complete$/);
  if (req.method === 'POST' && completeMatch) {
    const body = await readJsonBody(req);
    const jobId = completeMatch[1];
    const token = requestUrl.searchParams.get('token') || body.token || '';

    if (config.auth.enabled && !isAuthenticatedRequest(req, config.auth)) {
      const existingJob = await store.getJob(jobId);
      if (!existingJob || !existingJob.callbackToken || !safeEqual(token, existingJob.callbackToken)) {
        sendJson(res, 401, { error: 'Login required.' });
        return;
      }
    }

    const job = await store.completeJob(jobId, body);
    if (!job) {
      sendJson(res, 404, { error: 'Print job not found.' });
      return;
    }
    invalidateOrdersCache(ordersCache);
    eventHub.broadcast('print-job-completed', {
      jobId: job.id,
      status: job.status,
      orderNumbers: jobOrderNumbers(job)
    });
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/documents') {
    const name = requestUrl.searchParams.get('name');
    const source = requestUrl.searchParams.get('source') || 'primary';
    const generation = requestUrl.searchParams.get('generation') || '';
    if (!name) {
      sendJson(res, 400, { error: 'Document object name is required.' });
      return;
    }

    if (!(await isAuthorizedDocumentRequest(req, requestUrl, config, store))) {
      sendJson(res, 401, { error: 'Login required.' });
      return;
    }

    if (source === 'generated') {
      const jobId = requestUrl.searchParams.get('jobId') || '';
      const token = requestUrl.searchParams.get('token') || '';
      const job = jobId ? await store.getJob(jobId) : null;
      const document = job ? findGeneratedDocument(job, name, source) : null;

      if (!job || !document || !job.callbackToken || !safeEqual(token, job.callbackToken)) {
        sendJson(res, 401, { error: 'Generated document is not authorized.' });
        return;
      }

      if (document.generated?.kind !== 'comboSeparator') {
        sendJson(res, 404, { error: 'Generated document not found.' });
        return;
      }

      const body = createCenteredTextPdf(document.generated.text || document.separatorLabel || 'No delivery method');
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length,
        'content-disposition': `inline; filename="${path.basename(document.fileName || 'combo-separator.pdf').replaceAll('"', '')}"`,
        'cache-control': 'private, max-age=30'
      });
      res.end(body);
      return;
    }

    const object = await storage.getObject(name, source, generation);
    const pageCopies = requestUrl.searchParams.get('copyMode') === 'perPage'
      ? normalizedPageCopies(requestUrl.searchParams.get('pageCopies'))
      : 1;
    const body = pageCopies > 1 ? await repeatPdfPages(object.body, pageCopies) : object.body;
    res.writeHead(200, {
      'content-type': pageCopies > 1 ? 'application/pdf' : (object.contentType || 'application/pdf'),
      'content-length': body.length,
      'content-disposition': `inline; filename="${path.basename(name).replaceAll('"', '')}"`,
      'cache-control': 'private, max-age=30'
    });
    res.end(body);
    return;
  }

  sendJson(res, 404, { error: 'API route not found.' });
}

async function serveStatic(req, res, requestUrl, staticDir) {
  let requestedPath = decodeURIComponent(requestUrl.pathname);
  if (requestedPath === '/') requestedPath = '/index.html';

  const filePath = path.resolve(staticDir, `.${requestedPath}`);
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    throw error;
  }
}

export function createRequestHandler(config = loadConfig()) {
  if (config.auth.enabled && !config.auth.password) {
    throw new Error('PRINTWARD_LOGIN_PASSWORD is required when PRINTWARD_AUTH_ENABLED=true.');
  }

  const storage = createStorageClient(config);
  const orderContext = createOrderContextClient(config);
  const store = createStateStore(config);
  const ordersCache = createOrdersCache(config);
  const eventHub = createEventHub();

  if (ordersCache.cacheMs > 0 && config.ordersCacheWarmup) {
    scheduleOrdersCacheWarmup(storage, store, orderContext, config, ordersCache, 1, {
      deliveryDate: todayInStockholm()
    });
  }

  return async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    try {
      if (config.auth.enabled && await handleAuthRoute(req, res, requestUrl, config.auth)) {
        return;
      }

      if (config.auth.enabled && requireLogin(req, res, requestUrl, config.auth)) {
        return;
      }

      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApi(req, res, requestUrl, { config, storage, store, orderContext, ordersCache, eventHub });
        return;
      }

      await serveStatic(req, res, requestUrl, config.staticDir);
    } catch (error) {
      sendError(res, error);
    }
  };
}

export function createServer(config = loadConfig()) {
  return http.createServer(createRequestHandler(config));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const host = process.env.HOST || (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');
  const server = createServer(config);
  server.listen(config.port, host, () => {
    console.log(`Printward listening on http://${host}:${config.port}`);
    console.log(`Storage mode: ${config.gcs.mode}${config.gcs.bucket ? ` (${config.gcs.bucket})` : ''}`);
    console.log(`Order context mode: ${config.orderContext.mode}`);
  });
}
