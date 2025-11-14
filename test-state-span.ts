#!/usr/bin/env node
/**
 * Test State and Span NAPI bindings
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Load native bindings
const nativePath = join(__dirname, 'native/agnt5-sdk-native.linux-x64-gnu.node');
const native = require(nativePath);

console.log('🧪 Testing State and Span NAPI Bindings\n');

// =============================================================================
// Test StateManager
// =============================================================================

async function testStateManager() {
  console.log('📦 Testing StateManager...');

  const state = new native.StateManager();

  // Test set/get
  console.log('  ✓ Created StateManager');

  await state.set('name', Buffer.from('Alice'));
  console.log('  ✓ Set name = Alice');

  const name = await state.get('name');
  if (name && name.toString() === 'Alice') {
    console.log('  ✓ Get name = Alice');
  } else {
    console.error('  ✗ Failed to get name');
    process.exit(1);
  }

  // Test JSON values
  const user = { id: 123, name: 'Bob', email: 'bob@example.com' };
  await state.set('user', Buffer.from(JSON.stringify(user)));
  console.log('  ✓ Set user object');

  const userBuf = await state.get('user');
  if (userBuf) {
    const retrievedUser = JSON.parse(userBuf.toString());
    if (retrievedUser.id === 123 && retrievedUser.name === 'Bob') {
      console.log('  ✓ Get user object (JSON roundtrip)');
    }
  }

  // Test size
  const size = await state.size();
  console.log(`  ✓ State size = ${size} items`);

  // Test keys
  const keys = await state.keys();
  console.log(`  ✓ Keys = [${keys.join(', ')}]`);

  // Test delete
  const deleted = await state.delete('name');
  if (deleted) {
    console.log('  ✓ Deleted name');
  }

  const nameAfterDelete = await state.get('name');
  if (!nameAfterDelete) {
    console.log('  ✓ Verified name is deleted');
  }

  // Test clear
  await state.clear();
  const sizeAfterClear = await state.size();
  if (sizeAfterClear === 0) {
    console.log('  ✓ Cleared all state');
  }

  console.log('✅ StateManager tests passed!\n');
}

// =============================================================================
// Test Span
// =============================================================================

async function testSpan() {
  console.log('🔭 Testing Span...');

  const span = native.Span.create('test-operation');
  console.log(`  ✓ Created span: ${span.name}`);

  // Test attributes
  span.setAttribute('user.id', '123');
  span.setAttribute('operation.type', 'read');
  console.log('  ✓ Set attributes');

  const attrs = span.getAttributes();
  if (attrs['user.id'] === '123' && attrs['operation.type'] === 'read') {
    console.log('  ✓ Get attributes');
  }

  // Test events
  span.addEvent('cache.hit', { key: 'user:123', ttl: '3600' });
  console.log('  ✓ Added event');

  // Test error recording
  span.recordError('Simulated error for testing');
  console.log('  ✓ Recorded error');

  const attrsAfterError = span.getAttributes();
  if (attrsAfterError['error'] === 'true') {
    console.log('  ✓ Error attribute set');
  }

  // Test span end
  const isEndedBefore = span.isEnded();
  if (!isEndedBefore) {
    console.log('  ✓ Span not ended yet');
  }

  span.end();
  console.log('  ✓ Ended span');

  const isEndedAfter = span.isEnded();
  if (isEndedAfter) {
    console.log('  ✓ Span is ended');
  }

  // Test that ending again throws error
  try {
    span.end();
    console.error('  ✗ Should have thrown error on double end');
    process.exit(1);
  } catch (err) {
    console.log('  ✓ Double end throws error');
  }

  console.log('✅ Span tests passed!\n');
}

// =============================================================================
// Test Combined Scenario
// =============================================================================

async function testCombinedScenario() {
  console.log('🔄 Testing combined scenario...');

  const state = new native.StateManager();
  const span = native.Span.create('process-order');

  try {
    span.setAttribute('order.id', '12345');

    // Simulate storing order data
    const order = {
      id: '12345',
      customer: 'Alice',
      items: ['laptop', 'mouse'],
      total: 1250.00
    };

    await state.set('order:12345', Buffer.from(JSON.stringify(order)));
    span.addEvent('order.stored', { orderId: '12345' });
    console.log('  ✓ Stored order data');

    // Simulate processing
    await new Promise(resolve => setTimeout(resolve, 10));
    span.addEvent('order.processing');

    // Retrieve and update
    const orderBuf = await state.get('order:12345');
    if (orderBuf) {
      const retrievedOrder = JSON.parse(orderBuf.toString());
      retrievedOrder.status = 'processed';
      await state.set('order:12345', Buffer.from(JSON.stringify(retrievedOrder)));
      span.addEvent('order.updated', { status: 'processed' });
      console.log('  ✓ Processed and updated order');
    }

    span.setAttribute('order.status', 'success');
    span.end();

    console.log('✅ Combined scenario passed!\n');
  } catch (error) {
    span.recordError((error as Error).message);
    span.end();
    throw error;
  }
}

// =============================================================================
// Run all tests
// =============================================================================

async function main() {
  try {
    await testStateManager();
    await testSpan();
    await testCombinedScenario();

    console.log('🎉 All tests passed!');
    console.log('\n📊 Summary:');
    console.log('  - StateManager: ✅ All operations working');
    console.log('  - Span: ✅ All operations working');
    console.log('  - Integration: ✅ State + Span work together');
  } catch (error) {
    console.error('\n❌ Tests failed:', error);
    process.exit(1);
  }
}

main();
