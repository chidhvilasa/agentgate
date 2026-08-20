import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildControlApi, LOCAL_AUTH_TOKEN } from '../src/api/control.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';

describe('Control API Security', () => {
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;
  let app: ReturnType<typeof buildControlApi>;

  beforeEach(() => {
    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    app = buildControlApi({
      storage,
      approvalManager,
      version: '1.0',
      gatewayPort: 8080,
      dbPath: ':memory:',
      onEvent: () => {}
    });
  });

  afterEach(async () => {
    storage.close();
    await app.close();
  });

  it('rejects requests without valid auth token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'host': 'localhost',
        'x-agentgate-token': 'wrong-token'
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with non-loopback host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'host': 'evil.com',
        'x-agentgate-token': LOCAL_AUTH_TOKEN
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts valid requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        'host': 'localhost',
        'x-agentgate-token': LOCAL_AUTH_TOKEN
      }
    });

    expect(response.statusCode).toBe(200);
  });
});
