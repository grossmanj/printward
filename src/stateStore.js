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
  documentTypes: ['packingSlip', 'attachment', 'freight'],
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
    this.writeQueue = this.writeQueue.then(async () => {
      await this.load();
      const result = await mutator(this.state);
      await this.persist();
      return result;
    });
    return this.writeQueue;
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

  async completeJob(jobId, input) {
    const now = new Date().toISOString();
    return this.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return null;

      job.status = input.status === 'failed' ? 'failed' : 'printed';
      job.updatedAt = now;
      job.completedAt = now;
      job.completedBy = safeUser(input.user || job.createdBy);
      job.error = input.error || '';

      if (job.status === 'printed') {
        for (const order of job.orders) {
          for (const document of order.documents || []) {
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
    this.writeQueue = this.writeQueue.then(async () => mutator());
    return this.writeQueue;
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
      callbackToken: input.callbackToken || ''
    };

    await this.saveEntity(STORE_KINDS.job, job.id, job, [
      ['jobId', job.id],
      ['status', job.status],
      ['createdBy', job.createdBy],
      ['createdAt', job.createdAt],
      ['updatedAt', job.updatedAt]
    ]);

    return job;
  }

  async getJob(jobId) {
    return this.getEntity(STORE_KINDS.job, jobId);
  }

  async completeJob(jobId, input) {
    const now = new Date().toISOString();
    return this.update(async () => {
      const job = await this.getJob(jobId);
      if (!job) return null;

      job.status = input.status === 'failed' ? 'failed' : 'printed';
      job.updatedAt = now;
      job.completedAt = now;
      job.completedBy = safeUser(input.user || job.createdBy);
      job.error = input.error || '';

      await this.saveEntity(STORE_KINDS.job, job.id, job, [
        ['jobId', job.id],
        ['status', job.status],
        ['createdBy', job.createdBy],
        ['createdAt', job.createdAt],
        ['updatedAt', job.updatedAt]
      ]);

      if (job.status === 'printed') {
        const writes = [];
        for (const order of job.orders) {
          for (const document of order.documents || []) {
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
