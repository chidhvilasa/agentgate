import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { v4 as uuidv4 } from 'uuid';
import {
  evaluate,
  loadPolicyFile,
  normalizePath,
  redactArgumentsForAudit,
  sanitizeErrorMessage,
  type EvaluationInput,
} from '@agentgate/policy';
import type { AgentIdentity, AuditEvent, ToolCall } from '@agentgate/protocol';
import type { AuditStorage } from './storage.js';
import type { ApprovalManager } from './approval.js';
import type { GatewayConfig, DownstreamServer } from './config/registry.js';
import { resolveServer } from './config/registry.js';
import { sanitizeToolResult } from './output-security.js';

export interface PipelineContext {
  storage: AuditStorage;
  approvalManager: ApprovalManager;
  config: GatewayConfig;
  emitEvent: (event: AuditEvent) => void;
}

/** Extracts the primary path from tool arguments (heuristic). */
export function extractPrimaryPath(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file', 'filepath', 'file_path', 'directory', 'dir']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}

/** Extracts command from tool arguments. */
export function extractCommand(args: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'shell', 'exec']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}

/** Extracts host/URL from tool arguments. */
export function extractHost(args: Record<string, unknown>): string | undefined {
  for (const key of ['url', 'host', 'endpoint', 'uri']) {
    if (typeof args[key] === 'string') {
      try {
        return new URL(args[key]).hostname;
      } catch {
        return args[key];
      }
    }
  }
  return undefined;
}

/**
 * Executes a tool call against a downstream stdio MCP server.
 *
 * Each call spawns a fresh client connection. For production, a persistent
 * connection pool would be used; this is intentionally simple for Milestone 1.
 */
async function executeDownstream(
  server: DownstreamServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ result: unknown; error?: string; errorRedacted: boolean }> {
  if (server.transport !== 'stdio') {
    return { result: null, error: 'Only stdio downstream servers are supported in Milestone 1.', errorRedacted: false };
  }

  const client = new Client({ name: 'agentgate-proxy', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...server.env } as Record<string, string>,
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    return { result, errorRedacted: false };
  } catch (err) {
    // ADR-0009: sanitize before this ever reaches the caller — never log or
    // return the raw error. The downstream process is untrusted input.
    const sanitized = sanitizeErrorMessage(err, { source: 'downstream' });
    return { result: null, error: sanitized.message, errorRedacted: sanitized.redacted };
  } finally {
    await client.close();
  }
}

/**
 * Main policy evaluation pipeline.
 *
 * Returns the final AuditEvent (in terminal state) and any execution result.
 * Never throws — errors are captured into the audit event.
 */
