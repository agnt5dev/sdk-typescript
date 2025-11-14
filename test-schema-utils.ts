/**
 * Test suite for schema utilities
 *
 * Run with: npx tsx test-schema-utils.ts
 */

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
} from './src/schema-utils.js';
import type { JSONSchema } from './src/types.js';

// Test counter for tracking
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`❌ ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual: ${JSON.stringify(actual)}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

// Test 1: Basic type schemas
async function testTypeToSchema() {
  console.log('\n📋 Test 1: Type to Schema');

  const stringSchema = typeToSchema('string');
  assertEqual(stringSchema, { type: 'string' }, 'string schema');

  const numberSchema = typeToSchema('number');
  assertEqual(numberSchema, { type: 'number' }, 'number schema');

  const integerSchema = typeToSchema('integer');
  assertEqual(integerSchema, { type: 'integer' }, 'integer schema');

  const booleanSchema = typeToSchema('boolean');
  assertEqual(booleanSchema, { type: 'boolean' }, 'boolean schema');

  const arraySchema = typeToSchema('array');
  assertEqual(arraySchema, { type: 'array' }, 'array schema');

  const objectSchema = typeToSchema('object');
  assertEqual(objectSchema, { type: 'object' }, 'object schema');

  const nullSchema = typeToSchema('null');
  assertEqual(nullSchema, { type: 'null' }, 'null schema');

  // With options
  const stringWithDesc = typeToSchema('string', { description: 'User name' });
  assertEqual(stringWithDesc, { type: 'string', description: 'User name' }, 'string with description');

  console.log('✅ Type to Schema: All tests passed');
}

// Test 2: Object schemas
async function testCreateObjectSchema() {
  console.log('\n📋 Test 2: Create Object Schema');

  // Simple object
  const userSchema = createObjectSchema({
    name: { type: 'string' },
    age: { type: 'number' },
  });

  assertEqual(userSchema.type, 'object', 'object type');
  assert(userSchema.properties !== undefined, 'has properties');
  assertEqual(userSchema.properties!['name'], { type: 'string' }, 'name property');
  assertEqual(userSchema.properties!['age'], { type: 'number' }, 'age property');

  // With required fields
  const userSchemaWithRequired = createObjectSchema(
    {
      name: { type: 'string' },
      age: { type: 'number' },
      email: { type: 'string' },
    },
    ['name', 'age']
  );

  assertEqual(userSchemaWithRequired.required, ['name', 'age'], 'required fields');

  // With additional options
  const strictSchema = createObjectSchema(
    { id: { type: 'string' } },
    ['id'],
    { additionalProperties: false, description: 'User ID' }
  );

  assertEqual(strictSchema.additionalProperties, false, 'additional properties disabled');
  assertEqual(strictSchema.description, 'User ID', 'schema description');

  console.log('✅ Create Object Schema: All tests passed');
}

// Test 3: Array schemas
async function testCreateArraySchema() {
  console.log('\n📋 Test 3: Create Array Schema');

  // Simple array
  const numbersSchema = createArraySchema({ type: 'number' });
  assertEqual(numbersSchema.type, 'array', 'array type');
  assertEqual(numbersSchema.items, { type: 'number' }, 'items schema');

  // Array of objects
  const usersSchema = createArraySchema({
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
  });

  assertEqual(usersSchema.type, 'array', 'array of objects type');
  assert(usersSchema.items !== undefined, 'has items');
  assertEqual((usersSchema.items as JSONSchema).type, 'object', 'items are objects');

  // With options
  const limitedArray = createArraySchema(
    { type: 'string' },
    { minItems: 1, maxItems: 10 }
  );

  assertEqual(limitedArray.minItems, 1, 'min items');
  assertEqual(limitedArray.maxItems, 10, 'max items');

  console.log('✅ Create Array Schema: All tests passed');
}

// Test 4: Enum schemas
async function testCreateEnumSchema() {
  console.log('\n📋 Test 4: Create Enum Schema');

  const statusSchema = createEnumSchema(['pending', 'active', 'completed']);
  assertEqual(statusSchema.type, 'string', 'enum type');
  assertEqual(statusSchema.enum, ['pending', 'active', 'completed'], 'enum values');

  // With description
  const roleSchema = createEnumSchema(['admin', 'user', 'guest'], {
    description: 'User role',
  });

  assertEqual(roleSchema.description, 'User role', 'enum description');

  console.log('✅ Create Enum Schema: All tests passed');
}

// Test 5: Union schemas
async function testCreateUnionSchema() {
  console.log('\n📋 Test 5: Create Union Schema');

  const stringOrNumber = createUnionSchema([
    { type: 'string' },
    { type: 'number' },
  ]);

  assert(stringOrNumber.anyOf !== undefined, 'has anyOf');
  assertEqual(stringOrNumber.anyOf!.length, 2, 'two options');
  assertEqual(stringOrNumber.anyOf![0], { type: 'string' }, 'first option');
  assertEqual(stringOrNumber.anyOf![1], { type: 'number' }, 'second option');

  console.log('✅ Create Union Schema: All tests passed');
}

// Test 6: Optional schemas
async function testMakeOptional() {
  console.log('\n📋 Test 6: Make Optional');

  const optionalString = makeOptional({ type: 'string' });
  assert(optionalString.anyOf !== undefined, 'has anyOf');
  assertEqual(optionalString.anyOf!.length, 2, 'two options (type or null)');
  assertEqual(optionalString.anyOf![0], { type: 'string' }, 'first option is string');
  assertEqual(optionalString.anyOf![1], { type: 'null' }, 'second option is null');

  console.log('✅ Make Optional: All tests passed');
}

// Test 7: Merge schemas
async function testMergeSchemas() {
  console.log('\n📋 Test 7: Merge Schemas');

  const baseSchema: JSONSchema = {
    type: 'object',
    properties: { id: { type: 'string' } },
  };

  const extraSchema: JSONSchema = {
    properties: { name: { type: 'string' } },
  };

  const merged = mergeSchemas([baseSchema, extraSchema]);
  assert(merged.allOf !== undefined, 'has allOf');
  assertEqual(merged.allOf!.length, 2, 'two schemas');
  assertEqual(merged.allOf![0], baseSchema, 'first schema');
  assertEqual(merged.allOf![1], extraSchema, 'second schema');

  console.log('✅ Merge Schemas: All tests passed');
}

// Test 8: Validate schema
async function testValidateSchema() {
  console.log('\n📋 Test 8: Validate Schema');

  const stringSchema: JSONSchema = { type: 'string' };
  assert(validateSchema('hello', stringSchema), 'valid string');
  assert(!validateSchema(123, stringSchema), 'invalid string (number)');

  const numberSchema: JSONSchema = { type: 'number' };
  assert(validateSchema(123, numberSchema), 'valid number');
  assert(!validateSchema('hello', numberSchema), 'invalid number (string)');

  const booleanSchema: JSONSchema = { type: 'boolean' };
  assert(validateSchema(true, booleanSchema), 'valid boolean');
  assert(!validateSchema('true', booleanSchema), 'invalid boolean (string)');

  const arraySchema: JSONSchema = { type: 'array' };
  assert(validateSchema([1, 2, 3], arraySchema), 'valid array');
  assert(!validateSchema({ a: 1 }, arraySchema), 'invalid array (object)');

  const objectSchema: JSONSchema = { type: 'object' };
  assert(validateSchema({ a: 1 }, objectSchema), 'valid object');
  assert(!validateSchema([1, 2, 3], objectSchema), 'invalid object (array)');

  const nullSchema: JSONSchema = { type: 'null' };
  assert(validateSchema(null, nullSchema), 'valid null');
  assert(!validateSchema(undefined, nullSchema), 'invalid null (undefined)');

  console.log('✅ Validate Schema: All tests passed');
}

// Test 9: JSON Schema detection
async function testIsJsonSchema() {
  console.log('\n📋 Test 9: Is JSON Schema');

  assert(isJsonSchema({ type: 'string' }), 'simple schema');
  assert(isJsonSchema({ type: 'object', properties: {} }), 'object schema');
  assert(!isJsonSchema({ name: 'Alice' }), 'not a schema (plain object)');
  assert(!isJsonSchema('string'), 'not a schema (string)');
  assert(!isJsonSchema(123), 'not a schema (number)');

  console.log('✅ Is JSON Schema: All tests passed');
}

// Test 10: Complex schema example
async function testComplexSchema() {
  console.log('\n📋 Test 10: Complex Schema Example');

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
  assert(userSchema.type === 'object', 'user schema is object');
  assert(userSchema.properties !== undefined, 'has properties');
  assert(userSchema.required !== undefined, 'has required fields');
  assertEqual(userSchema.required, ['id', 'name', 'email'], 'required fields correct');

  // Verify nested schemas
  const roleSchema = userSchema.properties!['role'];
  assert(roleSchema.enum !== undefined, 'role has enum');
  assertEqual(roleSchema.enum, ['admin', 'user', 'guest'], 'role enum values');

  const addressProp = userSchema.properties!['address'];
  assert(addressProp.anyOf !== undefined, 'address is optional (anyOf)');

  const tagsSchema = userSchema.properties!['tags'];
  assertEqual(tagsSchema.type, 'array', 'tags is array');
  assertEqual(tagsSchema.items, { type: 'string' }, 'tags items are strings');

  console.log('✅ Complex Schema Example: All tests passed');
}

// Main test runner
async function runTests() {
  console.log('🧪 Running Schema Utilities Tests\n');
  console.log('='.repeat(60));

  try {
    await testTypeToSchema();
    await testCreateObjectSchema();
    await testCreateArraySchema();
    await testCreateEnumSchema();
    await testCreateUnionSchema();
    await testMakeOptional();
    await testMergeSchemas();
    await testValidateSchema();
    await testIsJsonSchema();
    await testComplexSchema();

    console.log('\n' + '='.repeat(60));
    console.log(`\n✅ All tests passed! (${testsPassed} assertions)`);
    console.log(`❌ Failed: ${testsFailed}`);
    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error(`\n❌ Test suite failed: ${error}`);
    console.error(`✅ Passed: ${testsPassed}`);
    console.error(`❌ Failed: ${testsFailed}`);
    process.exit(1);
  }
}

// Run tests
runTests();
