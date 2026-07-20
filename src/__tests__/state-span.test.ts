import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform, arch } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

describe('State and Span NAPI Bindings', () => {
  let native: any;

  beforeAll(() => {
    // Dynamic platform-specific binary loading
    const platformMap: Record<string, string> = {
      'darwin-x64': 'darwin-x64',
      'darwin-arm64': 'darwin-arm64',
      'linux-x64': 'linux-x64-gnu',
      'win32-x64': 'win32-x64-msvc',
    };

    const key = `${platform()}-${arch()}`;
    const platformSuffix = platformMap[key];

    if (!platformSuffix) {
      throw new Error(`Unsupported platform: ${key}`);
    }

    const nativePath = join(__dirname, '../..', `agnt5-sdk-native.${platformSuffix}.node`);
    native = require(nativePath);
  });

  describe('StateManager', () => {
    it('should create StateManager instance', () => {
      const state = new native.StateManager();
      expect(state).toBeDefined();
    });

    it('should set and get values', async () => {
      const state = new native.StateManager();

      await state.set('name', Buffer.from('Alice'));
      const name = await state.get('name');

      expect(name).toBeDefined();
      expect(name?.toString()).toBe('Alice');
    });

    it('should handle JSON values', async () => {
      const state = new native.StateManager();
      const user = { id: 123, name: 'Bob', email: 'bob@example.com' };

      await state.set('user', Buffer.from(JSON.stringify(user)));
      const userBuf = await state.get('user');

      expect(userBuf).toBeDefined();
      const retrievedUser = JSON.parse(userBuf!.toString());
      expect(retrievedUser.id).toBe(123);
      expect(retrievedUser.name).toBe('Bob');
    });

    it('should return size of state', async () => {
      const state = new native.StateManager();

      await state.set('key1', Buffer.from('value1'));
      await state.set('key2', Buffer.from('value2'));

      const size = await state.size();
      expect(size).toBe(2);
    });

    it('should return all keys', async () => {
      const state = new native.StateManager();

      await state.set('name', Buffer.from('Alice'));
      await state.set('age', Buffer.from('30'));

      const keys = await state.keys();
      expect(keys).toContain('name');
      expect(keys).toContain('age');
    });

    it('should delete values', async () => {
      const state = new native.StateManager();

      await state.set('name', Buffer.from('Alice'));
      const deleted = await state.delete('name');

      expect(deleted).toBe(true);

      const nameAfterDelete = await state.get('name');
      expect(nameAfterDelete).toBeNull();
    });

    it('should clear all state', async () => {
      const state = new native.StateManager();

      await state.set('key1', Buffer.from('value1'));
      await state.set('key2', Buffer.from('value2'));

      await state.clear();
      const sizeAfterClear = await state.size();

      expect(sizeAfterClear).toBe(0);
    });
  });

  describe('Span', () => {
    it('should create span', () => {
      const span = native.Span.create('test-operation');

      expect(span).toBeDefined();
      expect(span.name).toBe('test-operation');
    });

    it('should set and get attributes', () => {
      const span = native.Span.create('test-operation');

      span.setAttribute('user.id', '123');
      span.setAttribute('operation.type', 'read');

      const attrs = span.getAttributes();
      expect(attrs['user.id']).toBe('123');
      expect(attrs['operation.type']).toBe('read');
    });

    it('should add events', () => {
      const span = native.Span.create('test-operation');

      span.addEvent('cache.hit', { key: 'user:123', ttl: '3600' });

      expect(() => span.addEvent('test-event')).not.toThrow();
    });

    it('should record errors', () => {
      const span = native.Span.create('test-operation');

      span.recordError('Simulated error for testing');

      const attrs = span.getAttributes();
      expect(attrs['error']).toBe('true');
    });

    it('should track ended state', () => {
      const span = native.Span.create('test-operation');

      expect(span.isEnded()).toBe(false);

      span.end();
      expect(span.isEnded()).toBe(true);
    });

    it('should throw error on double end', () => {
      const span = native.Span.create('test-operation');

      span.end();

      expect(() => span.end()).toThrow();
    });
  });

  describe('Combined Scenario', () => {
    it('should work with StateManager and Span together', async () => {
      const state = new native.StateManager();
      const span = native.Span.create('process-order');

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

      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 10));
      span.addEvent('order.processing');

      // Retrieve and update
      const orderBuf = await state.get('order:12345');
      expect(orderBuf).toBeDefined();

      const retrievedOrder = JSON.parse(orderBuf!.toString());
      retrievedOrder.status = 'processed';
      await state.set('order:12345', Buffer.from(JSON.stringify(retrievedOrder)));
      span.addEvent('order.updated', { status: 'processed' });

      span.setAttribute('order.status', 'success');
      span.end();

      expect(span.isEnded()).toBe(true);
    });
  });
});
