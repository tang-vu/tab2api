import { AppError } from '../errors.js';

/**
 * Bounded JSON Schema subset used to validate tool arguments before a declared tool executes.
 *
 * The subset is deliberately small and total: `type` (single or array form), `enum`, `const`,
 * `properties`, `required`, `additionalProperties` (boolean only), `items`, `minItems`,
 * `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, plus the annotation keywords `title`, `description`,
 * `$comment`, `default`, and `examples`, which carry no validation. Any other keyword (`$ref`,
 * `oneOf`, `allOf`, `anyOf`, `not`, `pattern`, `format`, `patternProperties`, `propertyNames`,
 * `dependentRequired`, `unevaluated*`, ...) is rejected at registration time so a declared
 * schema can never silently under-validate a tool call.
 *
 * Inputs are also structurally bounded (depth, key count, array length, serialized size) and
 * prototype-sensitive keys are refused, matching the envelope-side hygiene elsewhere in the API.
 */

export const MAX_SCHEMA_DEPTH = 16;
export const MAX_SCHEMA_NODES = 256;
export const MAX_ARGUMENT_DEPTH = 16;
export const MAX_ARGUMENT_KEYS = 512;
export const MAX_ARGUMENT_ITEMS = 4096;
export const MAX_ARGUMENT_BYTES = 65_536;

const KEYWORD_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'object',
  'array',
]);
const ANNOTATION_KEYWORDS = new Set(['title', 'description', '$comment', 'default', 'examples']);
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  ...ANNOTATION_KEYWORDS,
]);

type SchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototypeOf = Object.getPrototypeOf(value) as unknown;
  return prototypeOf === Object.prototype || prototypeOf === null;
}

export function containsUnsafeObjectKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_ARGUMENT_DEPTH) return true;
  if (Array.isArray(value)) return value.some((entry) => containsUnsafeObjectKey(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (containsUnsafeObjectKey(nested, depth + 1)) return true;
  }
  return false;
}

function assertSubschema(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): asserts value is SchemaNode {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new AppError(
      'invalid_request',
      `Tool schema exceeds ${MAX_SCHEMA_DEPTH} nesting levels.`,
    );
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NODES) {
    throw new AppError('invalid_request', `Tool schema exceeds ${MAX_SCHEMA_NODES} nodes.`);
  }
  if (!isPlainObject(value)) {
    throw new AppError('invalid_request', `Tool schema at ${path} must be an object.`);
  }
  for (const keyword of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new AppError(
        'invalid_request',
        `Tool schema keyword "${keyword}" at ${path} is not supported; use the documented subset.`,
      );
    }
  }
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (
      types.length === 0 ||
      types.some((entry) => typeof entry !== 'string' || !KEYWORD_TYPES.has(entry))
    ) {
      throw new AppError('invalid_request', `Tool schema "type" at ${path} is invalid.`);
    }
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 128) {
      throw new AppError(
        'invalid_request',
        `Tool schema "enum" at ${path} must list 1-128 values.`,
      );
    }
    if (
      value.enum.some(
        (entry) =>
          !isPlainObject(entry) &&
          !Array.isArray(entry) &&
          entry !== null &&
          typeof entry !== 'string' &&
          typeof entry !== 'number' &&
          typeof entry !== 'boolean',
      )
    ) {
      throw new AppError('invalid_request', `Tool schema "enum" at ${path} is invalid.`);
    }
  }
  if (value.properties !== undefined) {
    if (!isPlainObject(value.properties)) {
      throw new AppError(
        'invalid_request',
        `Tool schema "properties" at ${path} must be an object.`,
      );
    }
    for (const [name, child] of Object.entries(value.properties)) {
      assertSubschema(child, `${path}.properties.${name}`, depth + 1, budget);
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
      new Set(value.required).size !== value.required.length
    ) {
      throw new AppError(
        'invalid_request',
        `Tool schema "required" at ${path} must list unique non-empty names.`,
      );
    }
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    throw new AppError(
      'invalid_request',
      `Tool schema "additionalProperties" at ${path} accepts only true or false.`,
    );
  }
  if (value.items !== undefined) {
    assertSubschema(value.items, `${path}.items`, depth + 1, budget);
  }
  for (const numeric of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    const bound = value[numeric];
    if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0)) {
      throw new AppError('invalid_request', `Tool schema "${numeric}" at ${path} is invalid.`);
    }
  }
  for (const numeric of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ] as const) {
    const bound = value[numeric];
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
      throw new AppError('invalid_request', `Tool schema "${numeric}" at ${path} is invalid.`);
    }
  }
  if (value.multipleOf !== undefined && (value.multipleOf as number) <= 0) {
    throw new AppError('invalid_request', `Tool schema "multipleOf" at ${path} must be positive.`);
  }
}

