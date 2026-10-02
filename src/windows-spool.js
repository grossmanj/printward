import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EVENT_LOG = 'Microsoft-Windows-PrintService/Operational';
const QUERY = [
  "$ErrorActionPreference = 'Stop'",
  `$log = Get-WinEvent -ListLog '${EVENT_LOG}'`,
  "if (-not $log.IsEnabled) { throw 'PrintService Operational log is disabled' }",
  `$events = @(Get-WinEvent -FilterHashtable @{LogName='${EVENT_LOG}'; Id=307} -MaxEvents 50 -ErrorAction SilentlyContinue)`,
  '$rows = @($events | ForEach-Object { [pscustomobject]@{ recordId = $_.RecordId; printer = $_.Properties[4].Value; document = $_.Properties[1].Value } })',
  'ConvertTo-Json -InputObject $rows -Compress'
].join('; ');

export function parsePrintedEvents(output) {
  const value = JSON.parse(String(output || '[]'));
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map((event) => ({
    recordId: Number(event.recordId),
    printer: String(event.printer || '').trim(),
    document: String(event.document || '').trim()
  })).filter((event) => Number.isSafeInteger(event.recordId));
}

export function hasNewPrintedEvent(events, baseline, printerName) {
  const expected = String(printerName || '').trim().toLocaleLowerCase();
  if (!expected) return false;
  return events.some((event) => event.recordId > baseline &&
    event.printer.toLocaleLowerCase() === expected);
}

export async function getPrintedEvents(run = execFileAsync) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], {
    windowsHide: true,
    timeout: 10_000
  });
  return parsePrintedEvents(stdout);
}

export async function confirmWindowsSpool({ printerName, baseline, query = getPrintedEvents,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 20 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const events = await query();
    if (hasNewPrintedEvent(events, baseline, printerName)) return true;
    if (attempt + 1 < attempts) await wait(1000);
  }
  throw new Error(`Windows did not confirm a completed spool job on printer "${printerName}". Check the Windows queue and the printer before retrying; the document may still print later.`);
}

export function newestPrintedEventId(events) {
  return Math.max(0, ...events.map((event) => event.recordId));
}
