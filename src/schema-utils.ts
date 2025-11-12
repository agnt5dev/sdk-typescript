/**
 * Schema conversion utilities for structured output support.
 *
 * This module provides utilities to convert TypeScript schemas (Zod, TypeBox, or manual)
 * to JSON Schema format for LLM structured output generation, function signatures,
 * and tool definitions.
 */

import type { JSONSchema } from './types.js';

/**
 * Schema format types supported by the SDK
 */
export type SchemaFormat = 'zod' | 'typebox' | 'raw';

/**
 * Options for schema conversion
 */
export interface SchemaConversionOptions {
  /** Include descriptions in the schema */
  includeDescriptions?: boolean;
  /** Strict mode (additionalProperties: false) */
  strict?: boolean;
}

/**
 * Auto-detect format type and convert to JSON schema.
 *
 * @param schema - Zod schema, TypeBox schema, or JSON schema object
 * @param options - Conversion options
 * @returns Tuple of [format_type, json_schema]
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { detectFormatType } from '@agnt5/sdk';
 *
 * const UserSchema = z.object({
 *   name: z.string(),
 *   age: z.number(),
 * });
 *
 * const [format, schema] = detectFormatType(UserSchema);
 * // format: 'zod'
 * // schema: { type: 'object', properties: { ... }, required: ['name', 'age'] }
 * ```
 */
export function detectFormatType(
  schema: any,
  options: SchemaConversionOptions = {}
): [SchemaFormat, JSONSchema] {
  // Check for Zod schema
  if (isZodSchema(schema)) {
    return ['zod', zodToJsonSchema(schema, options)];
  }

  // Check for TypeBox schema
  if (isTypeBoxSchema(schema)) {
    return ['typebox', typeBoxToJsonSchema(schema, options)];
  }

  // Check for raw JSON schema
  if (isJsonSchema(schema)) {
    return ['raw', schema as JSONSchema];
  }

  throw new Error(
    `Unsupported schema type. Expected Zod schema, TypeBox schema, or JSON Schema object.`
  );
}

/**
 * Check if value is a Zod schema
 */
export function isZodSchema(value: any): boolean {
  // Zod schemas have a _def property
  return value && typeof value === 'object' && '_def' in value && 'parse' in value;
}

/**
 * Check if value is a TypeBox schema
 */
export function isTypeBoxSchema(value: any): boolean {
  // TypeBox schemas have [Kind] and [Symbol] properties
  return value && typeof value === 'object' && ('$id' in value || 'kind' in value) && 'type' in value;
}

/**
 * Check if value is a raw JSON schema
 */
export function isJsonSchema(value: any): boolean {
  return value && typeof value === 'object' && 'type' in value;
}

/**
 * Convert Zod schema to JSON Schema.
 *
 * @param schema - Zod schema
 * @param options - Conversion options
 * @returns JSON Schema object
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 *
 * const schema = z.object({
 *   name: z.string().describe('User name'),
 *   age: z.number().int().positive(),
 *   email: z.string().email().optional(),
 * });
 *
 * const jsonSchema = zodToJsonSchema(schema);
 * ```
 */
export function zodToJsonSchema(schema: any, options: SchemaConversionOptions = {}): JSONSchema {
  if (!isZodSchema(schema)) {
    throw new Error('Expected Zod schema');
  }

  try {
    // Try to use zod-to-json-schema library if available
    const zodToJsonSchemaLib = tryRequire('zod-to-json-schema');
    if (zodToJsonSchemaLib && zodToJsonSchemaLib.zodToJsonSchema) {
      return zodToJsonSchemaLib.zodToJsonSchema(schema, {
        target: 'openApi3',
        strictUnions: true,
      });
    }

    // Fallback: basic Zod schema conversion
    return zodToJsonSchemaBasic(schema, options);
  } catch (error) {
    throw new Error(`Failed to convert Zod schema to JSON Schema: ${(error as Error).message}`);
  }
}

/**
 * Basic Zod to JSON Schema conversion (fallback when zod-to-json-schema is not available)
 */
