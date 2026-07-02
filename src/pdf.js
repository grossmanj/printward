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
