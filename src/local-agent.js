import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AGENT_PORT = Number(process.env.PRINTWARD_AGENT_PORT || 37951);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizePrinterName(name) {
  return String(name || '').trim();
}

async function commandExists(command) {
  try {
    await execFileAsync(command, ['--version']);
    return true;
  } catch {
    try {
      await execFileAsync(command, []);
      return true;
    } catch {
      return false;
    }
  }
}

async function listCupsPrinters() {
  const printers = [];
  const { stdout } = await execFileAsync('lpstat', ['-e']);
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim();
    if (name) printers.push({ name, isDefault: false });
  }

  try {
    const result = await execFileAsync('lpstat', ['-d']);
    const match = result.stdout.match(/:\s*(.+)\s*$/);
    if (match) {
      const defaultName = match[1].trim();
      for (const printer of printers) {
        printer.isDefault = printer.name === defaultName;
      }
    }
  } catch {
    // Default printer is optional.
  }

  return printers;
}

async function listWindowsPrinters() {
  const command = [
    'Get-CimInstance Win32_Printer |',
    'Select-Object Name,Default |',
    'ConvertTo-Json'
  ].join(' ');

  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command]);
  const parsed = JSON.parse(stdout || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter(Boolean).map((printer) => ({
    name: printer.Name,
    isDefault: Boolean(printer.Default)
  }));
}

async function listPrinters() {
  if (os.platform() === 'win32') return listWindowsPrinters();
  return listCupsPrinters();
}

function safeFileName(value) {
  return String(value || 'document.pdf').replace(/[^0-9A-Za-z._-]+/g, '_');
}

async function downloadDocument(document, dir) {
  const response = await fetch(document.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${document.fileName || document.name}: ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(dir, safeFileName(`${document.orderNumber}-${document.type}-${document.fileName}`));
  await fs.writeFile(filePath, body);
  return filePath;
}

function cupsArgsForOptions(printerName, options, files) {
  const args = [];
  const normalizedPrinter = normalizePrinterName(printerName || options.printerName);
  if (normalizedPrinter) args.push('-d', normalizedPrinter);

  const copies = Math.max(1, Number(options.copies || 1));
  if (copies > 1) args.push('-n', String(copies));

  if (options.duplex === true) args.push('-o', 'sides=two-sided-long-edge');
  if (options.duplex === false) args.push('-o', 'sides=one-sided');

  if (options.colorMode === 'grayscale') args.push('-o', 'print-color-mode=monochrome');
  if (options.colorMode === 'color') args.push('-o', 'print-color-mode=color');

  if (options.staple && options.stapleOption) {
    const stapleOption = String(options.stapleOption).replace(/[\r\n]/g, '').trim();
    if (stapleOption) args.push('-o', stapleOption);
  }

  args.push(...files);
  return args;
}

async function printWithCups(order, files, printerName, options) {
  if (!(await commandExists('lp'))) {
    throw new Error('CUPS lp command is not available on this computer.');
  }

  const args = cupsArgsForOptions(printerName, options, files);
  const { stdout, stderr } = await execFileAsync('lp', args);
  return {
    orderNumber: order.orderNumber,
    command: 'lp',
    output: `${stdout || ''}${stderr || ''}`.trim()
  };
}

async function printOrder(order, dir, printerName, options) {
  const files = [];
  for (const document of order.documents || []) {
    files.push(await downloadDocument(document, dir));
  }

  if (files.length === 0) {
    return {
      orderNumber: order.orderNumber,
      skipped: true,
      output: 'No documents in order.'
    };
  }

  if (os.platform() === 'win32') {
    throw new Error('Windows printing requires a native PDF print bridge; CUPS lp is not available.');
  }

  return printWithCups(order, files, printerName, options);
}

async function reportCompletion(callbackUrl, payload) {
  if (!callbackUrl) return;
  await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function handlePrint(body) {
  const jobId = body.jobId || body.manifest?.jobId;
  const orders = body.orders || body.manifest?.orders || [];
  const callbackUrl = body.callbackUrl || body.manifest?.callbackUrl;
  const options = body.options || {};
  const printerName = body.printerName || options.printerName || '';
  const user = body.user || 'operator';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `printward-${jobId || 'job'}-`));
  const results = [];

  try {
    for (const order of orders) {
      results.push(await printOrder(order, dir, printerName, options));
    }

    await reportCompletion(callbackUrl, {
      status: 'printed',
      user,
      printerName,
      agent: os.hostname(),
      results
    });

    return { ok: true, jobId, results };
  } catch (error) {
    await reportCompletion(callbackUrl, {
      status: 'failed',
      user,
      printerName,
      error: error.message,
      results
    }).catch(() => {});

    error.results = results;
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  try {
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        platform: os.platform(),
        hostname: os.hostname()
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/printers') {
      const printers = await listPrinters();
      sendJson(res, 200, { printers });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/print') {
      const body = await readJsonBody(req);
      const result = await handlePrint(body);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Agent route not found.' });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message,
      results: error.results || []
    });
  }
});

server.listen(AGENT_PORT, '127.0.0.1', () => {
  console.log(`Printward local print agent listening on http://127.0.0.1:${AGENT_PORT}`);
});