function zodToJsonSchemaBasic(schema: any, options: SchemaConversionOptions = {}): JSONSchema {
  const def = schema._def;
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodString':
      return { type: 'string', ...(def.description && options.includeDescriptions ? { description: def.description } : {}) };
    case 'ZodNumber':
      return { type: 'number', ...(def.description && options.includeDescriptions ? { description: def.description } : {}) };
    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description && options.includeDescriptions ? { description: def.description } : {}) };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchemaBasic(def.type, options),
        ...(def.description && options.includeDescriptions ? { description: def.description } : {}),
      };
    case 'ZodObject': {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];

      const shape = def.shape();
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchemaBasic(value, options);

        // Check if field is required (not optional)
        const fieldDef = (value as any)._def;
        if (fieldDef.typeName !== 'ZodOptional') {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(options.strict ? { additionalProperties: false } : {}),
        ...(def.description && options.includeDescriptions ? { description: def.description } : {}),
      };
    }
    case 'ZodOptional':
      return zodToJsonSchemaBasic(def.innerType, options);
    case 'ZodNullable':
      return {
        anyOf: [zodToJsonSchemaBasic(def.innerType, options), { type: 'null' }],
      };
    case 'ZodEnum':
      return {
        type: 'string',
        enum: def.values,
        ...(def.description && options.includeDescriptions ? { description: def.description } : {}),
      };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodUnion':
      return {
        anyOf: def.options.map((opt: any) => zodToJsonSchemaBasic(opt, options)),
      };
    default:
      return { type: 'string', description: `Zod type: ${typeName}` };
  }
}

/**
 * Convert TypeBox schema to JSON Schema.
 *
 * TypeBox schemas are already JSON Schema compatible, so this is mostly a pass-through.
 *
 * @param schema - TypeBox schema
 * @param options - Conversion options
 * @returns JSON Schema object
 *
 * @example
 * ```typescript
 * import { Type } from '@sinclair/typebox';
 *
 * const schema = Type.Object({
 *   name: Type.String(),
 *   age: Type.Number(),
 * });
 *
 * const jsonSchema = typeBoxToJsonSchema(schema);
 * ```
 */
export function typeBoxToJsonSchema(schema: any, options: SchemaConversionOptions = {}): JSONSchema {
  if (!isTypeBoxSchema(schema)) {
    throw new Error('Expected TypeBox schema');
  }

  // TypeBox schemas are already JSON Schema compatible
  const jsonSchema = { ...schema };

  // Apply options
  if (options.strict && jsonSchema.type === 'object' && !('additionalProperties' in jsonSchema)) {
    jsonSchema.additionalProperties = false;
  }

  return jsonSchema;
}

/**
 * Try to require a module, return undefined if not available
 */
function tryRequire(moduleName: string): any {
  try {
    // Dynamic import at runtime
    return require(moduleName);
  } catch {
    return undefined;
  }
}

/**
 * Convert basic TypeScript types to JSON Schema types.
 *
 * This is a utility for manual schema generation when you don't want to use Zod or TypeBox.
 *
 * @param typeName - TypeScript type name ('string', 'number', 'boolean', etc.)
 * @param options - Additional schema options
 * @returns JSON Schema type definition
 *
 * @example
 * ```typescript
 * const stringSchema = typeToSchema('string', { description: 'User name' });
 * // { type: 'string', description: 'User name' }
 *
 * const arraySchema = typeToSchema('array', { items: { type: 'number' } });
 * // { type: 'array', items: { type: 'number' } }
 * ```
 */
export function typeToSchema(
  typeName: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null',
  options: Partial<JSONSchema> = {}
): JSONSchema {
  return {
    type: typeName,
    ...options,
  };
}

/**
 * Create an object schema from property definitions.
 *
 * @param properties - Object property definitions
 * @param required - Array of required property names
 * @param options - Additional schema options
 * @returns JSON Schema object definition
 *
 * @example
 * ```typescript
 * const userSchema = createObjectSchema({
 *   name: { type: 'string', description: 'User name' },
 *   age: { type: 'number', minimum: 0 },
 *   email: { type: 'string', format: 'email' },
 * }, ['name', 'age']);
 * ```
 */
export function createObjectSchema(
  properties: Record<string, JSONSchema>,
  required?: string[],
  options: Partial<JSONSchema> = {}
): JSONSchema {
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    ...options,
  };
}

/**
 * Create an array schema with item type.
 *
 * @param items - Schema for array items
 * @param options - Additional schema options
 * @returns JSON Schema array definition
 *
 * @example
 * ```typescript
 * const numbersSchema = createArraySchema({ type: 'number' });
 * const usersSchema = createArraySchema({
 *   type: 'object',
 *   properties: {
 *     name: { type: 'string' },
 *     age: { type: 'number' },
 *   },
 * });
 * ```
 */
