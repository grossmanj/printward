import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { GcsClient } from '../src/gcsClient.js';

function client() {
  return new GcsClient({
    bucket: 'test-bucket',
    apiBase: 'https://storage.googleapis.com/storage/v1',
    authMode: 'none'
  }, 'freight');
}

test('uploads a Kyl PDF and its booking signature atomically with a generation precondition', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return new Response(JSON.stringify({ name: 'freight/2/pallet2003001.pdf', generation: '9', size: '8' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const pdf = Buffer.from('%PDF-1.4');
    await client().uploadObject('freight/2/pallet2003001.pdf', pdf, {
      contentType: 'application/pdf',
      metadata: { printwardKylBookingSignature: 'abc123' },
      ifGenerationMatch: '8'
    });
    assert.equal(request.url.searchParams.get('uploadType'), 'multipart');
    assert.equal(request.url.searchParams.get('ifGenerationMatch'), '8');
    assert.match(request.options.headers['content-type'], /^multipart\/related; boundary=/);
    const body = Buffer.from(request.options.body);
    assert.match(body.toString('latin1'), /"printwardKylBookingSignature":"abc123"/);
    assert.ok(body.includes(pdf));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('patches Kyl retry metadata only on the inspected object generation', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return new Response(JSON.stringify({ generation: '8', metageneration: '3' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await client().patchObjectMetadata('freight/2/pallet2003001.pdf', {
      printwardKylBookingSignature: 'old', printwardKylRetrySignature: 'new'
    }, { generation: '8', metageneration: '2' });
    assert.equal(request.options.method, 'PATCH');
    assert.equal(request.url.searchParams.get('ifGenerationMatch'), '8');
    assert.equal(request.url.searchParams.get('ifMetagenerationMatch'), '2');
    assert.deepEqual(JSON.parse(request.options.body).metadata, {
      printwardKylBookingSignature: 'old', printwardKylRetrySignature: 'new'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('same-byte pallet upload still records the booking marker without changing PDF generation', async () => {
  const storage = client();
  const pdf = Buffer.from('%PDF-1.4');
  const md5Hash = createHash('md5').update(pdf).digest('base64');
  storage.getObjectMetadata = async () => ({
    generation: '8', metageneration: '1', md5Hash, metadata: {}
  });
  let patched;
  storage.patchObjectMetadata = async (_name, metadata, preconditions) => {
    patched = { metadata, preconditions };
  };
  storage.uploadObject = async () => { throw new Error('PDF must not be uploaded again.'); };
  const result = await storage.uploadObjectIfChanged('freight/2/pallet2003001.pdf', pdf, {
    metadata: { printwardKylBookingSignature: 'abc123' }, ifGenerationMatch: '8'
  });
  assert.equal(result.uploaded, false);
  assert.deepEqual(patched, {
    metadata: { printwardKylBookingSignature: 'abc123' },
    preconditions: { generation: '8', metageneration: '1' }
  });
  await assert.rejects(storage.uploadObjectIfChanged('freight/2/pallet2003001.pdf', pdf, {
    metadata: { printwardKylBookingSignature: 'abc123' }, ifGenerationMatch: '7'
  }), /generation changed/);
});
