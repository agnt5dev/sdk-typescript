/**
 * Example: Entity component usage
 *
 * Demonstrates stateful entities with single-writer consistency
 */

import { entity, _clearEntityState } from '../src/index.js';

// Define a Counter entity
const Counter = entity('Counter');

Counter.method('increment', async (ctx, amount: number = 1) => {
  const current = ctx.get<number>('count', 0) ?? 0;
  const newCount = current + amount;
  ctx.set('count', newCount);
  ctx.logger.info(`Incremented by ${amount}: ${current} → ${newCount}`);
  return newCount;
});

Counter.method('decrement', async (ctx, amount: number = 1) => {
  const current = ctx.get<number>('count', 0) ?? 0;
  const newCount = current - amount;
  ctx.set('count', newCount);
  ctx.logger.info(`Decremented by ${amount}: ${current} → ${newCount}`);
  return newCount;
});

Counter.method('getCount', async (ctx) => {
  return ctx.get<number>('count', 0);
});

Counter.method('reset', async (ctx) => {
  ctx.set('count', 0);
  ctx.logger.info('Counter reset to 0');
  return 0;
});

// Define a BankAccount entity
const BankAccount = entity('BankAccount');

BankAccount.method('deposit', async (ctx, amount: number) => {
  const balance = ctx.get<number>('balance', 0) ?? 0;
  const newBalance = balance + amount;
  ctx.set('balance', newBalance);
  ctx.logger.info(`Deposited $${amount}: $${balance} → $${newBalance}`);
  return newBalance;
});

BankAccount.method('withdraw', async (ctx, amount: number) => {
  const balance = ctx.get<number>('balance', 0) ?? 0;

  if (amount > balance) {
    throw new Error(`Insufficient funds: balance=$${balance}, requested=$${amount}`);
  }

  const newBalance = balance - amount;
  ctx.set('balance', newBalance);
  ctx.logger.info(`Withdrew $${amount}: $${balance} → $${newBalance}`);
  return newBalance;
});

BankAccount.method('getBalance', async (ctx) => {
  return ctx.get<number>('balance', 0);
});

async function main() {
  console.log('=== Entity Example ===\n');

  // Clear any previous state
  _clearEntityState();

  // Counter example
  console.log('1. Counter Entity:');
  const counter1 = Counter.call('user-123');
  const counter2 = Counter.call('user-456');

  await counter1.invoke('increment', 5);
  await counter1.invoke('increment', 3);
  const count1 = await counter1.invoke('getCount');
  console.log(`Counter 1 final value: ${count1}`);

  await counter2.invoke('increment', 10);
  const count2 = await counter2.invoke('getCount');
  console.log(`Counter 2 final value: ${count2}`);

  // Bank account example
  console.log('\n2. Bank Account Entity:');
  const account = BankAccount.call('account-789');

  await account.invoke('deposit', 100);
  await account.invoke('deposit', 50);
  await account.invoke('withdraw', 30);
  const balance = await account.invoke('getBalance');
  console.log(`Account final balance: $${balance}`);

  // Try overdraft (should fail)
  console.log('\n3. Testing overdraft protection:');
  try {
    await account.invoke('withdraw', 200);
  } catch (error) {
    console.log('Overdraft prevented:', (error as Error).message);
  }

  // Concurrent operations (single-writer ensures serialization)
  console.log('\n4. Concurrent operations (single-writer guarantee):');
  const counter3 = Counter.call('concurrent-test');

  await Promise.all([
    counter3.invoke('increment', 1),
    counter3.invoke('increment', 1),
    counter3.invoke('increment', 1),
    counter3.invoke('increment', 1),
    counter3.invoke('increment', 1)
  ]);

  const finalCount = await counter3.invoke('getCount');
  console.log(`After 5 concurrent increments: ${finalCount} (should be 5)`);
}

main().catch(console.error);