export function createArraySchema(items: JSONSchema, options: Partial<JSONSchema> = {}): JSONSchema {
  return {
    type: 'array',
    items,
    ...options,
  };
}

/**
 * Create an enum schema.
 *
 * @param values - Allowed enum values
 * @param options - Additional schema options
 * @returns JSON Schema enum definition
 *
 * @example
 * ```typescript
 * const statusSchema = createEnumSchema(['pending', 'active', 'completed']);
 * const roleSchema = createEnumSchema(['admin', 'user', 'guest'], {
 *   description: 'User role',
 * });
 * ```
 */
export function createEnumSchema(values: any[], options: Partial<JSONSchema> = {}): JSONSchema {
  return {
    type: typeof values[0],
    enum: values,
    ...options,
  } as JSONSchema;
}

/**
 * Create a union schema (anyOf).
 *
 * @param schemas - Array of possible schemas
 * @param options - Additional schema options
 * @returns JSON Schema union definition
 *
 * @example
 * ```typescript
 * const stringOrNumber = createUnionSchema([
 *   { type: 'string' },
 *   { type: 'number' },
 * ]);
 * ```
 */
export function createUnionSchema(schemas: JSONSchema[], options: Partial<JSONSchema> = {}): JSONSchema {
  return {
    anyOf: schemas,
    ...options,
  };
}

/**
 * Make a schema optional (allows null).
 *
 * @param schema - Base schema
 * @returns Schema that allows the base type or null
 *
 * @example
 * ```typescript
 * const optionalString = makeOptional({ type: 'string' });
 * // { anyOf: [{ type: 'string' }, { type: 'null' }] }
 * ```
 */
export function makeOptional(schema: JSONSchema): JSONSchema {
  return {
    anyOf: [schema, { type: 'null' }],
  };
}

/**
 * Merge multiple schemas into one (allOf).
 *
 * @param schemas - Array of schemas to merge
 * @returns Merged schema
 *
 * @example
 * ```typescript
 * const baseSchema = { type: 'object', properties: { id: { type: 'string' } } };
 * const extraSchema = { properties: { name: { type: 'string' } } };
 * const merged = mergeSchemas([baseSchema, extraSchema]);
 * ```
 */
export function mergeSchemas(schemas: JSONSchema[]): JSONSchema {
  return {
    allOf: schemas,
  };
}

/**
 * Validate a value against a JSON schema.
 *
 * This is a basic validator. For production use, consider using a dedicated library like Ajv.
 *
 * @param value - Value to validate
 * @param schema - JSON Schema to validate against
 * @returns True if valid, false otherwise
 *
 * @example
 * ```typescript
 * const schema = { type: 'object', properties: { name: { type: 'string' } } };
 * validateSchema({ name: 'Alice' }, schema); // true
 * validateSchema({ name: 123 }, schema); // false
 * ```
 */
export function validateSchema(value: any, schema: JSONSchema): boolean {
  try {
    // Try to use Ajv if available
    const Ajv = tryRequire('ajv');
    if (Ajv) {
      const ajv = new Ajv();
      const validate = ajv.compile(schema);
      return validate(value) as boolean;
    }

    // Fallback: basic type checking
    return basicValidateSchema(value, schema);
  } catch {
    return false;
  }
}

/**
 * Basic schema validation (fallback when Ajv is not available)
 */
function basicValidateSchema(value: any, schema: JSONSchema): boolean {
  const { type } = schema;

  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // Unknown type, pass validation
  }
}

/**
 * Extract description from JSDoc comment.
 *
 * @param func - Function to extract description from
 * @returns Description string or undefined
 *
 * @example
 * ```typescript
 * /​**
 *  * This is a greeting function
 *  *​/
 * function greet(name: string) { ... }
 *
 * extractFunctionDescription(greet); // 'This is a greeting function'
 * ```
 */
export function extractFunctionDescription(func: Function): string | undefined {
  // Try to extract from function toString (limited, but works in some cases)
  const funcStr = func.toString();
  const jsdocMatch = funcStr.match(/\/\*\*\s*\n?\s*\*\s*(.+?)\s*\n/);
  if (jsdocMatch && jsdocMatch[1]) {
    return jsdocMatch[1].trim();
  }
  return undefined;
}
