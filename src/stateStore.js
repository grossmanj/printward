import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PRINT_SETTINGS = {
  printerName: '',
  copies: 1,
  duplex: true,
  staple: true,
  stapleOption: 'StapleLocation=UpperLeft',
  colorMode: 'auto',
  documentTypes: ['pallet', 'packingSlip', 'attachment', 'freight'],
  agentUrl: 'http://127.0.0.1:37951'
};

const STORE_KINDS = {
  default: 'Default',
  job: 'Job',
  printEvent: 'PrintEvent'
};

function emptyState() {
  return {
    version: 1,
    defaultsByUser: {},
    printEvents: [],
    jobs: []
  };
}

function safeUser(user) {
  return String(user || 'operator').trim().slice(0, 80) || 'operator';
}

// A failed Windows batch may already have sent earlier sections to the spooler.
// Only a complete order whose every section is in the agent's confirmed prefix
// can be recorded as printed. An incomplete chilled/frozen order stays pending.
function validSectionResultCount(job, results) {
  const sections = job.orders || [];
  if (!Array.isArray(results) || !results.length || results.length > sections.length) return 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const section = sections[index];
    if (!result || result.spoolConfirmed !== true || result.skipped
      || String(result.orderNumber) !== String(section.orderNumber)) return 0;
  }
  return results.length;
}

function confirmedOrderNumbers(job, input) {
  const sections = job.orders || [];
  if (input.status !== 'failed') {
    return new Set(sections.filter((section) => !section.isSeparator)
      .map((section) => String(section.orderNumber)));
  }
  const count = Math.max(validSectionResultCount(job, input.results),
    Math.min(sections.length, Math.max(0, Number(job.progress?.completedSections || 0))));
  if (!count) return new Set();
  const unfinished = new Set(sections.slice(count)
    .filter((section) => !section.isSeparator)
    .map((section) => String(section.orderNumber)));
  return new Set(sections.slice(0, count)
    .filter((section) => !section.isSeparator && !unfinished.has(String(section.orderNumber)))
    .map((section) => String(section.orderNumber)));
}

function completionFailed(job, input) {
  return input.status === 'failed'
    || (String(job.notes || '').startsWith('Dashboard ')
      && validSectionResultCount(job, input.results) !== (job.orders || []).length)
    || (Array.isArray(input.results) && input.results.length > 0
      && validSectionResultCount(job, input.results) !== (job.orders || []).length);
}

export function summarizeJobProgress(job = {}) {
  const sections = job.orders || [];
  const totalSections = sections.length;
  const totalOrders = new Set(sections.filter((section) => !section.isSeparator)
    .map((section) => String(section.orderNumber))).size;
  const completedSections = job.status === 'printed' ? totalSections
    : Math.min(totalSections, Math.max(0, Number(job.progress?.completedSections || 0)));
  const confirmedPrefix = sections.slice(0, completedSections)
    .map((section) => ({ orderNumber: section.orderNumber, spoolConfirmed: true }));
  const completedOrders = confirmedOrderNumbers(job, { status: 'failed', results: confirmedPrefix }).size;
  return {
    status: job.status || 'created',
    totalSections,
    completedSections,
    remainingSections: totalSections - completedSections,
    totalOrders,
    completedOrders,
    remainingOrders: totalOrders - completedOrders,
    currentOrderNumber: sections[completedSections]?.isSeparator ? null : sections[completedSections]?.orderNumber || null,
    updatedAt: job.updatedAt || job.createdAt || '',
    error: job.error || ''
  };
}

function applyJobProgress(job, input) {
  if (!job) return null;
  const index = Number(input.sectionIndex);
  const completed = Number(job.progress?.completedSections || 0);
  if (!Number.isInteger(index) || index < 0 || index >= (job.orders || []).length
    || input.spoolConfirmed !== true || input.skipped === true
    || String(input.orderNumber) !== String(job.orders[index].orderNumber)) {
    throw new Error('Invalid print section progress.');
  }
  if (index < completed) return job; // Idempotent callback retry.
  if (index !== completed || !['created', 'printing'].includes(job.status)) {
    throw new Error('Print section progress is out of order.');
  }
  job.status = 'printing';
  job.updatedAt = new Date().toISOString();
  job.progress = { completedSections: completed + 1 };
  return job;
}

function parseStoredJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function datastoreFields(entity) {
  return [
    { name: 'json', value: JSON.stringify(entity), excludeFromIndexes: true }
  ];
}

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.state) return this.state;

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = { ...emptyState(), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = emptyState();
      await this.persist();
    }

    return this.state;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  async update(mutator) {
    const pending = this.writeQueue.then(async () => {
      await this.load();
      const result = await mutator(this.state);
      await this.persist();
      return result;
    });
    // A rejected validation must not prevent every later state write.
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async getState() {
    await this.load();
    return structuredClone(this.state);
  }

  async getDefaults(user) {
    await this.load();
    return {
      ...DEFAULT_PRINT_SETTINGS,
      ...(this.state.defaultsByUser[safeUser(user)] || {})
    };
  }

  async saveDefaults(user, defaults) {
    const userKey = safeUser(user);
    return this.update((state) => {
      const current = state.defaultsByUser[userKey] || {};
      const saved = {
        ...DEFAULT_PRINT_SETTINGS,
        ...current,
        ...defaults,
        copies: Math.max(1, Number(defaults.copies || current.copies || 1))
      };
      state.defaultsByUser[userKey] = saved;
      return saved;
    });
  }

  async createJob(input) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      status: 'created',
      createdAt: now,
      updatedAt: now,
      createdBy: safeUser(input.createdBy),
      printerName: input.printerName || '',
      options: input.options || {},
      orders: input.orders || [],
      notes: input.notes || '',
      resumedFromJobId: input.resumedFromJobId || '',
      progress: { completedSections: 0 },
      callbackToken: input.callbackToken || ''
    };

    await this.update((state) => {
      state.jobs.push(job);
      return job;
    });

    return job;
  }

  async getJob(jobId) {
    await this.load();
    const job = this.state.jobs.find((item) => item.id === jobId);
    return job ? structuredClone(job) : null;
  }

  async listJobs(options = {}) {
    await this.load();
    const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
    return [...(this.state.jobs || [])]
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async findResumeJob(previousJobId) {
    await this.load();
    const job = this.state.jobs.find((item) => item.resumedFromJobId === previousJobId);
    return job ? structuredClone(job) : null;
  }

  async updateJobProgress(jobId, input) {
    return this.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      return job ? structuredClone(applyJobProgress(job, input)) : null;
    });
  }

  async completeJob(jobId, input) {
    const now = new Date().toISOString();
    return this.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return null;
      if (job.status === 'failed' || job.status === 'printed') return structuredClone(job);

      job.status = completionFailed(job, input) ? 'failed' : 'printed';
      job.updatedAt = now;
      job.completedAt = now;
      job.completedBy = safeUser(input.user || job.createdBy);
      job.error = input.error || (job.status === 'failed' ? 'Incomplete agent confirmation.' : '');
      const confirmedOrders = confirmedOrderNumbers(job, { ...input, status: job.status });
      job.progress = { completedSections: job.status === 'printed'
        ? (job.orders || []).length
        : Math.max(Number(job.progress?.completedSections || 0), validSectionResultCount(job, input.results)) };
      job.confirmedOrderNumbers = [...confirmedOrders];

      if (confirmedOrders.size) {
        for (const order of job.orders) {
          if (order.isSeparator || !confirmedOrders.has(String(order.orderNumber))) continue;
          for (const document of order.documents || []) {
            if ((document.source || '') === 'generated' || document.type === 'comboSeparator') continue;
            state.printEvents.push({
              id: randomUUID(),
              jobId: job.id,
              orderNumber: order.orderNumber,
              documentType: document.type,
              source: document.source || 'primary',
              objectName: document.name,
              generation: document.generation || null,
              objectUpdated: document.updated || null,
              printedAt: now,
              printedBy: job.completedBy,
              printerName: input.printerName || job.printerName || '',
              status: 'printed'
            });
          }
        }
      }

      return structuredClone(job);
    });
  }
}

export class DatastoreStateStore {
  constructor(config) {
    this.config = config;
    this.datastorePromise = null;
    this.writeQueue = Promise.resolve();
  }