export async function runPipeline(opts: {
  ctx: PipelineContext;
  agent: AgentIdentity;
  toolName: string;
  rawArgs: Record<string, unknown>;
  mcpEra: 'modern-2026-07-28' | 'legacy-2025';
  jsonrpcId: string | number | null;
}): Promise<{ event: AuditEvent; result: unknown }> {
  const { ctx, agent, toolName, rawArgs, mcpEra, jsonrpcId } = opts;
  const startTime = Date.now();
  const eventId = uuidv4();
  const createdAt = new Date().toISOString();

  const policy = loadPolicyFile(ctx.config.policy);

  // ── 1. Normalize arguments ─────────────────────────────────────────────────
  const rawPath = extractPrimaryPath(rawArgs);
  const normalizedArgs: Record<string, unknown> = { ...rawArgs };
  if (rawPath) {
    const key = Object.keys(rawArgs).find((k) =>
      ['path', 'file', 'filepath', 'file_path', 'directory', 'dir'].includes(k)
    )!;
    normalizedArgs[key] = normalizePath(rawPath);
  }

  const argumentsText = JSON.stringify(normalizedArgs);

  const toolCall: ToolCall = {
    tool: toolName,
    raw_arguments: rawArgs,
    normalized_arguments: normalizedArgs,
    mcp_era: mcpEra,
    jsonrpc_id: jsonrpcId,
  };

  // ── 2. Redact arguments for audit storage ──────────────────────────────────
  const { redacted: auditArgs, wasRedacted: argumentsRedacted } =
    redactArgumentsForAudit(normalizedArgs);

  const auditToolCall: ToolCall = { ...toolCall, normalized_arguments: auditArgs };

  // ── 3. Record RECEIVED event ───────────────────────────────────────────────
  let event = ctx.storage.insertEvent({
    id: eventId,
    created_at: createdAt,
    agent,
    tool_call: auditToolCall,
    status: 'RECEIVED',
    decision: null,
    execution_succeeded: null,
    execution_error: null,
    duration_ms: null,
    arguments_redacted: argumentsRedacted,
    result_redacted: false,
    result_blocked: false,
    result_finding_count: 0,
    error_redacted: false,
  });
  ctx.emitEvent(event);

  // ── 4. Evaluate policy ─────────────────────────────────────────────────────
  const input: EvaluationInput = {
    declared_agent_name: agent.declared_name,
    tool: toolName,
    normalized_arguments: normalizedArgs,
    arguments_text: argumentsText,
    primary_path: rawPath ? normalizePath(rawPath) : undefined,
    command: extractCommand(normalizedArgs),
    host: extractHost(normalizedArgs),
  };

  const { decision, approval_ttl_seconds } = evaluate(policy, input);

  // ── 5. Route by decision ───────────────────────────────────────────────────

  if (decision.type === 'DENY') {
    ctx.storage.updateEventStatus(eventId, 'DENIED', { decision });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);
    return { event, result: null };
  }

  if (decision.type === 'REQUIRE_APPROVAL') {
    ctx.storage.updateEventStatus(eventId, 'PENDING_APPROVAL', { decision });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);

    ctx.approvalManager.create({
      event_id: eventId,
      ttl_seconds: approval_ttl_seconds,
      proposed_action_display: `${toolName}(${JSON.stringify(auditArgs)})`,
      policy_reason: decision.explanation,
      scope: toolName,
    });

    // Wait for human decision (poll with timeout)
    const deadline = Date.now() + approval_ttl_seconds * 1000;
    let resolvedApproval = ctx.storage.getApprovalByEventId(eventId);

    while (Date.now() < deadline) {
      resolvedApproval = ctx.storage.getApprovalByEventId(eventId);
      if (resolvedApproval?.status !== 'PENDING') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!resolvedApproval || resolvedApproval.status !== 'APPROVED') {
      const finalStatus = resolvedApproval?.status === 'DENIED' ? 'CANCELLED' : 'EXPIRED';
      ctx.storage.updateEventStatus(eventId, finalStatus, {
        duration_ms: Date.now() - startTime,
      });
      event = ctx.storage.getEvent(eventId)!;
      ctx.emitEvent(event);
      return { event, result: null };
    }
  }

  // ── 6. Execute ─────────────────────────────────────────────────────────────
  const server = resolveServer(ctx.config, toolName);
  if (!server) {
    // toolName is agent-controlled input embedded in this message — route it
    // through the same canonical sanitizer as every other persisted error.
    const noServerError = sanitizeErrorMessage(
      `No downstream server configured for tool: ${toolName}`,
      { source: 'internal' }
    );
    ctx.storage.updateEventStatus(eventId, 'FAILED', {
      decision,
      execution_error: noServerError.message,
      duration_ms: Date.now() - startTime,
      error_redacted: noServerError.redacted,
    });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);
    return { event, result: null };
  }

  ctx.storage.updateEventStatus(eventId, 'EXECUTING', { decision });
  event = ctx.storage.getEvent(eventId)!;
  ctx.emitEvent(event);

  // For ALLOW_WITH_TRANSFORM: use redacted args for downstream execution
  const executionArgs = decision.type === 'ALLOW_WITH_TRANSFORM' ? auditArgs : normalizedArgs;
  const { result, error, errorRedacted } = await executeDownstream(server, toolName, executionArgs);

  // ── 7. Sanitize the downstream result before it ever crosses back to the
  //        upstream client — the single output-security boundary (ADR-0009).
  //        executeDownstream() already sanitized `error` at its source.
  let forwardResult: unknown = null;
  let resultRedacted = false;
  let resultBlocked = false;
  let resultFindingCount = 0;

  if (!error) {
    const sanitized = sanitizeToolResult(result, ctx.config.output_security);
    forwardResult = sanitized.result;
    resultRedacted = sanitized.redacted;
    resultBlocked = sanitized.blocked;
    resultFindingCount = sanitized.findingCount;
  }

  const finalStatus = error ? 'FAILED' : 'SUCCEEDED';
  ctx.storage.updateEventStatus(eventId, finalStatus, {
    execution_succeeded: !error,
    execution_error: error ?? null,
    duration_ms: Date.now() - startTime,
    result_redacted: resultRedacted,
    result_blocked: resultBlocked,
    result_finding_count: resultFindingCount,
    error_redacted: errorRedacted,
  });

  event = ctx.storage.getEvent(eventId)!;
  ctx.emitEvent(event);
  return { event, result: error ? null : forwardResult };
}
