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
import { resolveServer, defaultContextGuardConfig } from './config/registry.js';
import { sanitizeToolResult } from './output-security.js';
import { evaluateContextGuard, modeEnforces, computeArgumentDigest, checkApprovalContextValid } from './context-guard/enforcement.js';
import { appendContextLabels, recordCallEvaluation } from './context-guard/state.js';
import { isAtLeastAsStrict } from './context-guard/rules.js';

export interface PipelineContext {
  storage: AuditStorage;
  approvalManager: ApprovalManager;
  config: GatewayConfig;
  /** Milestone 7 (ADR-0013): the single execution context for this gateway process/upstream-connection lifetime. */
  contextId: string;
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

  // ── 4.5. Context Guard: evaluate the attempted call against the ACTIVE
  //         execution context (ADR-0013), taking the STRICTER of the base
  //         policy decision and any matching contextual rule. This runs
  //         for every call that reaches this point — including one invoked
  //         directly by a cached tool name — because this is the single
  //         function every tools/call request passes through after the
  //         Tool Integrity gate; there is no other path to execution.
  //         Always evaluated and recorded (even in `monitor` mode, so it
  //         can be displayed/audited), but only actually APPLIED to the
  //         effective decision when the mode enforces.
  // Normalize through the canonical schema default rather than trusting
  // ctx.config.context_guard to be present: loadGatewayConfig() always
  // schema-parses it in, but a GatewayConfig-shaped object built by hand
  // (a test fixture, or any other caller bypassing the real parser) can
  // legitimately omit it. Falling back to the same default the schema
  // itself would apply (`monitor` mode) preserves documented behavior for
  // an omitted field instead of crashing on it.
  const contextGuardConfig = ctx.config.context_guard ?? defaultContextGuardConfig();
  const cgEvaluation = evaluateContextGuard(ctx.storage, contextGuardConfig, ctx.contextId, toolName);
  const cgEnforcing = modeEnforces(contextGuardConfig.mode);

  let effectiveDecision = decision;
  let contextualRuleId: string | null = null;
  let contextRevisionAtEvaluation: number | null = null;
  if (contextGuardConfig.mode !== 'disabled') {
    contextRevisionAtEvaluation = ctx.storage.getContextState(ctx.contextId)?.revision ?? null;
  }

  if (cgEnforcing && cgEvaluation.action !== 'allow') {
    const cgActionType = cgEvaluation.action === 'deny' ? 'DENY' : 'REQUIRE_APPROVAL';
    // Only override if the contextual action is at least as strict as the
    // base policy's own decision — this is what guarantees Context Guard
    // can only ESCALATE, never silently loosen a base-policy DENY into a
    // contextual REQUIRE_APPROVAL.
    if (isAtLeastAsStrict(cgActionType, decision.type)) {
      contextualRuleId = cgEvaluation.ruleId;
      effectiveDecision = {
        type: cgActionType,
        reason_code: 'CONTEXT_GUARD_ESCALATION',
        explanation: cgEvaluation.reason ?? 'Blocked by a Context Guard contextual rule.',
        matched_rule_id: cgEvaluation.ruleId ? `context:${cgEvaluation.ruleId}` : null,
      };
    }
  }

  // Record the contextual decision for history/explain, regardless of
  // mode (unless disabled) — this is what lets `agentgate context
  // history`/`explain` and the Control Center show what Context Guard
  // WOULD have done even in monitor mode, not only what it enforced.
  if (contextGuardConfig.mode !== 'disabled') {
    recordCallEvaluation(ctx.storage, ctx.contextId, {
      sourceEventId: eventId,
      toolName,
      ruleId: cgEvaluation.ruleId,
      action: contextualRuleId ? effectiveDecision.type.toLowerCase() : 'allow',
      reason: cgEvaluation.reason,
    });
  }

  // ── 5. Route by decision ───────────────────────────────────────────────────

