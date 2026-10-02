const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:3100',
  'http://127.0.0.1:3101',
  'http://127.0.0.1:3102',
  'http://127.0.0.1:3103',
  'http://localhost:3100',
  'http://localhost:3101',
  'http://localhost:3102',
  'http://localhost:3103',
  'https://printward-demo-398996760490.europe-north1.run.app',
  'https://printward-prod-398996760490.europe-north1.run.app'
];

export function allowedAgentOrigins(configured = process.env.PRINTWARD_AGENT_ALLOWED_ORIGINS) {
  const entries = configured === undefined ? DEFAULT_ALLOWED_ORIGINS : String(configured).split(',');
  return new Set(entries.map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const url = new URL(entry);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry || url.username || url.password) {
      throw new Error(`Invalid Print Agent allowed origin: ${entry}`);
    }
    return url.origin;
  }));
}

export function agentOriginAllowed(origin, allowedOrigins) {
  // PowerShell diagnostics and other non-browser local clients do not send Origin.
  // A browser's cross-origin request always carries one, including its preflight.
  return !origin || allowedOrigins.has(origin);
}