/**
 * Validates a declared input schema at registration time. Returns the schema unchanged so the
 * caller can store the caller-supplied object; every keyword outside the enforced subset fails.
 */
export function assertSupportedToolSchema(schema: unknown, toolName: string): SchemaNode {
  if (!isPlainObject(schema)) {
    throw new AppError('invalid_request', `Tool "${toolName}" must declare an object schema.`);
  }
  const budget = { nodes: 0 };
  assertSubschema(schema, 'input_schema', 0, budget);
  return schema;
}

function typeMatches(actual: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof actual === 'string';
    case 'number':
      return typeof actual === 'number' && Number.isFinite(actual);
    case 'integer':
      return typeof actual === 'number' && Number.isInteger(actual);
    case 'boolean':
      return typeof actual === 'boolean';
    case 'null':
      return actual === null;
    case 'object':
      return isPlainObject(actual);
    case 'array':
      return Array.isArray(actual);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function validateNode(
  schema: SchemaNode,
  value: unknown,
  path: string,
  depth: number,
  errors: string[],
): void {
  if (errors.length >= 16) return;
  if (depth > MAX_ARGUMENT_DEPTH) {
    errors.push(`${path}: exceeds maximum nesting depth`);
    return;
  }
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path}: expected ${types.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: must equal the declared const`);
  }
  if (
    schema.enum !== undefined &&
    !(schema.enum as unknown[]).some((entry) => deepEqual(entry, value))
  ) {
    errors.push(`${path}: not in the declared enum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number))
      errors.push(`${path}: shorter than minLength ${schema.minLength as number}`);
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number))
      errors.push(`${path}: longer than maxLength ${schema.maxLength as number}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number))
      errors.push(`${path}: below minimum ${schema.minimum as number}`);
    if (schema.maximum !== undefined && value > (schema.maximum as number))
      errors.push(`${path}: above maximum ${schema.maximum as number}`);
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number))
      errors.push(`${path}: not above exclusiveMinimum ${schema.exclusiveMinimum as number}`);
    if (schema.exclusiveMaximum !== undefined && value >= (schema.exclusiveMaximum as number))
      errors.push(`${path}: not below exclusiveMaximum ${schema.exclusiveMaximum as number}`);
    if (
      schema.multipleOf !== undefined &&
      Math.abs(
        value / (schema.multipleOf as number) - Math.round(value / (schema.multipleOf as number)),
      ) > 1e-9
    )
      errors.push(`${path}: not a multiple of ${schema.multipleOf as number}`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARGUMENT_ITEMS) {
      errors.push(`${path}: array exceeds ${MAX_ARGUMENT_ITEMS} items`);
      return;
    }
    if (schema.minItems !== undefined && value.length < (schema.minItems as number))
      errors.push(`${path}: fewer than minItems ${schema.minItems as number}`);
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number))
      errors.push(`${path}: more than maxItems ${schema.maxItems as number}`);
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        validateNode(schema.items as SchemaNode, item, `${path}[${index}]`, depth + 1, errors);
      }
    }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_ARGUMENT_KEYS) {
      errors.push(`${path}: object exceeds ${MAX_ARGUMENT_KEYS} keys`);
      return;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in value)) errors.push(`${path}: missing required "${name}"`);
    }
    for (const key of keys) {
      const child = properties[key];
      if (child !== undefined) {
        validateNode(child as SchemaNode, value[key], `${path}.${key}`, depth + 1, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: undeclared property "${key}"`);
      }
    }
  }
}

/**
 * Returns a bounded list of argument errors (empty when valid). The caller maps a non-empty
 * result to an invalid-call rejection; no exception is thrown for a well-formed check.
 */
export function validateToolArguments(schema: SchemaNode, args: unknown): string[] {
  if (!isPlainObject(args)) return ['arguments: expected an object'];
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) {
    return [`arguments: serialized arguments exceed ${MAX_ARGUMENT_BYTES} bytes`];
  }
  if (containsUnsafeObjectKey(args)) {
    return ['arguments: prototype-sensitive keys are not allowed'];
  }
  const errors: string[] = [];
  validateNode(schema, args, 'arguments', 0, errors);
  return errors;
}
