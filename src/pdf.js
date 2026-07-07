import { inflateSync } from 'node:zlib';

function escapePdfText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

export function createPlaceholderPdf(title, lines = []) {
  const pageLines = [title, ...lines].slice(0, 24);
  const text = pageLines
    .map((line, index) => {
      const size = index === 0 ? 20 : 12;
      const leading = index === 0 ? 28 : 18;
      const escaped = escapePdfText(line);
      return index === 0
        ? `/F1 ${size} Tf 72 760 Td (${escaped}) Tj`
        : `0 -${leading} Td /F1 ${size} Tf (${escaped}) Tj`;
    })
    .join('\n');

  const stream = `BT\n${text}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

export function createCenteredTextPdf(text) {
  const pageWidth = 612;
  const pageHeight = 792;
  const normalizedText = String(text || 'No delivery method').trim() || 'No delivery method';
  const fontSize = Math.max(30, Math.min(76, Math.floor(520 / Math.max(normalizedText.length * 0.55, 1))));
  const estimatedWidth = normalizedText.length * fontSize * 0.55;
  const x = Math.max(36, Math.round((pageWidth - estimatedWidth) / 2));
  const y = Math.round((pageHeight - fontSize) / 2);
  const escaped = escapePdfText(normalizedText);
  const stream = [
    'BT',
    `/F1 ${fontSize} Tf`,
    `${x} ${y} Td`,
    `(${escaped}) Tj`,
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

export async function repeatPdfPages(body, copies) {
  const normalizedCopies = Math.min(20, Math.max(1, Math.trunc(Number(copies || 1))));
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (normalizedCopies === 1) return sourceBody;

  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  const repeated = await PDFDocument.create();

  for (const pageIndex of source.getPageIndices()) {
    const copiedPages = await repeated.copyPages(
      source,
      Array.from({ length: normalizedCopies }, () => pageIndex)
    );
    for (const page of copiedPages) repeated.addPage(page);
  }

  return Buffer.from(await repeated.save());
}

function parsePageSelection(selection, pageCount) {
  const indices = [];
  const seen = new Set();
  const parts = String(selection || '').split(',').map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/);
    const single = part.match(/^(\d+)$/);
    if (!range && !single) {
      throw new Error(`Invalid PDF page selection: ${selection}`);
    }

    const start = Number(range ? range[1] : single[1]);
    const end = Number(range ? range[2] : single[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new Error(`PDF page selection ${part} is outside the ${pageCount} page document.`);
    }

    for (let page = start; page <= end; page += 1) {
      const index = page - 1;
      if (!seen.has(index)) {
        seen.add(index);
        indices.push(index);
      }
    }
  }

  if (indices.length === 0) throw new Error('No PDF pages selected.');
  return indices;
}

async function extractPdfPageIndices(body, indices) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  const pageCount = source.getPageCount();

  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
      throw new Error(`PDF page index ${index + 1} is outside the ${pageCount} page document.`);
    }
  }

  const extracted = await PDFDocument.create();
  const pages = await extracted.copyPages(source, indices);
  for (const page of pages) extracted.addPage(page);
  return Buffer.from(await extracted.save());
}

export async function extractPdfPages(body, selection) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  const indices = parsePageSelection(selection, source.getPageCount());
  return extractPdfPageIndices(sourceBody, indices);
}

function boolFromQuery(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function lookupMaybe(context, object) {
  if (!object) return undefined;
  try {
    return context.lookup(object);
  } catch {
    return undefined;
  }
}

function dictValue(dict, PDFName, name) {
  try {
    return dict?.get?.(PDFName.of(name));
  } catch {
    return undefined;
  }
}

function decodePdfRawStream(stream) {
  const raw = stream.getContents ? stream.getContents() : stream.contents;
  try {
    return Buffer.from(inflateSync(Buffer.from(raw))).toString('latin1');
  } catch {
    return Buffer.from(raw || []).toString('latin1');
  }
}

function collectPdfStreamText(pdf, streamObject, pdfLib, depth = 0, seen = new Set()) {
  const { PDFDict, PDFName, PDFRawStream } = pdfLib;
  if (!streamObject || depth > 6) return '';

  const stream = streamObject instanceof PDFRawStream
    ? streamObject
    : lookupMaybe(pdf.context, streamObject);
  if (!(stream instanceof PDFRawStream) || seen.has(stream)) return '';

  seen.add(stream);
  let text = decodePdfRawStream(stream);
  const resources = lookupMaybe(pdf.context, dictValue(stream.dict, PDFName, 'Resources'));
  const xObjects = lookupMaybe(pdf.context, dictValue(resources, PDFName, 'XObject'));

  if (xObjects instanceof PDFDict) {
    for (const [, xObject] of xObjects.entries()) {
      text += `\n${collectPdfStreamText(pdf, xObject, pdfLib, depth + 1, seen)}`;
    }
  }

  return text;
}

function extractPdfPageText(pdf, pageIndex, pdfLib) {
  const { PDFArray, PDFDict, PDFName, PDFRawStream } = pdfLib;
  const page = pdf.getPage(pageIndex);
  const contents = page.node.Contents();
  const seen = new Set();
  let text = '';

  if (contents instanceof PDFRawStream) {
    text += collectPdfStreamText(pdf, contents, pdfLib, 0, seen);
  } else if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      text += `\n${collectPdfStreamText(pdf, contents.get(index), pdfLib, 0, seen)}`;
    }
  }

  const resources = page.node.Resources();
  const xObjects = lookupMaybe(pdf.context, dictValue(resources, PDFName, 'XObject'));
  if (xObjects instanceof PDFDict) {
    for (const [, xObject] of xObjects.entries()) {
      text += `\n${collectPdfStreamText(pdf, xObject, pdfLib, 0, seen)}`;
    }
  }

  return text;
}

function kylPageKind(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.includes('fraktsedel')) return 'label';
  if (normalized.includes('froozen') || normalized.includes('frozen') || normalized.includes('fryst')) return 'frozenFreight';
  if (normalized.includes('cooling') || normalized.includes('kyla')) return 'coolingFreight';
  return 'unknownFreight';
}

function requirePages(pages, section) {
  if (pages.length === 0) {
    throw new Error(`No pages found for Kyl freight section ${section}.`);
  }
  return pages;
}

export async function analyzeKylPalletPdf(body) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const pdfLib = await import('pdf-lib');
  const { PDFDocument } = pdfLib;
  const source = await PDFDocument.load(sourceBody);
  const pageCount = source.getPageCount();
  const pages = [];

  for (let index = 0; index < pageCount; index += 1) {
    const text = extractPdfPageText(source, index, pdfLib);
    pages.push({
      page: index + 1,
      kind: kylPageKind(text)
    });
  }

  return {
    pageCount,
    pages,
    labelPages: pages.filter((page) => page.kind === 'label').map((page) => page.page),
    coolingFreightPages: pages.filter((page) => page.kind === 'coolingFreight').map((page) => page.page),
    frozenFreightPages: pages.filter((page) => page.kind === 'frozenFreight').map((page) => page.page),
    unknownFreightPages: pages.filter((page) => page.kind === 'unknownFreight').map((page) => page.page)
  };
}

export async function countPdfPages(body) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  return source.getPageCount();
}

export async function inferKylPalletLabelPages(body, options = {}) {
  const analysis = await analyzeKylPalletPdf(body, options);
  return analysis.labelPages.length;
}

export async function extractKylFreightSection(body, options = {}) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const section = String(options.section || '').trim();
  const analysis = await analyzeKylPalletPdf(sourceBody, options);

  let pages = [];
  if (section === 'coolingFreight' || section === 'frozenFreight') {
    pages = section === 'coolingFreight'
      ? analysis.coolingFreightPages
      : analysis.frozenFreightPages;
  } else if (section === 'remainingFreight') {
    pages = [...analysis.coolingFreightPages, ...analysis.frozenFreightPages, ...analysis.unknownFreightPages]
      .sort((left, right) => left - right);
  } else {
    throw new Error(`Unknown Kyl freight section: ${section || 'none'}`);
  }

  return extractPdfPageIndices(sourceBody, requirePages(pages, section).map((page) => page - 1));
}