  async getDatastore() {
    if (this.datastorePromise) return this.datastorePromise;

    this.datastorePromise = import('@google-cloud/datastore').then((module) => {
      const Datastore = module.Datastore || module.default?.Datastore || module.default;
      return new Datastore({
        projectId: this.config.projectId || undefined,
        namespace: this.config.namespace || undefined
      });
    });

    return this.datastorePromise;
  }

  kind(suffix) {
    return `${this.config.kindPrefix || 'Printward'}${suffix}`;
  }

  async key(kindSuffix, id) {
    const datastore = await this.getDatastore();
    return datastore.key([this.kind(kindSuffix), String(id)]);
  }

  async queryKind(kindSuffix) {
    const datastore = await this.getDatastore();
    const query = datastore.createQuery(this.kind(kindSuffix));
    const [entities] = await datastore.runQuery(query);
    return entities || [];
  }

  async saveEntity(kindSuffix, id, data, indexedFields = []) {
    const datastore = await this.getDatastore();
    const key = await this.key(kindSuffix, id);
    const indexedData = indexedFields.map(([name, value]) => ({ name, value }));
    await datastore.save({
      key,
      data: [
        ...indexedData,
        ...datastoreFields(data)
      ]
    });
    return data;
  }

  async getEntity(kindSuffix, id) {
    const datastore = await this.getDatastore();
    const key = await this.key(kindSuffix, id);
    const [entity] = await datastore.get(key);
    return entity ? parseStoredJson(entity.json, null) : null;
  }

  async update(mutator) {
    const pending = this.writeQueue.then(async () => mutator());
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async getState() {
    const [defaultEntities, jobEntities, printEventEntities] = await Promise.all([
      this.queryKind(STORE_KINDS.default),
      this.queryKind(STORE_KINDS.job),
      this.queryKind(STORE_KINDS.printEvent)
    ]);

    const state = emptyState();
    for (const entity of defaultEntities) {
      const user = safeUser(entity.user);
      state.defaultsByUser[user] = parseStoredJson(entity.json, {});
    }
    state.jobs = jobEntities
      .map((entity) => parseStoredJson(entity.json, null))
      .filter(Boolean);
    state.printEvents = printEventEntities
      .map((entity) => parseStoredJson(entity.json, null))
      .filter(Boolean);

    return state;
  }

  async getDefaults(user) {
    const userKey = safeUser(user);
    const saved = await this.getEntity(STORE_KINDS.default, userKey);
    return {
      ...DEFAULT_PRINT_SETTINGS,
      ...(saved || {})
    };
  }

  async saveDefaults(user, defaults) {
    const userKey = safeUser(user);
    return this.update(async () => {
      const current = await this.getEntity(STORE_KINDS.default, userKey) || {};
      const saved = {
        ...DEFAULT_PRINT_SETTINGS,
        ...current,
        ...defaults,
        copies: Math.max(1, Number(defaults.copies || current.copies || 1))
      };

      await this.saveEntity(STORE_KINDS.default, userKey, saved, [
        ['user', userKey],
        ['updatedAt', new Date().toISOString()]
      ]);
      return saved;
    });
  }

  async createJob(input) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      status: 'created',
      createdAt: now,
      updatedAt: now,
      createdBy: safeUser(input.createdBy),
      printerName: input.printerName || '',
      options: input.options || {},
      orders: input.orders || [],
      notes: input.notes || '',
      resumedFromJobId: input.resumedFromJobId || '',
      progress: { completedSections: 0 },
      callbackToken: input.callbackToken || ''
    };

    await this.saveEntity(STORE_KINDS.job, job.id, job, [
      ['jobId', job.id],
      ['status', job.status],
      ['createdBy', job.createdBy],
      ['createdAt', job.createdAt],
      ['updatedAt', job.updatedAt],
      ['resumedFromJobId', job.resumedFromJobId]
    ]);

