import fs from 'node:fs';
import yaml from 'js-yaml';
import { PolicySchema, validatePolicy, type Policy } from './schema.js';
import { evaluate, normalizePath, type EvaluationInput } from './engine.js';

/**
 * Loads and validates a policy YAML file.
 * Throws a descriptive error if the file cannot be read or is invalid.
 */
export function loadPolicyFile(filePath: string): Policy {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read policy file "${filePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Policy file "${filePath}" is not valid YAML: ${(err as Error).message}`);
  }

  const validation = validatePolicy(parsed);
  if (!validation.valid) {
    throw new Error(
      `Policy file "${filePath}" failed validation:\n` +
        validation.errors.map((e) => `  - ${e}`).join('\n')
    );
  }

  // Safe to parse with Zod now
  return PolicySchema.parse(parsed);
}

export { evaluate, validatePolicy, normalizePath };
export type { Policy, EvaluationInput };
export * from './schema.js';
export * from './transformation.js';
export * from './output-sanitization.js';
export * from './digest.js';
