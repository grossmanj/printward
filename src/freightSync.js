import { GcsClient } from './gcsClient.js';
import { NshiftConsignmentClient } from './nshiftClient.js';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateToVismaInt(date) {
  return Number(`${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function cleanConsignmentNo(value) {
  return String(value || '').trim();
}

function outputObjectName(prefix, orderNumber, kind = 'freight') {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const filePrefix = kind === 'pallet' ? 'pallet' : 'freight';
  return `${normalizedPrefix}${filePrefix}${orderNumber}.pdf`;
}

function normalizeList(values) {
  return new Set((values || []).map(String).map((item) => item.trim()).filter(Boolean));
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedNameSet(values = []) {
  return normalizeList(values).size > 0
    ? new Set(Array.from(normalizeList(values), normalizeName).filter(Boolean))
    : new Set(['kyl- och frysexpressen mälardalen ab']);
}

function numericPackageValue(row, field) {
  const key = String(field || '').trim();
  if (!key) return 0;
  const value = row[key] ?? row[`Freight${key}`] ?? row[`freight${key}`];
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function palletCopiesFromRow(row, fields = ['Val2', 'Val3', 'Val5', 'Val6']) {
  return Math.trunc(fields.reduce((sum, field) => sum + numericPackageValue(row, field), 0));
}

function isPalletDocumentRequired(shipment, config = {}) {
  if (shipment.palletDocumentRequired === false) return false;
  if (shipment.palletDocumentRequired === true) return true;
  if ((shipment.consignments || []).length === 0) return false;
  const distributorNames = normalizedNameSet(config.palletDocumentDistributors || []);
  return distributorNames.has(normalizeName(shipment.distributorName));
}

function filterPdfDocuments(documents) {
  return documents.filter((document) => {
    const contentType = String(document.contentType || '').toLowerCase();
    const name = String(document.name || '').toLowerCase();
    return contentType.includes('pdf') || name.endsWith('.pdf');
  });
}

function normalizeShipment(row, config = {}) {
  const seen = new Set();
  const consignments = [
    ['fresh', row.Txt1],
    ['frozen', row.Txt2]
  ].flatMap(([kind, value]) => {
    const consignmentNo = cleanConsignmentNo(value);
    if (!consignmentNo || seen.has(consignmentNo)) return [];
    seen.add(consignmentNo);
    return [{ kind, consignmentNo }];
  });

  return {
    orderNumber: String(row.OrdNo),
    status: Number(row.Val1 || 0),
    consignments,
    deliveryDate: Number(row.DelDt || 0) || null,
    deliveryMethod: Number(row.DelMt || 0) || null,
    deliveryMethodName: String(row.DeliveryMethodName || '').trim(),
    distributorName: String(row.DistributorName || '').trim(),
    dispatchPriority: Number(row.DelPri || 0) || null,
    freightPalletCopies: Math.max(0, palletCopiesFromRow(row, config.palletCopyFields)),
    palletDocumentRequired: isPalletDocumentRequired({
      distributorName: String(row.DistributorName || '').trim(),
      freightPalletCopies: Math.max(0, palletCopiesFromRow(row, config.palletCopyFields)),
      consignments
    }, config)
  };
}

function applyAllowList(shipments, config) {
  const allowedOrders = normalizeList(config.nshift.allowedOrderNumbers);
  const allowedConsignments = normalizeList(config.nshift.allowedConsignmentNumbers);

  if (allowedOrders.size === 0 && allowedConsignments.size === 0) {
    return shipments;
  }

  return shipments.flatMap((shipment) => {
    if (allowedOrders.has(shipment.orderNumber)) return [shipment];

    const consignments = shipment.consignments.filter((item) => allowedConsignments.has(item.consignmentNo));
    if (consignments.length === 0) return [];
    return [{ ...shipment, consignments }];
  });
}

function dateWindow(config) {
  const today = new Date();
  return {
    fromDelDt: config.nshift.fromDelDt || dateToVismaInt(addDays(today, -config.nshift.lookbackDays)),
    toDelDt: config.nshift.toDelDt || dateToVismaInt(addDays(today, config.nshift.lookaheadDays))
  };
}

async function createSqlPool(config) {
  const module = await import('mssql');
  const sql = module.default || module;
  const orderConfig = config.orderContext;
  const poolConfig = orderConfig.connectionString || {
    server: orderConfig.server,
    port: orderConfig.port,
    database: orderConfig.database,
    user: orderConfig.user,
    password: orderConfig.password,
    options: {
      encrypt: orderConfig.encrypt,
      trustServerCertificate: orderConfig.trustServerCertificate
    },
    requestTimeout: orderConfig.queryTimeoutMs,
    connectionTimeout: orderConfig.queryTimeoutMs
  };

  return {
    sql,
    pool: await new sql.ConnectionPool(poolConfig).connect()
  };
}

export async function fetchBookedFreightShipments(config) {
  if (!config.orderContext.connectionString && !(config.orderContext.server && config.orderContext.database)) {
    throw new Error('SQL Server settings are required for nShift freight sync.');
  }

  const { sql, pool } = await createSqlPool(config);
  const request = pool.request();
  const statuses = config.nshift.bookedStatuses.length > 0 ? config.nshift.bookedStatuses : [2, 8];
  const { fromDelDt, toDelDt } = dateWindow(config);

  request.input('limit', sql.Int, config.nshift.candidateLimit || config.nshift.syncLimit || 100);
  request.input('infCatNo', sql.Int, config.nshift.infCatNo);
  request.input('frInfTp', sql.Int, config.nshift.frInfTp);
  request.input('frInfTp2', sql.Int, config.nshift.frInfTp2);
  request.input('frInfTp3', sql.Int, config.nshift.frInfTp3);
  request.input('fromDelDt', sql.Int, fromDelDt);
  request.input('toDelDt', sql.Int, toDelDt);

  statuses.forEach((status, index) => {
    request.input(`status${index}`, sql.Int, status);
  });

  const statusSql = statuses.map((_, index) => `@status${index}`).join(',');
  const query = `
    SELECT TOP (@limit)
      f.OrdNo,
      f.Val1,
      ISNULL(f.Txt1, '') AS Txt1,
      ISNULL(f.Txt2, '') AS Txt2,
      ISNULL(f.Txt3, '') AS Txt3,
      ISNULL(f.Val2, 0) AS Val2,
      ISNULL(f.Val3, 0) AS Val3,
      ISNULL(f.Val4, 0) AS Val4,
      ISNULL(f.Val5, 0) AS Val5,
      ISNULL(f.Val6, 0) AS Val6,
      ISNULL(f.Val7, 0) AS Val7,
      o.DelDt,
      o.DelMt,
      o.DelPri,
      ISNULL(o.SupNo, 0) AS SupNo,
      ISNULL(deliveryMethod.Txt, '') AS DeliveryMethodName,
      ISNULL(distributor.Nm, '') AS DistributorName
    FROM FreeInf1 f
    LEFT JOIN Ord o ON o.OrdNo = f.OrdNo
    LEFT JOIN Txt deliveryMethod
      ON deliveryMethod.Lang = 46
     AND deliveryMethod.TxtTp = 5
     AND deliveryMethod.TxtNo = o.DelMt
    OUTER APPLY (
      SELECT TOP 1 a.Nm
      FROM Actor a
      WHERE a.SupNo = o.SupNo
      ORDER BY a.ActNo
    ) distributor
    WHERE f.InfCatNo = @infCatNo
      AND f.FrInfTp = @frInfTp
      AND f.FrInfTp2 = @frInfTp2
      AND f.FrInfTp3 = @frInfTp3
      AND f.Val1 IN (${statusSql})
      AND f.OrdNo <> 0
      AND ISNULL(o.TrTp, 0) = 1
      AND ISNULL(o.SupNo, 0) > 0
      AND ISNULL(o.SupNo, 0) NOT IN (55058127)
      AND (ISNULL(f.Txt1, '') <> '' OR ISNULL(f.Txt2, '') <> '')
      AND (@fromDelDt = 0 OR ISNULL(o.DelDt, 0) >= @fromDelDt)
      AND (@toDelDt = 0 OR ISNULL(o.DelDt, 0) <= @toDelDt)
    ORDER BY ISNULL(o.DelDt, 99999999), ISNULL(o.DelPri, 99), ISNULL(o.DelMt, 0), f.OrdNo;
  `;

  try {
    const response = await request.query(query);
    return (response.recordset || []).map((row) => normalizeShipment(row, config.nshift)).filter((shipment) => shipment.consignments.length > 0);
  } finally {
    await pool.close();
  }
}

export async function mergePdfBuffers(buffers) {
  const valid = buffers.filter((buffer) => buffer?.length > 0);
  if (valid.length === 0) throw new Error('No PDF buffers to merge.');
  if (valid.length === 1) return valid[0];

  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();

  for (const buffer of valid) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }

  return Buffer.from(await merged.save());
}

function createOutputStorage(config) {
  return new GcsClient({
    bucket: config.nshift.outputBucket,
    prefix: config.nshift.outputPrefix,
    accessToken: config.nshift.outputAccessToken,
    apiBase: config.nshift.outputApiBase,
    authMode: config.nshift.outputAuthMode
  }, 'freight');
}

async function getExistingObject(storage, objectName) {
  if (typeof storage.getObjectMetadata !== 'function') return null;
  return storage.getObjectMetadata(objectName);
}

export async function syncFreightDocuments(config, overrides = {}) {
  if (!config.nshift.outputBucket) {
    throw new Error('NSHIFT_OUTPUT_GCS_BUCKET, FREIGHT_GCS_BUCKET, or GCS_BUCKET is required for freight sync output.');
  }

  const allShipments = overrides.shipments || await fetchBookedFreightShipments(config);
  const shipments = applyAllowList(allShipments, config);
  const fetchEnabled = config.nshift.fetchEnabled === true || Boolean(overrides.nshiftClient);
  const allowListActive = (config.nshift.allowedOrderNumbers || []).length > 0
    || (config.nshift.allowedConsignmentNumbers || []).length > 0;

  if (!fetchEnabled) {
    return {
      total: shipments.length,
      uploaded: 0,
      skipped: shipments.length,
      failed: 0,
      preview: true,
      results: shipments.map((shipment) => ({
        ok: true,
        preview: true,
        orderNumber: shipment.orderNumber,
        consignmentNumbers: shipment.consignments.map((item) => item.consignmentNo),
        objectName: outputObjectName(config.nshift.outputPrefix, shipment.orderNumber),
        palletObjectName: isPalletDocumentRequired(shipment, config.nshift)
          ? outputObjectName(config.nshift.outputPrefix, shipment.orderNumber, 'pallet')
          : null,
        palletCopies: Number(shipment.freightPalletCopies || 0),
        palletDocumentRequired: isPalletDocumentRequired(shipment, config.nshift),
        uploaded: false,
        skipped: true
      }))
    };
  }

  if (!config.nshift.allowAll && !allowListActive && !overrides.nshiftClient) {
    throw new Error('Refusing to call production nShift without NSHIFT_ALLOWED_ORDER_NUMBERS, NSHIFT_ALLOWED_CONSIGNMENT_NUMBERS, or NSHIFT_ALLOW_ALL=true.');
  }

  const storage = overrides.storage || createOutputStorage(config);
  let nshift = overrides.nshiftClient || null;
  const results = [];
  const syncLimit = Math.max(1, Number(config.nshift.syncLimit || 100));
  let nshiftCallCount = 0;

  for (const shipment of shipments) {
    const consignmentNumbers = shipment.consignments.map((item) => item.consignmentNo);
    const objectName = outputObjectName(config.nshift.outputPrefix, shipment.orderNumber);
    const palletRequired = isPalletDocumentRequired(shipment, config.nshift);
    const palletObjectName = palletRequired ? outputObjectName(config.nshift.outputPrefix, shipment.orderNumber, 'pallet') : null;
    const palletCopies = Number(shipment.freightPalletCopies || 0);

    try {
      let existingFreight = null;
      let existingPallet = null;
      if (!config.nshift.dryRun && !config.nshift.forceRefresh) {
        existingFreight = await getExistingObject(storage, objectName);
        existingPallet = palletObjectName ? await getExistingObject(storage, palletObjectName) : null;
        if (existingFreight && (!palletRequired || existingPallet)) {
          results.push({
            ok: true,
            orderNumber: shipment.orderNumber,
            consignmentNumbers,
            objectName,
            palletObjectName,
            palletCopies,
            palletDocumentRequired: palletRequired,
            uploaded: false,
            skipped: true,
            existing: true,
            generation: existingFreight.generation ? String(existingFreight.generation) : null,
            updated: existingFreight.updated || null,
            palletGeneration: existingPallet?.generation ? String(existingPallet.generation) : null,
            palletUpdated: existingPallet?.updated || null
          });
          continue;
        }
      }

      if (nshiftCallCount >= syncLimit) break;
      nshiftCallCount += 1;

      if (!nshift) nshift = new NshiftConsignmentClient(config.nshift);
      let upload = existingFreight
        ? { uploaded: false, skipped: true, existing: true, name: objectName }
        : null;
      let body = null;
      if (!existingFreight) {
        const documents = await nshift.printDocuments(consignmentNumbers);
        const pdfs = filterPdfDocuments(documents).map((document) => document.body);
        body = await mergePdfBuffers(pdfs);

        upload = config.nshift.dryRun
          ? { uploaded: false, skipped: true, dryRun: true, name: objectName }
          : await storage.uploadObjectIfChanged(objectName, body, { contentType: 'application/pdf' });
      }

      let palletUpload = null;
      let palletBytes = 0;
      if (palletRequired && !existingPallet) {
        if (config.nshift.palletFetchEnabled === false) {
          palletUpload = { uploaded: false, skipped: true, disabled: true, name: palletObjectName };
        } else {
          const palletDocuments = await nshift.printDocuments(consignmentNumbers, {
            printOperation: config.nshift.palletPrintOperation || 'print',
            printType: config.nshift.palletPrintType || 2,
            printFormat: config.nshift.palletPrintFormat || config.nshift.printFormat || 'PDF'
          });
          const palletPdfs = filterPdfDocuments(palletDocuments).map((document) => document.body);
          const palletBody = await mergePdfBuffers(palletPdfs);
          palletBytes = palletBody.length;
          palletUpload = config.nshift.dryRun
            ? { uploaded: false, skipped: true, dryRun: true, name: palletObjectName }
            : await storage.uploadObjectIfChanged(palletObjectName, palletBody, { contentType: 'application/pdf' });
        }
      } else if (palletRequired && existingPallet) {
        palletUpload = { uploaded: false, skipped: true, existing: true, name: palletObjectName };
      }

      results.push({
        ok: true,
        orderNumber: shipment.orderNumber,
        consignmentNumbers,
        objectName,
        palletObjectName,
        palletCopies,
        palletDocumentRequired: palletRequired,
        bytes: body?.length || 0,
        palletBytes,
        uploaded: Boolean(upload?.uploaded || palletUpload?.uploaded),
        skipped: Boolean(upload?.skipped && (!palletRequired || palletUpload?.skipped)),
        freightUploaded: Boolean(upload?.uploaded),
        freightSkipped: Boolean(upload?.skipped),
        palletUploaded: Boolean(palletUpload?.uploaded),
        palletSkipped: Boolean(palletUpload?.skipped)
      });
    } catch (error) {
      results.push({
        ok: false,
        orderNumber: shipment.orderNumber,
        consignmentNumbers,
        objectName,
        palletObjectName,
        palletCopies,
        palletDocumentRequired: palletRequired,
        error: error.message
      });
    }
  }

  return {
    total: results.length,
    uploaded: results.filter((result) => result.uploaded).length,
    skipped: results.filter((result) => result.ok && result.skipped).length,
    failed: results.filter((result) => !result.ok).length,
    results
  };
}