    return job;
  }

  async getJob(jobId) {
    return this.getEntity(STORE_KINDS.job, jobId);
  }

  async listJobs(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
    const datastore = await this.getDatastore();
    const query = datastore
      .createQuery(this.kind(STORE_KINDS.job))
      .order('createdAt', { descending: true })
      .limit(limit);
    const [entities] = await datastore.runQuery(query);
    return (entities || [])
      .map((entity) => parseStoredJson(entity.json, null))
      .filter(Boolean)
      .map((job) => structuredClone(job));
  }

  async findResumeJob(previousJobId) {
    const datastore = await this.getDatastore();
    const query = datastore.createQuery(this.kind(STORE_KINDS.job))
      .filter('resumedFromJobId', '=', String(previousJobId)).limit(1);
    const [entities] = await datastore.runQuery(query);
    return entities?.[0] ? structuredClone(parseStoredJson(entities[0].json, null)) : null;
  }

  async updateJobProgress(jobId, input) {
    return this.update(async () => {
      const job = await this.getJob(jobId);
      if (!job) return null;
      const before = Number(job.progress?.completedSections || 0);
      applyJobProgress(job, input);
      if (Number(job.progress?.completedSections || 0) !== before) {
        await this.saveEntity(STORE_KINDS.job, job.id, job, [
          ['jobId', job.id], ['status', job.status], ['createdBy', job.createdBy],
          ['createdAt', job.createdAt], ['updatedAt', job.updatedAt],
          ['resumedFromJobId', job.resumedFromJobId || '']
        ]);
      }
      return structuredClone(job);
    });
  }

  async completeJob(jobId, input) {
    const now = new Date().toISOString();
    return this.update(async () => {
      const job = await this.getJob(jobId);
      if (!job) return null;
      if (job.status === 'failed' || job.status === 'printed') return structuredClone(job);

      job.status = completionFailed(job, input) ? 'failed' : 'printed';
      job.updatedAt = now;
      job.completedAt = now;
      job.completedBy = safeUser(input.user || job.createdBy);
      job.error = input.error || (job.status === 'failed' ? 'Incomplete agent confirmation.' : '');
      const confirmedOrders = confirmedOrderNumbers(job, { ...input, status: job.status });
      job.progress = { completedSections: job.status === 'printed'
        ? (job.orders || []).length
        : Math.max(Number(job.progress?.completedSections || 0), validSectionResultCount(job, input.results)) };
      job.confirmedOrderNumbers = [...confirmedOrders];

      await this.saveEntity(STORE_KINDS.job, job.id, job, [
        ['jobId', job.id],
        ['status', job.status],
        ['createdBy', job.createdBy],
        ['createdAt', job.createdAt],
        ['updatedAt', job.updatedAt],
        ['resumedFromJobId', job.resumedFromJobId || '']
      ]);

      if (confirmedOrders.size) {
        const writes = [];
        for (const order of job.orders) {
          if (order.isSeparator || !confirmedOrders.has(String(order.orderNumber))) continue;
          for (const document of order.documents || []) {
            if ((document.source || '') === 'generated' || document.type === 'comboSeparator') continue;
            const event = {
              id: randomUUID(),
              jobId: job.id,
              orderNumber: order.orderNumber,
              documentType: document.type,
              source: document.source || 'primary',
              objectName: document.name,
              generation: document.generation || null,
              objectUpdated: document.updated || null,
              printedAt: now,
              printedBy: job.completedBy,
              printerName: input.printerName || job.printerName || '',
              status: 'printed'
            };
            writes.push(this.saveEntity(STORE_KINDS.printEvent, event.id, event, [
              ['jobId', event.jobId],
              ['orderNumber', event.orderNumber],
              ['documentType', event.documentType],
              ['source', event.source],
              ['objectName', event.objectName],
              ['printedAt', event.printedAt],
              ['status', event.status]
            ]));
          }
        }
        await Promise.all(writes);
      }

      return structuredClone(job);
    });
  }
}

export function createStateStore(config) {
  if (config.stateStore?.mode === 'datastore') {
    return new DatastoreStateStore(config.stateStore);
  }

  return new StateStore(config.dataFile);
}

export function buildPrintIndex(state) {
  const latestByDoc = new Map();
  const events = [...(state.printEvents || [])].sort((left, right) => {
    return String(left.printedAt || '').localeCompare(String(right.printedAt || ''));
  });

  for (const event of events) {
    if (event.status !== 'printed') continue;
    const key = `${event.orderNumber}:${event.documentType}:${event.source || 'primary'}:${event.objectName}`;
    latestByDoc.set(key, event);
  }

  return { latestByDoc };
}
