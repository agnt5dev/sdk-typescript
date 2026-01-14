import { describe, it, expect } from 'vitest';
import {
  typeToSchema,
  createObjectSchema,
  createArraySchema,
  createEnumSchema,
  createUnionSchema,
  makeOptional,
  mergeSchemas,
  validateSchema,
  isJsonSchema,
} from '../schema-utils.js';
import type { JSONSchema } from '../types.js';

describe('Schema Utilities', () => {
  describe('typeToSchema', () => {
    it('should create string schema', () => {
      const schema = typeToSchema('string');
      expect(schema).toEqual({ type: 'string' });
    });

    it('should create number schema', () => {
      const schema = typeToSchema('number');
      expect(schema).toEqual({ type: 'number' });
    });

    it('should create integer schema', () => {
      const schema = typeToSchema('integer');
      expect(schema).toEqual({ type: 'integer' });
    });

    it('should create boolean schema', () => {
      const schema = typeToSchema('boolean');
      expect(schema).toEqual({ type: 'boolean' });
    });

    it('should create array schema', () => {
      const schema = typeToSchema('array');
      expect(schema).toEqual({ type: 'array' });
    });

    it('should create object schema', () => {
      const schema = typeToSchema('object');
      expect(schema).toEqual({ type: 'object' });
    });

    it('should create null schema', () => {
      const schema = typeToSchema('null');
      expect(schema).toEqual({ type: 'null' });
    });

    it('should accept options like description', () => {
      const schema = typeToSchema('string', { description: 'User name' });
      expect(schema).toEqual({ type: 'string', description: 'User name' });
    });
  });

  describe('createObjectSchema', () => {
    it('should create simple object schema', () => {
      const schema = createObjectSchema({
        name: { type: 'string' },
        age: { type: 'number' },
      });

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.properties!['name']).toEqual({ type: 'string' });
      expect(schema.properties!['age']).toEqual({ type: 'number' });
    });

    it('should include required fields', () => {
      const schema = createObjectSchema(
        {
          name: { type: 'string' },
          age: { type: 'number' },
          email: { type: 'string' },
        },
        ['name', 'age']
      );

      expect(schema.required).toEqual(['name', 'age']);
    });

    it('should accept additional options', () => {
      const schema = createObjectSchema(
        { id: { type: 'string' } },
        ['id'],
        { additionalProperties: false, description: 'User ID' }
      );

      expect(schema.additionalProperties).toBe(false);
      expect(schema.description).toBe('User ID');
    });
  });

  describe('createArraySchema', () => {
    it('should create simple array schema', () => {
      const schema = createArraySchema({ type: 'number' });

      expect(schema.type).toBe('array');
      expect(schema.items).toEqual({ type: 'number' });
    });

    it('should create array of objects', () => {
      const schema = createArraySchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      });

      expect(schema.type).toBe('array');
      expect(schema.items).toBeDefined();
      expect((schema.items as JSONSchema).type).toBe('object');
    });

    it('should accept array constraints', () => {
      const schema = createArraySchema(
        { type: 'string' },
        { minItems: 1, maxItems: 10 }
      );

      expect(schema.minItems).toBe(1);
      expect(schema.maxItems).toBe(10);
    });
  });

  describe('createEnumSchema', () => {
    it('should create enum schema', () => {
      const schema = createEnumSchema(['pending', 'active', 'completed']);

      expect(schema.type).toBe('string');
      expect(schema.enum).toEqual(['pending', 'active', 'completed']);
    });

    it('should accept description option', () => {
      const schema = createEnumSchema(['admin', 'user', 'guest'], {
        description: 'User role',
      });

      expect(schema.description).toBe('User role');
    });
  });

  describe('createUnionSchema', () => {
    it('should create union of types', () => {
      const schema = createUnionSchema([
        { type: 'string' },
        { type: 'number' },
      ]);

      expect(schema.anyOf).toBeDefined();
      expect(schema.anyOf!.length).toBe(2);
      expect(schema.anyOf![0]).toEqual({ type: 'string' });
      expect(schema.anyOf![1]).toEqual({ type: 'number' });
    });
  });

  describe('makeOptional', () => {
    it('should make schema optional by adding null', () => {
      const schema = makeOptional({ type: 'string' });

      expect(schema.anyOf).toBeDefined();
      expect(schema.anyOf!.length).toBe(2);
      expect(schema.anyOf![0]).toEqual({ type: 'string' });
      expect(schema.anyOf![1]).toEqual({ type: 'null' });
    });
  });

  describe('mergeSchemas', () => {
    it('should merge multiple schemas with allOf', () => {
      const baseSchema: JSONSchema = {
        type: 'object',
        properties: { id: { type: 'string' } },
      };

      const extraSchema: JSONSchema = {
        properties: { name: { type: 'string' } },
      };

      const merged = mergeSchemas([baseSchema, extraSchema]);

      expect(merged.allOf).toBeDefined();
      expect(merged.allOf!.length).toBe(2);
      expect(merged.allOf![0]).toEqual(baseSchema);
      expect(merged.allOf![1]).toEqual(extraSchema);
    });
  });

  describe('validateSchema', () => {
    it('should validate string type', () => {
      const schema: JSONSchema = { type: 'string' };
      expect(validateSchema('hello', schema)).toBe(true);
      expect(validateSchema(123, schema)).toBe(false);
    });

    it('should validate number type', () => {
      const schema: JSONSchema = { type: 'number' };
      expect(validateSchema(123, schema)).toBe(true);
      expect(validateSchema('hello', schema)).toBe(false);
    });

    it('should validate boolean type', () => {
      const schema: JSONSchema = { type: 'boolean' };
      expect(validateSchema(true, schema)).toBe(true);
      expect(validateSchema('true', schema)).toBe(false);
    });

    it('should validate array type', () => {
      const schema: JSONSchema = { type: 'array' };
      expect(validateSchema([1, 2, 3], schema)).toBe(true);
      expect(validateSchema({ a: 1 }, schema)).toBe(false);
    });

    it('should validate object type', () => {
      const schema: JSONSchema = { type: 'object' };
      expect(validateSchema({ a: 1 }, schema)).toBe(true);
      expect(validateSchema([1, 2, 3], schema)).toBe(false);
    });

    it('should validate null type', () => {
      const schema: JSONSchema = { type: 'null' };
      expect(validateSchema(null, schema)).toBe(true);
      expect(validateSchema(undefined, schema)).toBe(false);
    });
  });

  describe('isJsonSchema', () => {
    it('should detect simple schemas', () => {
      expect(isJsonSchema({ type: 'string' })).toBe(true);
    });

    it('should detect object schemas', () => {
      expect(isJsonSchema({ type: 'object', properties: {} })).toBe(true);
    });

    it('should reject plain objects', () => {
      expect(isJsonSchema({ name: 'Alice' })).toBe(false);
    });

    it('should reject primitives', () => {
      expect(isJsonSchema('string')).toBe(false);
      expect(isJsonSchema(123)).toBe(false);
    });
  });

  describe('complex schema example', () => {
    it('should create complex nested schema', () => {
      // Create a complex user schema
      const addressSchema = createObjectSchema({
        street: { type: 'string' },
        city: { type: 'string' },
        zipCode: { type: 'string' },
      }, ['street', 'city']);

      const userSchema = createObjectSchema({
        id: { type: 'string' },
        name: { type: 'string' },
        age: { type: 'integer' },
        email: { type: 'string', format: 'email' },
        role: createEnumSchema(['admin', 'user', 'guest']),
        address: makeOptional(addressSchema),
        tags: createArraySchema({ type: 'string' }),
      }, ['id', 'name', 'email']);

      // Verify structure
      expect(userSchema.type).toBe('object');
      expect(userSchema.properties).toBeDefined();
      expect(userSchema.required).toBeDefined();
      expect(userSchema.required).toEqual(['id', 'name', 'email']);

      // Verify nested schemas
      const roleSchema = userSchema.properties!['role'];
      expect(roleSchema.enum).toBeDefined();
      expect(roleSchema.enum).toEqual(['admin', 'user', 'guest']);

      const addressProp = userSchema.properties!['address'];
      expect(addressProp.anyOf).toBeDefined();

      const tagsSchema = userSchema.properties!['tags'];
      expect(tagsSchema.type).toBe('array');
      expect(tagsSchema.items).toEqual({ type: 'string' });
    });
  });
});
