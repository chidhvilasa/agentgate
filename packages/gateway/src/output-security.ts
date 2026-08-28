/**
 * MCP-shape-aware downstream result sanitization (ADR-0009).
 *
 * This is the single boundary where a downstream tool's raw result is
 * inspected before AgentGate returns it to the upstream MCP client. It knows
 * about MCP CallToolResult content variants (text/image/audio/resource/
 * resource_link/structuredContent); the actual secret-pattern scanning and
 * generic JSON traversal is delegated to @chidhvilasa/policy's
 * sanitizeJsonValue()/detectSecrets()/redactSecrets() — there is one
 * authoritative secret-pattern implementation, not a second copy here.
 */
import { sanitizeJsonValue, type SanitizationFinding } from '@chidhvilasa/policy';
import type { OutputSecurityConfig } from './config/registry.js';

export interface ResultSanitizationOutcome {
  /** The value to actually return to the upstream MCP client. Protocol-valid. */
  result: unknown;
  /** True if a recognized secret was redacted somewhere in the forwarded result. */
  redacted: boolean;
  /** True if the entire result was replaced with a safe error (block mode). */
  blocked: boolean;
  /** Safe count only — never the findings themselves are persisted verbatim beyond count/locations already scrubbed of raw values. */
  findingCount: number;
}

const BLOCKED_RESULT_MESSAGE =
  '[AgentGate] Result blocked by output-security policy: the downstream result appears to ' +
  'contain a secret (or could not be fully inspected within configured limits) and was not forwarded.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Sanitizes a single string leaf field, returning the (possibly redacted) value and whether it changed/was blockable. */
function sanitizeTextLeaf(
  value: unknown,
  location: string,
  config: OutputSecurityConfig,
  findings: SanitizationFinding[]
): { value: unknown; redacted: boolean; unsafe: boolean } {
  if (typeof value !== 'string') return { value, redacted: false, unsafe: false };
  const r = sanitizeJsonValue(value, { maxDepth: config.max_depth, maxTextBytes: config.max_text_bytes }, location);
  findings.push(...r.findings);
  return { value: r.value, redacted: r.changed, unsafe: r.blocked };
}

/** Sanitizes one MCP content-block entry from a CallToolResult's `content` array. */
function sanitizeContentBlock(
  block: unknown,
  index: number,
  config: OutputSecurityConfig,
  findings: SanitizationFinding[]
): { block: unknown; redacted: boolean; unsafe: boolean } {
  const loc = `content[${index}]`;
  if (!isPlainObject(block) || typeof block.type !== 'string') {
    findings.push({ location: loc, category: 'unknown_content', action: 'not_inspected' });
    return { block, redacted: false, unsafe: true };
  }

  switch (block.type) {
    case 'text': {
      const r = sanitizeTextLeaf(block.text, `${loc}.text`, config, findings);
      return { block: { ...block, text: r.value }, redacted: r.redacted, unsafe: r.unsafe };
    }

    case 'image':
    case 'audio': {
      // Opaque binary (base64). Never regex-scanned or mutated — see ADR-0009.
      findings.push({ location: `${loc}.data`, category: 'opaque_binary', action: 'not_inspected' });
      return { block, redacted: false, unsafe: false };
    }

    case 'resource': {
      const resource = block.resource;
      if (isPlainObject(resource) && typeof resource.text === 'string') {
        const r = sanitizeTextLeaf(resource.text, `${loc}.resource.text`, config, findings);
        return {
          block: { ...block, resource: { ...resource, text: r.value } },
          redacted: r.redacted,
          unsafe: r.unsafe,
        };
      }
      if (isPlainObject(resource) && typeof resource.blob === 'string') {
        findings.push({ location: `${loc}.resource.blob`, category: 'opaque_binary', action: 'not_inspected' });
        return { block, redacted: false, unsafe: false };
      }
      findings.push({ location: `${loc}.resource`, category: 'unknown_content', action: 'not_inspected' });
      return { block, redacted: false, unsafe: true };
    }

    case 'resource_link': {
      let redacted = false;
      let unsafe = false;
      const next: Record<string, unknown> = { ...block };
      for (const field of ['uri', 'name', 'description', 'title']) {
        if (typeof block[field] === 'string') {
          const r = sanitizeTextLeaf(block[field], `${loc}.${field}`, config, findings);
          next[field] = r.value;
          redacted = redacted || r.redacted;
          unsafe = unsafe || r.unsafe;
        }
      }
      return { block: next, redacted, unsafe };
    }

    default: {
      // Unknown/future content-block type: pass through unmodified,
      // deterministically, in both modes (see ADR-0009).
      findings.push({ location: loc, category: 'unknown_content', action: 'not_inspected' });
      return { block, redacted: false, unsafe: true };
    }
  }
}

/**
 * Sanitizes a downstream tool's raw CallToolResult-shaped value before it is
 * returned to the upstream MCP client. Never mutates the input. Always
 * returns a protocol-valid result.
 */
export function sanitizeToolResult(
  result: unknown,
  config: OutputSecurityConfig
): ResultSanitizationOutcome {
  const findings: SanitizationFinding[] = [];

  // Not a recognized CallToolResult shape at all — pass through unmodified.
  // We cannot safely guess field names on something structurally unknown.
  if (!isPlainObject(result)) {
    return { result, redacted: false, blocked: false, findingCount: 0 };
  }

  let redacted = false;
  let unsafe = false;
  const next: Record<string, unknown> = { ...result };

  if (Array.isArray(result.content)) {
    const nextContent: unknown[] = [];
    result.content.forEach((block, i) => {
      const r = sanitizeContentBlock(block, i, config, findings);
      nextContent.push(r.block);
      redacted = redacted || r.redacted;
      // Opaque binary content is never "unsafe" on its own (see ADR-0009) —
      // sanitizeContentBlock already reflects that by only setting `unsafe`
      // for secrets/unknown/truncated content, not for image/audio/blob.
      unsafe = unsafe || r.unsafe;
    });
    next.content = nextContent;
  }

  if (isPlainObject(result.structuredContent)) {
    const r = sanitizeJsonValue(
      result.structuredContent,
      { maxDepth: config.max_depth, maxTextBytes: config.max_text_bytes },
      'structuredContent'
    );
    findings.push(...r.findings);
    next.structuredContent = r.value;
    redacted = redacted || r.changed;
    unsafe = unsafe || r.blocked;
  }

  // _meta (top-level) and any other unrecognized top-level field are passed
  // through completely unmodified — deliberate scope boundary (ADR-0009).

  const findingCount = findings.length;

  if (config.mode === 'block' && unsafe) {
    return {
      result: { content: [{ type: 'text', text: BLOCKED_RESULT_MESSAGE }], isError: true },
      redacted: false,
      blocked: true,
      findingCount,
    };
  }

  return { result: next, redacted, blocked: false, findingCount };
}
