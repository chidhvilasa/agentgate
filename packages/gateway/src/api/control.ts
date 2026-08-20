import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuditStorage } from '../storage.js';
import type { ApprovalManager } from '../approval.js';
import type { AuditEvent, Approval } from '@agentgate/protocol';
import cors from '@fastify/cors';

/** Per-launch local auth token — generated fresh on each start. */
export let LOCAL_AUTH_TOKEN = '';

/** Allowed localhost hostnames. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function buildControlApi(opts: {
  storage: AuditStorage;
  approvalManager: ApprovalManager;
  version: string;
  gatewayPort: number;
  dbPath: string;
  onEvent: (handler: (event: AuditEvent | Approval) => void) => void;
}) {
  LOCAL_AUTH_TOKEN = randomBytes(32).toString('hex');

  const app = Fastify({ logger: false });

  app.register(cors, {
    origin: ['http://127.0.0.1:5173', 'http://localhost:5173'], // Vite dev server
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-agentgate-token'],
  });

  // ── Security Middleware ────────────────────────────────────────────────────

  // 1. Loopback-only binding is enforced in server.ts listen() call.
  // 2. Host/Origin header validation.
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers['host'] ?? '').split(':')[0];
    if (!LOOPBACK_HOSTS.has(host)) {
      reply.code(403).send({ error: 'Forbidden: invalid Host header.' });
      return;
    }

    const origin = request.headers['origin'];
    if (origin) {
      try {
        const originHost = new URL(origin).hostname;
        if (!LOOPBACK_HOSTS.has(originHost)) {
          reply.code(403).send({ error: 'Forbidden: invalid Origin header.' });
          return;
        }
      } catch {
        reply.code(403).send({ error: 'Forbidden: malformed Origin header.' });
        return;
      }
    }
    
    reply.header('Referrer-Policy', 'no-referrer');

    // 3. Auth token check (skip for SSE stream — token passed as query param).
    const path = request.url.split('?')[0];
    if (path === '/api/events/stream') {
      const token = (request.query as Record<string, string>)['token'];
      if (token !== LOCAL_AUTH_TOKEN) {
        reply.code(401).send({ error: 'Unauthorized.' });
        return;
      }
      return;
    }

    const token = request.headers['x-agentgate-token'];
    if (token !== LOCAL_AUTH_TOKEN) {
      reply.code(401).send({ error: 'Unauthorized.' });
    }
  });

  // ── Health ─────────────────────────────────────────────────────────────────

  app.get('/api/health', async () => ({
    status: 'ok',
    version: opts.version,
    uptime_seconds: Math.floor(process.uptime()),
    gateway_port: opts.gatewayPort,
    db_path: opts.dbPath,
  }));

  // ── Events ─────────────────────────────────────────────────────────────────

  app.get('/api/events', async (request) => {
    const q = request.query as Record<string, string>;
    return opts.storage.listEvents({
      limit: q.limit ? parseInt(q.limit) : 50,
      offset: q.offset ? parseInt(q.offset) : 0,
      status: q.status,
      tool: q.tool,
    });
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const event = opts.storage.getEvent(request.params.id);
    if (!event) reply.code(404).send({ error: 'Event not found.' });
    return event;
  });

  // ── SSE Live Stream ────────────────────────────────────────────────────────

  app.get('/api/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const handler = (payload: AuditEvent | Approval) => {
      send('audit_event', payload);
    };

    opts.onEvent(handler);

    // Heartbeat
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
    });

    // Keep the connection alive
    await new Promise<void>((resolve) => request.raw.on('close', resolve));
  });

  // ── Approvals ──────────────────────────────────────────────────────────────

  app.get('/api/approvals', async () => opts.approvalManager.listPending());

  app.post<{ Params: { id: string }; Body: { event_id: string } }>(
    '/api/approvals/:id/approve',
    async (request, reply) => {
      // Confused-deputy prevention: verify event_id matches the approval.
      const approval = opts.storage.getApproval(request.params.id);
      if (!approval) return reply.code(404).send({ error: 'Approval not found.' });
      if (request.body.event_id !== approval.event_id) {
        return reply.code(400).send({ error: 'event_id does not match this approval.' });
      }

      const result = opts.approvalManager.approve(request.params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return { approval_id: request.params.id, status: 'APPROVED' };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/approvals/:id/deny',
    async (request, reply) => {
      const result = opts.approvalManager.deny(request.params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return { approval_id: request.params.id, status: 'DENIED' };
    }
  );

  return app;
}
