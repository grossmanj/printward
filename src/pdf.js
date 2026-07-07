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

function kylConsignmentCount(hasCooling, hasFrozen) {
  return [hasCooling, hasFrozen].filter(Boolean).length;
}

function inferredKylLabelPages(pageCount, hasCooling, hasFrozen) {
  const consignmentCount = kylConsignmentCount(hasCooling, hasFrozen);
  if (consignmentCount <= 0) return 1;

  const inferred = pageCount - (consignmentCount * 3);
  if (Number.isInteger(inferred) && inferred >= consignmentCount && inferred < pageCount) {
    return inferred;
  }

  return consignmentCount;
}

export async function countPdfPages(body) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  return source.getPageCount();
}

export async function inferKylPalletLabelPages(body, options = {}) {
  const hasCooling = boolFromQuery(options.hasCooling);
  const hasFrozen = boolFromQuery(options.hasFrozen);
  const pageCount = await countPdfPages(body);
  return inferredKylLabelPages(pageCount, hasCooling, hasFrozen);
}

export async function extractKylFreightSection(body, options = {}) {
  const sourceBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(sourceBody);
  const pageCount = source.getPageCount();
  const section = String(options.section || '').trim();
  const hasCooling = boolFromQuery(options.hasCooling);
  const hasFrozen = boolFromQuery(options.hasFrozen);
  const requestedLabelPages = Math.max(0, Math.min(pageCount, Math.trunc(Number(options.labelPages || 0)) || 0));
  const labelPages = inferredKylLabelPages(pageCount, hasCooling, hasFrozen) || requestedLabelPages;
  const freightIndices = Array.from(
    { length: Math.max(0, pageCount - labelPages) },
    (_, index) => labelPages + index
  );

  let indices = [];
  if (section === 'coolingFreight' || section === 'frozenFreight') {
    if (hasCooling && hasFrozen) {
      if (freightIndices.length % 2 !== 0) {
        throw new Error(`Cannot split Kyl freight pages: ${freightIndices.length} freight pages after ${labelPages} pallet pages.`);
      }
      const half = freightIndices.length / 2;
      indices = section === 'coolingFreight'
        ? freightIndices.slice(0, half)
        : freightIndices.slice(half);
    } else if (section === 'coolingFreight' && hasCooling) {
      indices = freightIndices;
    } else if (section === 'frozenFreight' && hasFrozen) {
      indices = freightIndices;
    }
  } else if (section === 'remainingFreight') {
    indices = freightIndices;
  } else {
    throw new Error(`Unknown Kyl freight section: ${section || 'none'}`);
  }

  if (indices.length === 0) {
    throw new Error(`No pages found for Kyl freight section ${section}.`);
  }

  return extractPdfPageIndices(sourceBody, indices);
}
