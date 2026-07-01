import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function cleanPrefix(prefix) {
  if (!prefix) return '';
  return prefix.replace(/^\/+/, '');
}

function parseList(value, fallback) {
  if (!value) return fallback;
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const bucket = env.GCS_BUCKET || '';
  const mode = env.GCS_MODE || (bucket ? 'live' : 'mock');
  const freightBucket = env.FREIGHT_GCS_BUCKET || '';
  const gcsPrefix = cleanPrefix(env.GCS_PREFIX || '');
  const defaultNshiftOutputPrefix = gcsPrefix ? `freight/${gcsPrefix}` : 'freight/';
  const liveDefaultDocumentTypes = freightBucket
    ? ['packingSlip', 'attachment', 'freight']
    : ['packingSlip', 'attachment'];
  const defaultDocumentTypes = mode === 'mock'
    ? ['packingSlip', 'attachment', 'freight']
    : liveDefaultDocumentTypes;
  const requiredDocumentTypes = parseList(env.REQUIRED_DOCUMENT_TYPES, defaultDocumentTypes);
  const visibleDocumentTypes = parseList(env.VISIBLE_DOCUMENT_TYPES, requiredDocumentTypes);
  const nshiftBookedStatuses = parseList(env.NSHIFT_BOOKED_STATUSES, ['2', '8']).map(Number).filter(Number.isFinite);

  return {
    port: Number(env.PORT || 3100),
    staticDir: path.join(projectRoot, 'public'),
    dataFile: env.DATA_FILE || path.join(projectRoot, 'data', 'printward-db.json'),
    mockObjectsFile: env.MOCK_GCS_OBJECTS || path.join(projectRoot, 'data', 'mock-gcs-objects.json'),
    mockOrderContextFile: env.MOCK_ORDER_CONTEXT || path.join(projectRoot, 'data', 'mock-order-context.json'),
    ordersCacheMs: Number(env.ORDERS_CACHE_MS || 60_000),
    ordersCacheWarmup: String(env.ORDERS_CACHE_WARMUP || 'true').toLowerCase() !== 'false',
    stateStore: {
      mode: env.STATE_STORE || 'json',
      projectId: env.DATASTORE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT || env.PROJECT_ID || '',
      namespace: env.DATASTORE_NAMESPACE || 'printward',
      kindPrefix: env.DATASTORE_KIND_PREFIX || 'Printward'
    },
    gcs: {
      mode,
      bucket,
      prefix: gcsPrefix,
      accessToken: env.GCS_ACCESS_TOKEN || '',
      apiBase: env.GCS_API_BASE || 'https://storage.googleapis.com/storage/v1',
      authMode: env.GCS_AUTH_MODE || 'auto'
    },
    freightGcs: {
      mode: freightBucket ? 'live' : 'disabled',
      bucket: freightBucket,
      prefix: cleanPrefix(env.FREIGHT_GCS_PREFIX || ''),
      accessToken: env.FREIGHT_GCS_ACCESS_TOKEN || env.GCS_ACCESS_TOKEN || '',
      apiBase: env.FREIGHT_GCS_API_BASE || env.GCS_API_BASE || 'https://storage.googleapis.com/storage/v1',
      authMode: env.FREIGHT_GCS_AUTH_MODE || env.GCS_AUTH_MODE || 'auto'
    },
    documentTypes: {
      required: requiredDocumentTypes,
      visible: visibleDocumentTypes
    },
    orderContext: {
      mode: env.ORDER_CONTEXT_MODE || (
        env.VISMA_BUSINESS_DB_CONNECTION_STRING || env.SQLSERVER_CONNECTION_STRING || env.DB_CONNECTION_STRING
          ? 'sqlserver'
          : (mode === 'mock' ? 'mock' : 'disabled')
      ),
      connectionString: env.VISMA_BUSINESS_DB_CONNECTION_STRING || env.SQLSERVER_CONNECTION_STRING || env.DB_CONNECTION_STRING || '',
      server: env.SQLSERVER_HOST || env.DB_HOST || '',
      port: Number(env.SQLSERVER_PORT || env.DB_PORT || 1433),
      database: env.SQLSERVER_DATABASE || env.DB_NAME || '',
      user: env.SQLSERVER_USER || env.DB_USER || '',
      password: env.SQLSERVER_PASSWORD || env.DB_PASSWORD || '',
      encrypt: String(env.SQLSERVER_ENCRYPT || 'true').toLowerCase() !== 'false',
      trustServerCertificate: String(env.SQLSERVER_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() !== 'false',
      cacheMs: Number(env.ORDER_CONTEXT_CACHE_MS || 15_000),
      queryTimeoutMs: Number(env.ORDER_CONTEXT_QUERY_TIMEOUT_MS || 20_000),
      maxOrdersPerQuery: Number(env.ORDER_CONTEXT_MAX_ORDERS || 500),
      freightInfCatNo: Number(env.NSHIFT_FREEINF1_INFCATNO || 8376),
      freightFrInfTp: Number(env.NSHIFT_FREEINF1_FRINFTP || 1213),
      freightFrInfTp2: Number(env.NSHIFT_FREEINF1_FRINFTP2 || 2386),
      freightFrInfTp3: Number(env.NSHIFT_FREEINF1_FRINFTP3 || 5325),
      freightBookedStatuses: nshiftBookedStatuses
    },
    nshift: {
      endpoint: env.NSHIFT_ENDPOINT || 'https://service.web-ta.net:443/ws/services/ConsignmentWS',
      userName: env.NSHIFT_USERNAME || '',
      groupName: env.NSHIFT_GROUP_NAME || '',
      password: env.NSHIFT_PASSWORD || '',
      printOperation: env.NSHIFT_PRINT_OPERATION || 'printWaybill',
      printType: Number(env.NSHIFT_PRINT_TYPE || 1),
      printFormat: env.NSHIFT_PRINT_FORMAT || 'PDF',
      timeoutMs: Number(env.NSHIFT_TIMEOUT_MS || 30_000),
      syncLimit: Number(env.NSHIFT_SYNC_LIMIT || 100),
      fetchEnabled: String(env.NSHIFT_FETCH_ENABLED || 'false').toLowerCase() === 'true',
      allowAll: String(env.NSHIFT_ALLOW_ALL || 'false').toLowerCase() === 'true',
      allowedOrderNumbers: parseList(env.NSHIFT_ALLOWED_ORDER_NUMBERS, []),
      allowedConsignmentNumbers: parseList(env.NSHIFT_ALLOWED_CONSIGNMENT_NUMBERS, []),
      bookedStatuses: nshiftBookedStatuses,
      infCatNo: Number(env.NSHIFT_FREEINF1_INFCATNO || 8376),
      frInfTp: Number(env.NSHIFT_FREEINF1_FRINFTP || 1213),
      frInfTp2: Number(env.NSHIFT_FREEINF1_FRINFTP2 || 2386),
      frInfTp3: Number(env.NSHIFT_FREEINF1_FRINFTP3 || 5325),
      fromDelDt: Number(env.NSHIFT_SYNC_FROM_DELDT || 0),
      toDelDt: Number(env.NSHIFT_SYNC_TO_DELDT || 0),
      lookbackDays: Number(env.NSHIFT_SYNC_LOOKBACK_DAYS || 3),
      lookaheadDays: Number(env.NSHIFT_SYNC_LOOKAHEAD_DAYS || 14),
      dryRun: String(env.NSHIFT_SYNC_DRY_RUN || 'false').toLowerCase() === 'true',
      outputBucket: env.NSHIFT_OUTPUT_GCS_BUCKET || env.FREIGHT_GCS_BUCKET || env.GCS_BUCKET || '',
      outputPrefix: cleanPrefix(env.NSHIFT_OUTPUT_GCS_PREFIX || env.FREIGHT_GCS_PREFIX || defaultNshiftOutputPrefix),
      outputAccessToken: env.NSHIFT_OUTPUT_GCS_ACCESS_TOKEN || env.FREIGHT_GCS_ACCESS_TOKEN || env.GCS_ACCESS_TOKEN || '',
      outputApiBase: env.NSHIFT_OUTPUT_GCS_API_BASE || env.FREIGHT_GCS_API_BASE || env.GCS_API_BASE || 'https://storage.googleapis.com/storage/v1',
      outputAuthMode: env.NSHIFT_OUTPUT_GCS_AUTH_MODE || env.FREIGHT_GCS_AUTH_MODE || env.GCS_AUTH_MODE || 'auto'
    },
    agent: {
      defaultUrl: env.PRINTWARD_AGENT_URL || 'http://127.0.0.1:37951'
    }
  };
}
