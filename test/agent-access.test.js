import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOriginAllowed, allowedAgentOrigins } from '../src/agentAccess.js';

test('Print Agent permits only configured browser origins', () => {
  const allowed = allowedAgentOrigins('https://printward-demo.example.com,http://127.0.0.1:3100');
  assert.equal(agentOriginAllowed('https://printward-demo.example.com', allowed), true);
  assert.equal(agentOriginAllowed('http://127.0.0.1:3100', allowed), true);
  assert.equal(agentOriginAllowed('https://unrelated.example.com', allowed), false);
  assert.equal(agentOriginAllowed('null', allowed), false);
  assert.equal(agentOriginAllowed(undefined, allowed), true);
});

test('Print Agent defaults cover the current demo and production URLs', () => {
  const allowed = allowedAgentOrigins();
  assert.equal(agentOriginAllowed('https://printward-demo-398996760490.europe-north1.run.app', allowed), true);
  assert.equal(agentOriginAllowed('https://printward-prod-398996760490.europe-north1.run.app', allowed), true);
  assert.equal(agentOriginAllowed('https://another-service.run.app', allowed), false);
});

test('Print Agent rejects malformed allowed origins instead of broadening access', () => {
  assert.throws(() => allowedAgentOrigins('https://printward-demo.example.com/path'), /Invalid Print Agent allowed origin/);
  assert.throws(() => allowedAgentOrigins('https://printward-demo.example.com, *'), /Invalid URL/);
});
