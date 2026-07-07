import fs from 'node:fs/promises';

const ACTIVE_ORDER_CANCELLED_MASK = 536870912;
const ACTIVE_ORDER_PROCESSED_MASK = 12582912;
const DEFAULT_ACTIVE_ORDER_TYPES = new Set([1, 6, 9]);
const FREIGHT_OPTIONAL_DISTRIBUTOR_NOS = new Set([55058127]);
const FREIGHT_OPTIONAL_DISTRIBUTOR_NAMES = new Set(['best transport ab']);
const DEFAULT_PALLET_COPY_FIELDS = ['Val2', 'Val3', 'Val5', 'Val6'];
const DEFAULT_PALLET_DOCUMENT_DISTRIBUTOR_NAMES = new Set(['kyl- och frysexpressen mälardalen ab']);

function normalizeOrderNumber(value) {
  return String(value || '').trim();
}

function parseNumericOrderNumber(value) {
  const normalized = normalizeOrderNumber(value);
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function vismaDateToIsoDate(value) {
  const text = String(value || '').padStart(8, '0');
  if (!/^\d{8}$/.test(text) || text === '00000000') return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function isoDateToVismaDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  return Number(`${match[1]}${match[2]}${match[3]}`);
}

export function vismaDateTimeToIso(value, time) {
  const date = vismaDateToIsoDate(value);
  if (!date) return null;

  const timeText = String(time || 0).padStart(4, '0');
  const hours = timeText.slice(-4, -2);
  const minutes = timeText.slice(-2);
  return `${date}T${hours}:${minutes}:00`;
}

export function dispatchPriorityToTime(value) {
  const priority = Number(value || 0);
  if (!Number.isFinite(priority) || priority <= 0) return null;

  const hour = Math.trunc(priority);
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:00`;
}

function isActiveOrder(row) {
  const status = Number(row.OrdPrSt || row.processStatus || 0);
  const transactionType = Number(row.TrTp || row.transactionType || 1);
  const orderType = Number(row.OrdTp || row.orderType || 1);

  return transactionType === 1
    && (status & ACTIVE_ORDER_CANCELLED_MASK) === 0
    && (status & ACTIVE_ORDER_PROCESSED_MASK) === 0
    && DEFAULT_ACTIVE_ORDER_TYPES.has(orderType);
}

function normalizeLine(line) {
  return {
    lineNo: Number(line.lineNo ?? line.LnNo ?? 0),
    productNo: String(line.productNo ?? line.ProdNo ?? ''),
    description: String(line.description ?? line.Descr ?? ''),
    quantity: Number(line.quantity ?? line.Count ?? line.NoInvoAb ?? 0),
    unit: String(line.unit ?? line.SalesUnitDescription ?? line.Unit ?? ''),
    note: String(line.note ?? line.TrInf2 ?? line.WebPg ?? '')
  };
}

function normalizeDistributorName(value) {
  return String(value || '').trim().toLowerCase();
}

function isFreightRequiredForDistributor(distributorNo, distributorName) {
  if (distributorNo <= 0) return false;
  if (FREIGHT_OPTIONAL_DISTRIBUTOR_NOS.has(distributorNo)) return false;
  if (FREIGHT_OPTIONAL_DISTRIBUTOR_NAMES.has(normalizeDistributorName(distributorName))) return false;
  return true;
}

function normalizeDistributorSet(values = []) {
  const normalized = values
    .map(normalizeDistributorName)
    .filter(Boolean);
  return new Set(normalized.length > 0 ? normalized : DEFAULT_PALLET_DOCUMENT_DISTRIBUTOR_NAMES);
}

function isPalletDocumentDistributor(distributorName, names) {
  return normalizeDistributorSet(names).has(normalizeDistributorName(distributorName));
}

function numericPackageValue(row, field) {
  const key = String(field || '').trim();
  if (!key) return 0;
  const value = row[key] ?? row[`Freight${key}`] ?? row[`freight${key}`];
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function palletCopiesFromRow(row, fields = DEFAULT_PALLET_COPY_FIELDS) {
  return Math.trunc(fields.reduce((sum, field) => sum + numericPackageValue(row, field), 0));
}

function packingDepartmentLabel(row) {
  const bit = Number(row.departmentBit ?? row.DepartmentBit ?? 0);
  if (bit === 1) return 'Dry';
  if (bit === 2) return 'Frozen';
  if (bit === 4) return 'Fresh/Other';

  const department = String(row.department ?? row.Department ?? '').trim();
  if (department.toLowerCase() === 'other') return 'Fresh/Other';
  return department || 'Fresh/Other';
}

function normalizePackingDepartment(row) {
  const departmentBit = Number(row.departmentBit ?? row.DepartmentBit ?? 4) || 4;
  return {
    department: packingDepartmentLabel(row),
    departmentBit,
    linesLeft: Number(row.linesLeft ?? row.LinesLeftToPack ?? 0) || 0,
    quantityLeft: Number(row.quantityLeft ?? row.QuantityLeftToPack ?? 0) || 0
  };
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(
    values.map((value) => String(value || '').trim()).filter(Boolean)
  ));
}

function normalizeOrderContext(row, lines = [], packingDepartments = [], options = {}) {
  const orderNumber = normalizeOrderNumber(row.orderNumber ?? row.OrdNo);
  const topLines = lines.map(normalizeLine).filter((line) => line.productNo || line.description);
  const normalizedPackingDepartments = (packingDepartments.length > 0 ? packingDepartments : row.packingDepartments || row.PackingDepartments || [])
    .map(normalizePackingDepartment)
    .filter((department) => department.linesLeft > 0 || department.quantityLeft !== 0)
    .sort((left, right) => left.departmentBit - right.departmentBit);
  const packingLinesLeft = normalizedPackingDepartments.reduce((sum, department) => sum + department.linesLeft, 0);
  const packingQuantityLeft = normalizedPackingDepartments.reduce((sum, department) => sum + department.quantityLeft, 0);
  const totalQuantity = Number(row.totalQuantity ?? topLines.reduce((sum, line) => sum + Number(line.quantity || 0), 0));
  const freightConsignmentNumbers = uniqueNonEmpty([
    row.freightConsignmentFresh ?? row.FreightConsignmentFresh,
    row.freightConsignmentFrozen ?? row.FreightConsignmentFrozen
  ]);
  const distributorNo = Number(row.distributorNo ?? row.SupNo ?? 0) || 0;
  const distributorName = String(row.distributorName ?? row.DistributorName ?? '').trim();
  const freightRequired = isFreightRequiredForDistributor(distributorNo, distributorName);
  const palletCopyFields = options.palletCopyFields || row.palletCopyFields || DEFAULT_PALLET_COPY_FIELDS;
  const freightPalletCopies = Math.max(
    0,
    Math.trunc(Number(row.freightPalletCopies ?? row.FreightPalletCopies ?? palletCopiesFromRow(row, palletCopyFields)) || 0)
  );
  const explicitPalletRequired = row.palletDocumentRequired ?? row.PalletDocumentRequired;
  const palletDocumentRequired = typeof explicitPalletRequired === 'boolean'
    ? explicitPalletRequired
    : freightRequired
      && freightPalletCopies > 0
      && isPalletDocumentDistributor(
        distributorName,
        options.palletDocumentDistributors || row.palletDocumentDistributors
      );
  const packerNo = Number(row.packerNo ?? row.Rsp ?? 0) || 0;
  const packerName = packerNo > 0 ? String(row.packerName ?? row.PackerName ?? '').trim() : '';

  return {
    available: true,
    source: row.source || 'sqlserver',
    orderNumber,
    customerNo: Number(row.customerNo ?? row.CustNo ?? 0) || null,
    customerName: String(row.customerName ?? row.CustomerName ?? row.Nm ?? '').trim(),
    deliveryName: String(row.deliveryName ?? row.Nm ?? '').trim(),
    deliveryDate: row.deliveryDate ?? vismaDateToIsoDate(row.DelDt),
    desiredProductionDate: row.desiredProductionDate ?? vismaDateToIsoDate(row.DesProDt),
    createdAt: row.createdAt ?? vismaDateTimeToIso(row.CreDt, row.CreTm),
    changedAt: row.changedAt ?? vismaDateTimeToIso(row.ChDt, row.ChTm),
    orderNote: String(row.orderNote ?? row.Inf2 ?? '').trim(),
    ourReference: String(row.ourReference ?? row.OurRef ?? '').trim(),
    yourReference: String(row.yourReference ?? row.YrRef ?? '').trim(),
    requisitionNo: String(row.requisitionNo ?? row.ReqNo ?? '').trim(),
    consignmentNo: String(row.consignmentNo ?? row.ConsNo ?? '').trim(),
    distributorNo,
    distributorName,
    packerNo,
    packerName,
    freightRequired,
    freightStatus: Number(row.freightStatus ?? row.FreightStatus ?? 0) || null,
    freightConsignmentNumbers,
    freightPalletCopies,
    palletDocumentRequired,
    deliveryMethod: Number(row.deliveryMethod ?? row.DelMt ?? 0) || null,
    deliveryMethodName: String(row.deliveryMethodName ?? row.DeliveryMethodName ?? '').trim(),
    dispatchPriority: Number(row.dispatchPriority ?? row.DelPri ?? 0) || null,
    dispatchTime: row.dispatchTime ?? dispatchPriorityToTime(row.dispatchPriority ?? row.DelPri),
    baseOrderNo: Number(row.baseOrderNo ?? row.OrdBasNo ?? 0) || null,
    processStatus: Number(row.processStatus ?? row.OrdPrSt ?? 0) || 0,
    isActive: typeof row.isActive === 'boolean' ? row.isActive : isActiveOrder(row),
    lineCount: Number(row.lineCount ?? topLines.length) || 0,
    totalQuantity,
    topLines,
    packingDepartments: normalizedPackingDepartments,
    packingLinesLeft,
    packingQuantityLeft,
    packingBlocked: packingLinesLeft > 0
  };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

class DisabledOrderContextClient {
  constructor(mode = 'disabled') {
    this.mode = mode;
  }

  async getByOrderNumbers() {
    return new Map();
  }

  async getByDeliveryDate() {
    return new Map();
  }

  async health() {
    return { mode: this.mode, available: false };
  }
}

export class MockOrderContextClient {
  constructor(filePath) {
    this.mode = 'mock';
    this.filePath = filePath;
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    const raw = await fs.readFile(this.filePath, 'utf8');
    const contexts = JSON.parse(raw).map((row) => normalizeOrderContext({ ...row, source: 'mock' }, row.topLines || []));
    this.cache = new Map(contexts.map((context) => [context.orderNumber, context]));
    return this.cache;
  }

  async getByOrderNumbers(orderNumbers) {
    const cache = await this.load();
    const result = new Map();

    for (const orderNumber of orderNumbers) {
      const key = normalizeOrderNumber(orderNumber);
      if (cache.has(key)) result.set(key, cache.get(key));
    }

    return result;
  }

  async getByDeliveryDate(deliveryDate) {
    const cache = await this.load();
    return new Map(
      Array.from(cache.entries()).filter(([, context]) => context.deliveryDate === deliveryDate)
    );
  }

  async health() {
    return { mode: 'mock', available: true };
  }
}

export class SqlServerOrderContextClient {
  constructor(config) {
    this.mode = 'sqlserver';
    this.config = config;
    this.pool = null;
    this.cache = new Map();
  }

  get enabled() {
    return Boolean(this.config.connectionString || (this.config.server && this.config.database));
  }

  async getSql() {
    const module = await import('mssql');
    return module.default || module;
  }

  async getPool() {
    if (this.pool?.connected) return this.pool;
    if (!this.enabled) {
      throw new Error('SQL Server order context is enabled, but no SQL connection settings are configured.');
    }

    const sql = await this.getSql();
    const poolConfig = this.config.connectionString || {
      server: this.config.server,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      options: {
        encrypt: this.config.encrypt,
        trustServerCertificate: this.config.trustServerCertificate
      },
      requestTimeout: this.config.queryTimeoutMs,
      connectionTimeout: this.config.queryTimeoutMs
    };

    this.pool = await new sql.ConnectionPool(poolConfig).connect();
    return this.pool;
  }

  async getByOrderNumbers(orderNumbers) {
    const numericOrderNumbers = Array.from(new Set(
      orderNumbers.map(parseNumericOrderNumber).filter(Boolean)
    )).slice(0, this.config.maxOrdersPerQuery || 500);

    const result = new Map();
    if (numericOrderNumbers.length === 0) return result;

    const missing = [];
    const now = Date.now();
    for (const orderNumber of numericOrderNumbers) {
      const cached = this.cache.get(String(orderNumber));
      if (cached && cached.expiresAt > now) {
        result.set(String(orderNumber), cached.value);
      } else {
        missing.push(orderNumber);
      }
    }

    const batchSize = Math.max(1, Math.min(Number(this.config.maxOrdersPerQuery || 500), 500));
    for (const batch of chunk(missing, batchSize)) {
      const fetched = await this.fetchBatch(batch);
      for (const context of fetched.values()) {
        const key = context.orderNumber;
        result.set(key, context);
        this.cache.set(key, {
          value: context,
          expiresAt: now + (this.config.cacheMs || 15_000)
        });
      }
    }

    return result;
  }

  async getByDeliveryDate(deliveryDate) {
    const delDt = isoDateToVismaDate(deliveryDate);
    if (!delDt) return new Map();

    const sql = await this.getSql();
    const pool = await this.getPool();
    const request = pool.request();
    request.input('delDt', sql.Int, delDt);
    request.input('limit', sql.Int, this.config.maxOrdersPerQuery || 500);

    const query = `
      SELECT TOP (@limit) o.OrdNo
      FROM Ord o
      WHERE o.DelDt = @delDt
        AND o.TrTp = 1
        AND (ISNULL(o.OrdPrSt, 0) & 536870912) = 0
        AND ((ISNULL(o.OrdPrSt, 0) & 8) = 8 OR (ISNULL(o.OrdPrSt, 0) & 8192) = 8192)
        AND ISNULL(o.DelMt, 0) NOT IN (6, 40, 150, 151, 152)
      ORDER BY ISNULL(o.DelPri, 99), ISNULL(o.DelMt, 0), o.OrdNo;
    `;

    const response = await request.query(query);
    const orderNumbers = (response.recordset || []).map((row) => row.OrdNo).filter(Boolean);
    return this.getByOrderNumbers(orderNumbers);
  }

  async fetchBatch(orderNumbers) {
    const sql = await this.getSql();
    const pool = await this.getPool();
    const request = pool.request();

    orderNumbers.forEach((orderNumber, index) => {
      request.input(`ord${index}`, sql.Int, orderNumber);
    });

    const freightStatuses = Array.isArray(this.config.freightBookedStatuses) && this.config.freightBookedStatuses.length > 0
      ? this.config.freightBookedStatuses
      : [2, 8];
    request.input('freightInfCatNo', sql.Int, this.config.freightInfCatNo || 8376);
    request.input('freightFrInfTp', sql.Int, this.config.freightFrInfTp || 1213);
    request.input('freightFrInfTp2', sql.Int, this.config.freightFrInfTp2 || 2386);
    request.input('freightFrInfTp3', sql.Int, this.config.freightFrInfTp3 || 5325);
    freightStatuses.forEach((status, index) => {
      request.input(`freightStatus${index}`, sql.Int, status);
    });

    const valuesSql = orderNumbers.map((_, index) => `(@ord${index})`).join(',');
    const freightStatusSql = freightStatuses.map((_, index) => `@freightStatus${index}`).join(',');
    const query = `
      DECLARE @OrderNos TABLE (OrdNo INT NOT NULL PRIMARY KEY);
      INSERT INTO @OrderNos (OrdNo) VALUES ${valuesSql};

      SELECT
        o.OrdNo,
        o.CustNo,
        o.CreDt,
        o.CreTm,
        o.ChDt,
        o.ChTm,
        o.DelDt,
        o.DesProDt,
        o.OrdPrSt,
        o.TrTp,
        o.OrdTp,
        ISNULL(o.Nm, '') AS Nm,
        o.OrdBasNo,
        ISNULL(o.SupNo, 0) AS SupNo,
        ISNULL(o.Rsp, 0) AS Rsp,
        o.DelMt,
        o.DelPri,
        ISNULL(deliveryMethod.Txt, '') AS DeliveryMethodName,
        ISNULL(o.ConsNo, '') AS ConsNo,
        ISNULL(o.OurRef, '') AS OurRef,
        ISNULL(o.YrRef, '') AS YrRef,
        ISNULL(o.ReqNo, '') AS ReqNo,
        ISNULL(o.Inf2, '') AS Inf2,
        ISNULL(NULLIF(o.Nm, ''), ISNULL(customer.Nm, '')) AS CustomerName,
        ISNULL(distributor.Nm, '') AS DistributorName,
        ISNULL(packer.Nm, '') AS PackerName,
        CASE
          WHEN ISNULL(o.SupNo, 0) > 0
           AND ISNULL(o.SupNo, 0) NOT IN (55058127)
           AND LOWER(LTRIM(RTRIM(ISNULL(distributor.Nm, '')))) NOT IN ('best transport ab')
          THEN 1
          ELSE 0
        END AS FreightRequired,
        ISNULL(freight.Val1, 0) AS FreightStatus,
        ISNULL(freight.Txt1, '') AS FreightConsignmentFresh,
        ISNULL(freight.Txt2, '') AS FreightConsignmentFrozen,
        ISNULL(freight.Val2, 0) AS FreightVal2,
        ISNULL(freight.Val3, 0) AS FreightVal3,
        ISNULL(freight.Val4, 0) AS FreightVal4,
        ISNULL(freight.Val5, 0) AS FreightVal5,
        ISNULL(freight.Val6, 0) AS FreightVal6,
        ISNULL(freight.Val7, 0) AS FreightVal7
      FROM Ord o
      INNER JOIN @OrderNos f ON f.OrdNo = o.OrdNo
      LEFT JOIN Txt deliveryMethod
        ON deliveryMethod.Lang = 46
       AND deliveryMethod.TxtTp = 5
       AND deliveryMethod.TxtNo = o.DelMt
      OUTER APPLY (
        SELECT TOP 1 a.Nm
        FROM Actor a
        WHERE a.CustNo = o.CustNo
        ORDER BY a.ActNo
      ) customer
      OUTER APPLY (
        SELECT TOP 1 a.Nm
        FROM Actor a
        WHERE a.SupNo = o.SupNo
        ORDER BY a.ActNo
      ) distributor
      OUTER APPLY (
        SELECT TOP 1 a.Nm
        FROM Actor a
        WHERE a.EmpNo = o.Rsp
          AND ISNULL(o.Rsp, 0) > 0
        ORDER BY a.ActNo
      ) packer
      OUTER APPLY (
        SELECT TOP 1
          info.OrdNo,
          info.Val1,
          info.Txt1,
          info.Txt2,
          info.Val2,
          info.Val3,
          info.Val4,
          info.Val5,
          info.Val6,
          info.Val7
        FROM FreeInf1 info
        WHERE info.OrdNo = o.OrdNo
          AND info.InfCatNo = @freightInfCatNo
          AND info.FrInfTp = @freightFrInfTp
          AND info.FrInfTp2 = @freightFrInfTp2
          AND info.FrInfTp3 = @freightFrInfTp3
          AND info.Val1 IN (${freightStatusSql})
          AND (ISNULL(info.Txt1, '') <> '' OR ISNULL(info.Txt2, '') <> '')
        ORDER BY info.OrdNo
      ) freight
      WHERE o.TrTp = 1
        AND (ISNULL(o.OrdPrSt, 0) & 536870912) = 0
        AND ((ISNULL(o.OrdPrSt, 0) & 8) = 8 OR (ISNULL(o.OrdPrSt, 0) & 8192) = 8192)
        AND ISNULL(o.DelMt, 0) NOT IN (6, 40, 150, 151, 152);

      SELECT
        l.OrdNo,
        COUNT(*) AS LineCount,
        CAST(ROUND(SUM(ISNULL(l.NoInvoAb, 0) + ISNULL(l.NoFin, 0)), 2) AS DECIMAL(18, 2)) AS TotalQuantity
      FROM OrdLn l
      INNER JOIN @OrderNos f ON f.OrdNo = l.OrdNo
      WHERE l.TrTp = 1
        AND ISNULL(l.ProdNo, '') <> ''
        AND (ISNULL(l.NoInvoAb, 0) + ISNULL(l.NoFin, 0)) > 0
        AND ISNULL(l.Un, 0) <> 0
        AND (ISNULL(l.ExcPrint, 0) & 16384) = 0
      GROUP BY l.OrdNo;

      WITH RankedLines AS (
        SELECT
          l.OrdNo,
          l.LnNo,
          ISNULL(l.ProdNo, '') AS ProdNo,
          ISNULL(l.Descr, '') AS Descr,
          CAST(ROUND(ISNULL(l.NoInvoAb, 0) + ISNULL(l.NoFin, 0), 2) AS DECIMAL(18, 2)) AS Quantity,
          ISNULL(CASE WHEN ISNULL(p.TrInf3, '') <> '' THEN p.TrInf3 ELSE su.Descr END, ISNULL(u.Descr, '')) AS Unit,
          ISNULL(l.TrInf2, ISNULL(l.WebPg, '')) AS Note,
          ROW_NUMBER() OVER (PARTITION BY l.OrdNo ORDER BY l.LnNo) AS rn
        FROM OrdLn l
        INNER JOIN @OrderNos f ON f.OrdNo = l.OrdNo
        LEFT JOIN Prod p ON p.ProdNo = l.ProdNo
        LEFT JOIN Unit su ON su.Un = p.StSaleUn
        LEFT JOIN Unit u ON u.Un = l.Un
        WHERE l.TrTp = 1
          AND ISNULL(l.ProdNo, '') <> ''
          AND (ISNULL(l.NoInvoAb, 0) + ISNULL(l.NoFin, 0)) > 0
          AND ISNULL(l.Un, 0) <> 0
          AND (ISNULL(l.ExcPrint, 0) & 16384) = 0
      )
      SELECT OrdNo, LnNo, ProdNo, Descr, Quantity, Unit, Note
      FROM RankedLines
      WHERE rn <= 3
      ORDER BY OrdNo, LnNo;

      WITH LinesLeftToPack AS (
        SELECT
          l.OrdNo,
          l.NoInvoAb,
          Department =
            CASE
              WHEN p.Gr7 = 2 THEN 'Dry'
              WHEN p.Gr7 = 5 THEN 'Frozen'
              ELSE 'Fresh/Other'
            END,
          DepartmentBit =
            CASE
              WHEN p.Gr7 = 2 THEN 1
              WHEN p.Gr7 = 5 THEN 2
              ELSE 4
            END
        FROM OrdLn l
        INNER JOIN @OrderNos f ON f.OrdNo = l.OrdNo
        LEFT JOIN Prod p ON p.ProdNo = l.ProdNo
        WHERE l.TrTp = 1
          AND ISNULL(l.NoInvoAb, 0) <> 0
          AND (ISNULL(l.ExcPrint, 0) & 16384) = 0
      )
      SELECT
        OrdNo,
        Department,
        DepartmentBit,
        LinesLeftToPack = COUNT(*),
        QuantityLeftToPack = CAST(ROUND(SUM(ISNULL(NoInvoAb, 0)), 2) AS DECIMAL(18, 2))
      FROM LinesLeftToPack
      GROUP BY OrdNo, Department, DepartmentBit
      ORDER BY OrdNo, DepartmentBit;
    `;

    const response = await request.query(query);
    const orderRows = response.recordsets?.[0] || [];
    const summaryRows = response.recordsets?.[1] || [];
    const lineRows = response.recordsets?.[2] || [];
    const packingRows = response.recordsets?.[3] || [];

    const summaries = new Map(summaryRows.map((row) => [String(row.OrdNo), row]));
    const linesByOrder = new Map();
    for (const row of lineRows) {
      const key = String(row.OrdNo);
      if (!linesByOrder.has(key)) linesByOrder.set(key, []);
      linesByOrder.get(key).push({
        lineNo: row.LnNo,
        productNo: row.ProdNo,
        description: row.Descr,
        quantity: Number(row.Quantity || 0),
        unit: row.Unit,
        note: row.Note
      });
    }

    const packingByOrder = new Map();
    for (const row of packingRows) {
      const key = String(row.OrdNo);
      if (!packingByOrder.has(key)) packingByOrder.set(key, []);
      packingByOrder.get(key).push({
        department: row.Department,
        departmentBit: row.DepartmentBit,
        linesLeft: Number(row.LinesLeftToPack || 0),
        quantityLeft: Number(row.QuantityLeftToPack || 0)
      });
    }

    const result = new Map();
    for (const row of orderRows) {
      const key = String(row.OrdNo);
      const summary = summaries.get(key) || {};
      const context = normalizeOrderContext({
        ...row,
        lineCount: Number(summary.LineCount || 0),
        totalQuantity: Number(summary.TotalQuantity || 0),
        source: 'sqlserver'
      }, linesByOrder.get(key) || [], packingByOrder.get(key) || [], {
        palletCopyFields: this.config.palletCopyFields,
        palletDocumentDistributors: this.config.palletDocumentDistributors
      });
      result.set(key, context);
    }

    return result;
  }

  async health() {
    if (!this.enabled) return { mode: 'sqlserver', available: false };
    try {
      const pool = await this.getPool();
      await pool.request().query('SELECT 1 AS ok');
      return { mode: 'sqlserver', available: true };
    } catch (error) {
      return { mode: 'sqlserver', available: false, error: error.message };
    }
  }
}

export function createOrderContextClient(config) {
  if (config.orderContext.mode === 'mock') {
    return new MockOrderContextClient(config.mockOrderContextFile);
  }

  if (config.orderContext.mode === 'sqlserver') {
    return new SqlServerOrderContextClient(config.orderContext);
  }

  return new DisabledOrderContextClient(config.orderContext.mode);
}

export function attachOrderContexts(orders, contextByOrderNumber) {
  return orders.map((order) => ({
    ...order,
    context: contextByOrderNumber.get(order.orderNumber) || {
      available: false,
      source: 'none',
      orderNumber: order.orderNumber,
      customerNo: null,
      customerName: '',
      deliveryName: '',
      deliveryDate: null,
      desiredProductionDate: null,
      createdAt: null,
      changedAt: null,
      orderNote: '',
      ourReference: '',
      yourReference: '',
      requisitionNo: '',
      consignmentNo: '',
      distributorNo: 0,
      distributorName: '',
      packerNo: 0,
      packerName: '',
      freightRequired: false,
      freightStatus: null,
      freightConsignmentNumbers: [],
      freightPalletCopies: 0,
      palletDocumentRequired: false,
      deliveryMethod: null,
      deliveryMethodName: '',
      dispatchPriority: null,
      dispatchTime: null,
      baseOrderNo: null,
      processStatus: 0,
      isActive: null,
      lineCount: 0,
      totalQuantity: 0,
      topLines: [],
      packingDepartments: [],
      packingLinesLeft: 0,
      packingQuantityLeft: 0,
      packingBlocked: false
    }
  }));
}
