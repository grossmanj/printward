import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPrintEnvelope,
  buildPrintWaybillEnvelope,
  parsePrintResult
} from '../src/nshiftClient.js';

const config = {
  userName: 'Integration',
  groupName: 'Example',
  password: 'secret',
  printType: 1,
  printFormat: 'PDF'
};

test('builds nShift printWaybill SOAP envelope', () => {
  const xml = buildPrintWaybillEnvelope(config, 'ABC123');

  assert.match(xml, /<typ:printWaybill>/);
  assert.match(xml, /<userName>Integration<\/userName>/);
  assert.match(xml, /<groupName>Example<\/groupName>/);
  assert.match(xml, /<consignmentNo>ABC123<\/consignmentNo>/);
});

test('builds nShift batch print SOAP envelope', () => {
  const xml = buildPrintEnvelope(config, ['A', 'B']);

  assert.match(xml, /<typ:print>/);
  assert.match(xml, /<arrayOfConsignmentNo>A<\/arrayOfConsignmentNo>/);
  assert.match(xml, /<arrayOfConsignmentNo>B<\/arrayOfConsignmentNo>/);
  assert.match(xml, /<type>1<\/type>/);
  assert.match(xml, /<format>PDF<\/format>/);
});

test('builds nShift batch print SOAP envelope with per-call print type', () => {
  const xml = buildPrintEnvelope(config, ['A'], { printType: 2, printFormat: 'PDF' });

  assert.match(xml, /<typ:print>/);
  assert.match(xml, /<arrayOfConsignmentNo>A<\/arrayOfConsignmentNo>/);
  assert.match(xml, /<type>2<\/type>/);
  assert.match(xml, /<format>PDF<\/format>/);
});

test('parses nShift print result documents', () => {
  const pdf = Buffer.from('%PDF-1.7 sample');
  const xml = `
    <S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
      <S:Body>
        <ns2:printWaybillResponse xmlns:ns2="http://www.spedpoint.com/consignment/types">
          <result>
            <documents>
              <name>waybill.pdf</name>
              <contentType>application/pdf</contentType>
              <data>${pdf.toString('base64')}</data>
              <encoding>base64</encoding>
              <type>1</type>
            </documents>
            <statusCode>0</statusCode>
          </result>
        </ns2:printWaybillResponse>
      </S:Body>
    </S:Envelope>
  `;

  const result = parsePrintResult(xml);
  assert.equal(result.statusCode, 0);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].name, 'waybill.pdf');
  assert.deepEqual(result.documents[0].body, pdf);
});
