import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from './config.js';
import { createStorageClient } from './gcsClient.js';
import { attachOrderContexts, createOrderContextClient } from './orderContext.js';
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

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, {
    error: error.message || 'Unexpected error'
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getOrigin(req) {
  const host = req.headers.host || '127.0.0.1';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${host}`;
}

function buildManifest(req, job) {
  const origin = getOrigin(req);
  return {
    jobId: job.id,
    callbackUrl: `${origin}/api/print-jobs/${job.id}/complete`,
    orders: job.orders.map((order) => ({
      ...order,
      documents: order.documents.map((document) => ({
        ...document,
        url: `${origin}/api/documents?name=${encodeURIComponent(document.name)}&source=${encodeURIComponent(document.source || 'primary')}`
      }))
    }))
  };
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
  const { config, storage, store, orderContext, ordersCache } = context;
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

  if (req.method === 'POST' && pathname === '/api/print-jobs') {
    const body = await readJsonBody(req);
    const orderNumbers = Array.isArray(body.orderNumbers) ? body.orderNumbers.map(String) : [];
    const selectedTypes = normalizedDocumentTypesForConfig(body.documentTypes || body.options?.documentTypes, config);

    if (orderNumbers.length === 0) {
      sendJson(res, 400, { error: 'At least one order number is required.' });
      return;
    }

    const { orders } = await listCurrentOrders(storage, store, orderContext, config, ordersCache, { orderNumbers });
    const byOrderNumber = new Map(orders.map((order) => [order.orderNumber, order]));
    const snapshots = orderNumbers
      .map((orderNumber) => byOrderNumber.get(orderNumber))
      .filter(Boolean)
      .map((order) => orderToPrintSnapshot(order, selectedTypes))
      .filter((order) => order.documents.length > 0);

    if (snapshots.length === 0) {
      sendJson(res, 400, { error: 'No printable documents were found for the selected orders.' });
      return;
    }

    const job = await store.createJob({
      createdBy: body.user,
      printerName: body.printerName || body.options?.printerName || '',
      options: body.options || {},
      orders: snapshots,
      notes: body.notes || ''
    });

    sendJson(res, 201, {
      job,
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
    const job = await store.completeJob(completeMatch[1], body);
    if (!job) {
      sendJson(res, 404, { error: 'Print job not found.' });
      return;
    }
    invalidateOrdersCache(ordersCache);
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/documents') {
    const name = requestUrl.searchParams.get('name');
    const source = requestUrl.searchParams.get('source') || 'primary';
    if (!name) {
      sendJson(res, 400, { error: 'Document object name is required.' });
      return;
    }

    const object = await storage.getObject(name, source);
    res.writeHead(200, {
      'content-type': object.contentType || 'application/pdf',
      'content-length': object.body.length,
      'content-disposition': `inline; filename="${path.basename(name).replaceAll('"', '')}"`,
      'cache-control': 'private, max-age=30'
    });
    res.end(object.body);
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

export function createServer(config = loadConfig()) {
  const storage = createStorageClient(config);
  const orderContext = createOrderContextClient(config);
  const store = createStateStore(config);
  const ordersCache = createOrdersCache(config);

  if (ordersCache.cacheMs > 0 && config.ordersCacheWarmup) {
    scheduleOrdersCacheWarmup(storage, store, orderContext, config, ordersCache, 1, {
      deliveryDate: todayInStockholm()
    });
  }

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApi(req, res, requestUrl, { config, storage, store, orderContext, ordersCache });
        return;
      }

      await serveStatic(req, res, requestUrl, config.staticDir);
    } catch (error) {
      sendError(res, error);
    }
  });
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
