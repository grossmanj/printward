const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';
const NSHIFT_TYPES = 'http://www.spedpoint.com/consignment/types';

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function xmlDecode(value) {
  return String(value ?? '')
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function tagRegex(name, global = false) {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`, global ? 'gi' : 'i');
}

function extractTag(xml, name) {
  const match = String(xml || '').match(tagRegex(name));
  return match ? xmlDecode(match[1].trim()) : '';
}

function extractBlocks(xml, name) {
  return Array.from(String(xml || '').matchAll(tagRegex(name, true)), (match) => match[1]);
}

function authenticationXml(config) {
  return [
    '<AuthenticationToken>',
    `<userName>${xmlEscape(config.userName)}</userName>`,
    `<groupName>${xmlEscape(config.groupName)}</groupName>`,
    `<password>${xmlEscape(config.password)}</password>`,
    '</AuthenticationToken>'
  ].join('');
}

function envelope(body) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soapenv:Envelope xmlns:soapenv="${SOAP_ENV}" xmlns:typ="${NSHIFT_TYPES}">`,
    '<soapenv:Header/>',
    '<soapenv:Body>',
    body,
    '</soapenv:Body>',
    '</soapenv:Envelope>'
  ].join('');
}

export function buildPrintWaybillEnvelope(config, consignmentNo) {
  return envelope([
    '<typ:printWaybill>',
    authenticationXml(config),
    `<consignmentNo>${xmlEscape(consignmentNo)}</consignmentNo>`,
    '</typ:printWaybill>'
  ].join(''));
}

export function buildPrintEnvelope(config, consignmentNumbers, options = {}) {
  const consignments = consignmentNumbers
    .map((consignmentNo) => `<arrayOfConsignmentNo>${xmlEscape(consignmentNo)}</arrayOfConsignmentNo>`)
    .join('');

  const printType = options.printType ?? config.printType ?? 1;
  const printFormat = options.printFormat ?? config.printFormat ?? 'PDF';

  return envelope([
    '<typ:print>',
    authenticationXml(config),
    consignments,
    `<type>${Number(printType || 1)}</type>`,
    `<format>${xmlEscape(printFormat)}</format>`,
    '</typ:print>'
  ].join(''));
}

export function parsePrintResult(xml) {
  const errors = extractBlocks(xml, 'errors').map((block) => ({
    code: extractTag(block, 'code'),
    description: extractTag(block, 'description'),
    level: Number(extractTag(block, 'level') || 0)
  }));

  const documents = extractBlocks(xml, 'documents').map((block) => {
    const data = extractTag(block, 'data').replace(/\s+/g, '');
    return {
      name: extractTag(block, 'name'),
      contentType: extractTag(block, 'contentType') || 'application/pdf',
      encoding: extractTag(block, 'encoding') || 'base64',
      type: Number(extractTag(block, 'type') || 0),
      data,
      body: data ? Buffer.from(data, 'base64') : Buffer.alloc(0)
    };
  }).filter((document) => document.body.length > 0);

  return {
    statusCode: Number(extractTag(xml, 'statusCode') || 0),
    errors,
    documents
  };
}

export class NshiftConsignmentClient {
  constructor(config) {
    this.config = config;
  }

  validate() {
    const missing = [];
    if (!this.config.endpoint) missing.push('NSHIFT_ENDPOINT');
    if (!this.config.userName) missing.push('NSHIFT_USERNAME');
    if (!this.config.groupName) missing.push('NSHIFT_GROUP_NAME');
    if (!this.config.password) missing.push('NSHIFT_PASSWORD');
    if (missing.length > 0) {
      throw new Error(`Missing nShift configuration: ${missing.join(', ')}`);
    }
  }

  async call(xml) {
    this.validate();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs || 30_000);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset=utf-8',
          soapaction: ''
        },
        body: xml,
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`nShift SOAP request failed with ${response.status}: ${text.slice(0, 500)}`);
      }
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  assertPrintable(result, consignmentNumbers) {
    if (result.errors.length > 0) {
      const message = result.errors
        .map((error) => [error.code, error.description].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('; ');
      throw new Error(`nShift returned errors for ${consignmentNumbers.join(', ')}: ${message || 'unknown error'}`);
    }

    if (result.documents.length === 0) {
      throw new Error(`nShift returned no printable documents for ${consignmentNumbers.join(', ')}`);
    }
  }

  async printWaybill(consignmentNo) {
    const xml = buildPrintWaybillEnvelope(this.config, consignmentNo);
    const result = parsePrintResult(await this.call(xml));
    this.assertPrintable(result, [consignmentNo]);
    return result.documents;
  }

  async print(consignmentNumbers, options = {}) {
    const xml = buildPrintEnvelope(this.config, consignmentNumbers, options);
    const result = parsePrintResult(await this.call(xml));
    this.assertPrintable(result, consignmentNumbers);
    return result.documents;
  }

  async printDocuments(consignmentNumbers, options = {}) {
    const normalized = Array.from(new Set(consignmentNumbers.map(String).map((item) => item.trim()).filter(Boolean)));
    if (normalized.length === 0) return [];

    const operation = options.printOperation || this.config.printOperation;
    if (operation === 'print') {
      return this.print(normalized, options);
    }

    const documents = [];
    for (const consignmentNo of normalized) {
      documents.push(...await this.printWaybill(consignmentNo));
    }
    return documents;
  }
}
