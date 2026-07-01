import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { createPlaceholderPdf } from './pdf.js';

function normalizeListedObject(object, source = 'primary') {
  return {
    name: object.name,
    source: object.source || source,
    size: Number(object.size || 0),
    updated: object.updated || object.timeCreated || null,
    generation: object.generation ? String(object.generation) : null,
    contentType: object.contentType || 'application/pdf'
  };
}

function encodeObjectName(name) {
  return encodeURIComponent(name);
}

function uploadApiBase(apiBase) {
  if (apiBase.endsWith('/storage/v1')) {
    return `${apiBase.slice(0, -'/storage/v1'.length)}/upload/storage/v1`;
  }
  return apiBase.replace('/storage/v1', '/upload/storage/v1');
}

function md5Base64(buffer) {
  return createHash('md5').update(buffer).digest('base64');
}

export class MockGcsClient {
  constructor(objectsFile) {
    this.objectsFile = objectsFile;
    this.sources = [{ source: 'primary', bucket: 'mock', prefix: '' }];
  }

  async listObjects() {
    const raw = await fs.readFile(this.objectsFile, 'utf8');
    return JSON.parse(raw).map((object) => normalizeListedObject(object, object.source || 'primary'));
  }

  async getObject(name, source = 'primary') {
    const objects = await this.listObjects();
    const object = objects.find((item) => item.name === name && item.source === source);
    if (!object) {
      const error = new Error(`Mock object not found: ${source}:${name}`);
      error.statusCode = 404;
      throw error;
    }

    const body = createPlaceholderPdf(object.name, [
      `Object: ${object.name}`,
      `Updated: ${object.updated || 'unknown'}`,
      `Generation: ${object.generation || 'unknown'}`,
      'This placeholder PDF is generated in mock mode.'
    ]);

    return {
      body,
      contentType: 'application/pdf',
      size: body.length,
      updated: object.updated
    };
  }

  async getObjectMetadata(name, source = 'primary') {
    const objects = await this.listObjects();
    return objects.find((item) => item.name === name && item.source === source) || null;
  }

  async uploadObjectIfChanged(name, body, options = {}) {
    return {
      uploaded: false,
      skipped: true,
      name,
      source: options.source || 'primary',
      mock: true
    };
  }
}

export class GcsClient {
  constructor(config, source = 'primary') {
    this.config = config;
    this.source = source;
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
    this.sources = [{ source, bucket: config.bucket, prefix: config.prefix || '' }];
  }

  async getAccessToken() {
    if (this.config.authMode === 'none') return '';
    if (this.config.accessToken) return this.config.accessToken;

    const now = Date.now();
    if (this.cachedToken && this.cachedTokenExpiresAt > now + 30_000) {
      return this.cachedToken;
    }

    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );

    if (!response.ok) {
      throw new Error(
        'Unable to obtain a Google access token. Set GCS_ACCESS_TOKEN for local use or run on Google Cloud with a service account.'
      );
    }

    const token = await response.json();
    this.cachedToken = token.access_token;
    this.cachedTokenExpiresAt = now + Number(token.expires_in || 300) * 1000;
    return this.cachedToken;
  }

  async request(url, options = {}) {
    const token = await this.getAccessToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`GCS request failed with ${response.status}: ${text || response.statusText}`);
      error.statusCode = response.status;
      throw error;
    }
    return response;
  }

  async listObjects() {
    if (!this.config.bucket) {
      throw new Error('GCS_BUCKET is required in live mode.');
    }

    const objects = [];
    let pageToken = '';

    do {
      const url = new URL(`${this.config.apiBase}/b/${encodeURIComponent(this.config.bucket)}/o`);
      if (this.config.prefix) url.searchParams.set('prefix', this.config.prefix);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      url.searchParams.set('fields', 'items(name,size,updated,generation,contentType),nextPageToken');

      const response = await this.request(url);
      const payload = await response.json();
      for (const item of payload.items || []) {
        objects.push(normalizeListedObject(item, this.source));
      }
      pageToken = payload.nextPageToken || '';
    } while (pageToken);

    return objects;
  }

  async getObject(name) {
    const url = new URL(
      `${this.config.apiBase}/b/${encodeURIComponent(this.config.bucket)}/o/${encodeObjectName(name)}`
    );
    url.searchParams.set('alt', 'media');

    const response = await this.request(url);
    const arrayBuffer = await response.arrayBuffer();

    return {
      body: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'application/pdf',
      size: Number(response.headers.get('content-length') || 0),
      updated: response.headers.get('last-modified') || null
    };
  }

  async getObjectMetadata(name) {
    const url = new URL(
      `${this.config.apiBase}/b/${encodeURIComponent(this.config.bucket)}/o/${encodeObjectName(name)}`
    );
    url.searchParams.set('fields', 'name,size,updated,generation,contentType,md5Hash,metadata');

    try {
      const response = await this.request(url);
      return response.json();
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async uploadObject(name, body, options = {}) {
    if (!this.config.bucket) {
      throw new Error('GCS bucket is required to upload objects.');
    }

    const url = new URL(`${uploadApiBase(this.config.apiBase)}/b/${encodeURIComponent(this.config.bucket)}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', name);
    url.searchParams.set('fields', 'name,size,updated,generation,contentType,md5Hash');

    const response = await this.request(url, {
      method: 'POST',
      headers: {
        'content-type': options.contentType || 'application/octet-stream',
        'content-length': String(body.length)
      },
      body
    });
    const payload = await response.json();
    return normalizeListedObject(payload, this.source);
  }

  async uploadObjectIfChanged(name, body, options = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const hash = md5Base64(buffer);
    const current = await this.getObjectMetadata(name);

    if (current?.md5Hash === hash) {
      return {
        uploaded: false,
        skipped: true,
        name,
        source: this.source,
        generation: current.generation || null,
        updated: current.updated || null
      };
    }

    const uploaded = await this.uploadObject(name, buffer, options);
    return {
      uploaded: true,
      skipped: false,
      ...uploaded
    };
  }
}

export class MultiGcsClient {
  constructor(clients) {
    this.clients = clients;
    this.sources = clients.flatMap((client) => client.sources || []);
  }

  async listObjects() {
    const lists = await Promise.all(this.clients.map((client) => client.listObjects()));
    return lists.flat();
  }

  async getObject(name, source = 'primary') {
    const client = this.clients.find((item) => item.source === source || item.sources?.some((entry) => entry.source === source));
    if (!client) {
      const error = new Error(`Storage source not configured: ${source}`);
      error.statusCode = 404;
      throw error;
    }
    return client.getObject(name, source);
  }

  async getObjectMetadata(name, source = 'primary') {
    const client = this.clients.find((item) => item.source === source || item.sources?.some((entry) => entry.source === source));
    if (!client) {
      const error = new Error(`Storage source not configured: ${source}`);
      error.statusCode = 404;
      throw error;
    }
    return client.getObjectMetadata(name, source);
  }
}

export function createStorageClient(config) {
  if (config.gcs.mode === 'mock') {
    return new MockGcsClient(config.mockObjectsFile);
  }

  const clients = [new GcsClient(config.gcs, 'primary')];
  if (config.freightGcs?.bucket) {
    clients.push(new GcsClient(config.freightGcs, 'freight'));
  }

  return clients.length === 1 ? clients[0] : new MultiGcsClient(clients);
}
