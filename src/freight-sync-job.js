import { loadConfig } from './config.js';
import { syncFreightDocuments } from './freightSync.js';

const config = loadConfig();

try {
  const result = await syncFreightDocuments(config);
  console.log(JSON.stringify({
    ok: result.failed === 0,
    total: result.total,
    uploaded: result.uploaded,
    skipped: result.skipped,
    failed: result.failed,
    preview: Boolean(result.preview),
    fetchEnabled: config.nshift.fetchEnabled,
    allowAll: config.nshift.allowAll,
    allowedOrderNumbers: config.nshift.allowedOrderNumbers,
    allowedConsignmentNumbers: config.nshift.allowedConsignmentNumbers,
    outputBucket: config.nshift.outputBucket,
    outputPrefix: config.nshift.outputPrefix,
    dryRun: config.nshift.dryRun
  }, null, 2));

  for (const item of result.results) {
    console.log(JSON.stringify(item));
  }

  if (result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
}