  if (effectiveDecision.type === 'DENY') {
    ctx.storage.updateEventStatus(eventId, 'DENIED', { decision: effectiveDecision });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);
    return { event, result: null };
  }

  const argumentDigest = computeArgumentDigest(auditArgs);

  if (effectiveDecision.type === 'REQUIRE_APPROVAL') {
    ctx.storage.updateEventStatus(eventId, 'PENDING_APPROVAL', { decision: effectiveDecision });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);

    const ttlSeconds = contextualRuleId && cgEvaluation.approvalTtlSeconds ? cgEvaluation.approvalTtlSeconds : approval_ttl_seconds;
    ctx.approvalManager.create({
      event_id: eventId,
      ttl_seconds: ttlSeconds,
      proposed_action_display: `${toolName}(${JSON.stringify(auditArgs)})`,
      policy_reason: effectiveDecision.explanation,
      scope: toolName,
      // Milestone 7 (ADR-0013): bind this approval to the EXACT context
      // revision/tool/argument-digest observed right now — re-validated
      // again at consumption time below, closing the window between
      // approval creation and a human's decision.
      contextBinding: contextGuardConfig.mode !== 'disabled'
        ? {
            context_id: ctx.contextId,
            context_revision: contextRevisionAtEvaluation ?? 0,
            tool_fingerprint: null,
            argument_digest: argumentDigest,
            contextual_rule_id: contextualRuleId ?? 'base-policy',
          }
        : undefined,
    });

    // Wait for human decision (poll with timeout)
    const deadline = Date.now() + ttlSeconds * 1000;
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

    // Re-validate the context binding RIGHT NOW, immediately before
    // execution — the context may have accumulated more risk labels (from
    // a concurrent call) in the window between approval creation and this
    // human decision. A stale/mismatched binding fails closed here even
    // though the approval itself already shows APPROVED.
    const contextCheck = checkApprovalContextValid(resolvedApproval, ctx.storage, toolName, argumentDigest);
    if (!contextCheck.ok) {
      ctx.storage.updateEventStatus(eventId, 'CANCELLED', {
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
      decision: effectiveDecision,
      execution_error: noServerError.message,
      duration_ms: Date.now() - startTime,
      error_redacted: noServerError.redacted,
    });
    event = ctx.storage.getEvent(eventId)!;
    ctx.emitEvent(event);
    return { event, result: null };
  }

  ctx.storage.updateEventStatus(eventId, 'EXECUTING', { decision: effectiveDecision });
  event = ctx.storage.getEvent(eventId)!;
  ctx.emitEvent(event);

  // For ALLOW_WITH_TRANSFORM: use redacted args for downstream execution
  const executionArgs = effectiveDecision.type === 'ALLOW_WITH_TRANSFORM' ? auditArgs : normalizedArgs;
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

  // ── 8. Append context labels based on the OBSERVED outcome (ADR-0013) ──────
  // Deterministic rule: `adds_on_result` labels are added ONLY when the
  // call actually SUCCEEDED and its result was not entirely blocked by
  // output security — a denied/cancelled/expired call never reached the
  // downstream server at all, a FAILED call didn't return a result, and a
  // BLOCKED result means nothing the label would describe actually
  // reached the agent. This is deliberately conservative: it undercounts
  // some real risk (e.g. it does not label on a REDACTED-but-still-
  // delivered result differently from a fully clean one — the label
  // applies either way, since content beyond the redacted secret pattern
  // still reached the agent) rather than ever inventing labels for
  // content nobody actually received. Only the LABEL NAMES (operator
  // policy vocabulary) are ever stored — never the raw result content.
  if (contextGuardConfig.mode !== 'disabled' && finalStatus === 'SUCCEEDED' && !resultBlocked) {
    const addsOnResult = contextGuardConfig.tools[toolName]?.adds_on_result ?? [];
    if (addsOnResult.length > 0) {
      appendContextLabels(ctx.storage, ctx.contextId, addsOnResult, {
        sourceEventId: eventId,
        toolName,
        reason: `Tool "${toolName}" succeeded with a non-blocked result.`,
      });
    }
  }

  return { event, result: error ? null : forwardResult };
}
