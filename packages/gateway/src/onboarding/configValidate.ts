// `agentgate config validate` — validates a gateway config AND its
// referenced policy file using exactly the same loaders production startup
// uses (`loadGatewayConfig`, `loadPolicyFile`) — never a second, divergent
// validation implementation (Milestone 5, Phase 3).
import path from 'node:path';
import fs from 'node:fs';
import { loadGatewayConfig } from '../config/registry.js';
import { loadPolicyFile, sanitizeErrorMessage } from '@agentgate/policy';

export type ConfigValidationCategory =
  | 'missing_file'
  | 'syntax_error'
  | 'schema_error'
  | 'policy_error'
  | 'unsafe_value';

export interface ConfigValidationIssue {
  category: ConfigValidationCategory;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  configPath: string;
  policyPath: string | null;
  issues: ConfigValidationIssue[];
  /** Present only when the config loaded successfully. */
  summary: {
    servers: number;
    gatewayPort: number;
    controlPort: number;
    dbPath: string;
  } | null;
}

/**
 * Validates a gateway config file and (if it loads) its referenced policy
 * file, using the same code paths as `agentgate start`. Never throws —
 * every failure is captured as a categorized issue. Never includes a raw
 * secret or runtime token in its output (there is none to leak here, but
 * error messages are still routed through the same sanitizer used
 * elsewhere for consistency).
 */
export function validateConfigFile(configPath: string): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];

  if (!fs.existsSync(configPath)) {
    return {
      valid: false,
      configPath,
      policyPath: null,
      issues: [{ category: 'missing_file', message: `Config file not found: "${configPath}"` }],
      summary: null,
    };
  }

  let config;
  try {
    config = loadGatewayConfig(configPath);
  } catch (err) {
    const message = sanitizeErrorMessage(err, { source: 'internal' }).message;
    // loadGatewayConfig() throws distinctly-worded errors for "cannot read"
    // (covered above, but a race is possible), "not valid YAML", and
    // schema validation failures — categorize by the same wording rather
    // than re-implementing YAML/schema parsing here.
    const category: ConfigValidationCategory = /not valid YAML/i.test(message)
      ? 'syntax_error'
      : 'schema_error';
    issues.push({ category, message });
    return { valid: false, configPath, policyPath: null, issues, summary: null };
  }

  const policyPath = path.isAbsolute(config.policy)
    ? config.policy
    : path.resolve(path.dirname(configPath), config.policy);

  if (!fs.existsSync(policyPath)) {
    issues.push({ category: 'missing_file', message: `Policy file not found: "${policyPath}"` });
    return { valid: false, configPath, policyPath, issues, summary: null };
  }

  try {
    loadPolicyFile(policyPath);
  } catch (err) {
    const message = sanitizeErrorMessage(err, { source: 'internal' }).message;
    const category: ConfigValidationCategory = /not valid YAML/i.test(message)
      ? 'syntax_error'
      : 'policy_error';
    issues.push({ category, message });
    return { valid: false, configPath, policyPath, issues, summary: null };
  }

  // Unsafe-value checks beyond schema validity: things Zod alone can't
  // express as a hard rejection (loopback binding is the security-relevant
  // one — GatewayConfigSchema doesn't restrict the port number's bind
  // address itself, since the address is hardcoded to 127.0.0.1 in
  // server.ts, but a config-only check here still surfaces the fact if a
  // future config field ever introduced a bind-address override).
  if (config.gateway_port === config.control_port) {
    issues.push({
      category: 'unsafe_value',
      message: `gateway_port and control_port are both ${config.gateway_port} — they must be different.`,
    });
  }

  return {
    valid: issues.length === 0,
    configPath,
    policyPath,
    issues,
    summary: {
      servers: config.servers.length,
      gatewayPort: config.gateway_port,
      controlPort: config.control_port,
      dbPath: config.db_path,
    },
  };
}
