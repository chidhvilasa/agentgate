import { describe, it, expect } from 'vitest';
import { computeServerIdentity, buildLaunchFingerprint } from '../src/tool-integrity/identity.js';
import type { DownstreamServer } from '../src/config/registry.js';

function stdioServer(overrides: Partial<Extract<DownstreamServer, { transport: 'stdio' }>> = {}): DownstreamServer {
  return {
    id: 'downstream',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    ...overrides,
  };
}

describe('computeServerIdentity (Milestone 6, ADR-0012)', () => {
  it('is deterministic for identical config', () => {
    const a = computeServerIdentity(stdioServer());
    const b = computeServerIdentity(stdioServer());
    expect(a.identity).toBe(b.identity);
    expect(a.launchFingerprint).toBe(b.launchFingerprint);
  });

  it('distinguishes two servers with the SAME advertised serverId is not applicable here — instead distinguishes two servers with the same command but different config ids', () => {
    const a = computeServerIdentity(stdioServer({ id: 'server-a' }));
    const b = computeServerIdentity(stdioServer({ id: 'server-b' }));
    expect(a.identity).not.toBe(b.identity);
    // The launch fingerprint itself (command/args/env only) is identical —
    // only the id differs — confirming identity is serverId + fingerprint,
    // not fingerprint alone.
    expect(a.launchFingerprint).toBe(b.launchFingerprint);
  });

  it('intentionally changes when the command changes', () => {
    const a = computeServerIdentity(stdioServer({ command: 'node' }));
    const b = computeServerIdentity(stdioServer({ command: 'python' }));
    expect(a.launchFingerprint).not.toBe(b.launchFingerprint);
  });

  it('intentionally changes when args change', () => {
    const a = computeServerIdentity(stdioServer({ args: ['server.js'] }));
    const b = computeServerIdentity(stdioServer({ args: ['server.js', '--dangerous-flag'] }));
    expect(a.launchFingerprint).not.toBe(b.launchFingerprint);
  });

  it('intentionally changes when an env var VALUE changes, without ever storing the raw value', () => {
    const a = computeServerIdentity(stdioServer({ env: { API_KEY: 'secret-value-one' } }));
    const b = computeServerIdentity(stdioServer({ env: { API_KEY: 'secret-value-two' } }));
    expect(a.launchFingerprint).not.toBe(b.launchFingerprint);
    // Neither the identity object nor its JSON-serialized form ever
    // contains the raw secret value.
    expect(JSON.stringify(a)).not.toContain('secret-value-one');
    expect(JSON.stringify(b)).not.toContain('secret-value-two');
  });

  it('intentionally changes when an env var is added or removed', () => {
    const a = computeServerIdentity(stdioServer({ env: { A: '1' } }));
    const b = computeServerIdentity(stdioServer({ env: { A: '1', B: '2' } }));
    expect(a.launchFingerprint).not.toBe(b.launchFingerprint);
  });

  it('is stable regardless of env object key insertion order', () => {
    const a = computeServerIdentity(stdioServer({ env: { A: '1', B: '2' } }));
    const b = computeServerIdentity(stdioServer({ env: { B: '2', A: '1' } }));
    expect(a.launchFingerprint).toBe(b.launchFingerprint);
  });

  it('normalizes harmless backslash-vs-forward-slash path differences in command/args', () => {
    const a = computeServerIdentity(stdioServer({ command: 'C:/tools/server.js' }));
    const b = computeServerIdentity(stdioServer({ command: 'C:\\tools\\server.js' }));
    expect(a.launchFingerprint).toBe(b.launchFingerprint);
  });

  it('works with paths containing spaces', () => {
    const result = computeServerIdentity(stdioServer({ command: 'C:/Program Files/node/node.exe', args: ['my server/index.js'] }));
    expect(result.launchFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never leaks a full raw env value in the identity string itself', () => {
    const result = computeServerIdentity(stdioServer({ env: { SECRET: 'AKIAIOSFODNN7EXAMPLE' } }));
    expect(result.identity).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.launchFingerprint).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('http-transport servers hash a distinct, url-based launch fingerprint', () => {
    const a: DownstreamServer = { id: 's', transport: 'http', url: 'https://example.com/mcp' };
    const b: DownstreamServer = { id: 's', transport: 'http', url: 'https://example.com/mcp2' };
    expect(buildLaunchFingerprint(a)).not.toBe(buildLaunchFingerprint(b));
  });

  it('identity string is safe to display (server id prefix + short hex suffix, no path/secret content)', () => {
    const result = computeServerIdentity(stdioServer({ command: 'C:/Users/realname/secret-project/server.js' }));
    expect(result.identity).toMatch(/^downstream:[0-9a-f]{16}$/);
  });
});
