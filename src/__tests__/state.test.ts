import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager, MemoryStateAdapter, ScopedState, SessionContext, UserContext } from '../state.js';

describe('StateManager', () => {
  let adapter: MemoryStateAdapter;

  beforeEach(() => {
    adapter = new MemoryStateAdapter();
  });

  it('should get and set values', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    await state.set('key1', 'value1');
    expect(await state.get('key1')).toBe('value1');
  });

  it('should return default value for missing key', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    expect(await state.get('missing', 'fallback')).toBe('fallback');
    expect(await state.get('missing')).toBeUndefined();
  });

  it('should delete keys', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    await state.set('key1', 'value1');
    const deleted = await state.delete('key1');
    expect(deleted).toBe(true);
    expect(await state.get('key1')).toBeUndefined();

    const deletedAgain = await state.delete('key1');
    expect(deletedAgain).toBe(false);
  });

  it('should clear all state', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    await state.set('a', 1);
    await state.set('b', 2);
    await state.clear();

    expect(await state.keys()).toEqual([]);
    expect(await state.get('a')).toBeUndefined();
  });

  it('should list keys', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    await state.set('x', 1);
    await state.set('y', 2);
    await state.set('z', 3);

    const keys = await state.keys();
    expect(keys.sort()).toEqual(['x', 'y', 'z']);
  });

  it('should return all state via getAll()', async () => {
    const state = new StateManager(adapter, 'run', 'run-1');

    await state.set('name', 'test');
    await state.set('count', 42);

    const all = await state.getAll();
    expect(all).toEqual({ name: 'test', count: 42 });
  });

  it('should lazy-load only on first access', async () => {
    // Pre-populate the adapter
    await adapter.save('run', 'pre-loaded', { existing: 'data' });

    const state = new StateManager(adapter, 'run', 'pre-loaded');
    // First access triggers lazy load
    expect(await state.get('existing')).toBe('data');
  });

  it('should isolate state between scopes', async () => {
    const runState = new StateManager(adapter, 'run', 'id-1');
    const sessionState = new StateManager(adapter, 'session', 'id-1');

    await runState.set('key', 'run-value');
    await sessionState.set('key', 'session-value');

    expect(await runState.get('key')).toBe('run-value');
    expect(await sessionState.get('key')).toBe('session-value');
  });

  it('should isolate state between scope IDs', async () => {
    const state1 = new StateManager(adapter, 'run', 'run-1');
    const state2 = new StateManager(adapter, 'run', 'run-2');

    await state1.set('val', 100);
    await state2.set('val', 200);

    expect(await state1.get('val')).toBe(100);
    expect(await state2.get('val')).toBe(200);
  });
});

describe('ScopedState', () => {
  let adapter: MemoryStateAdapter;

  beforeEach(() => {
    adapter = new MemoryStateAdapter();
  });

  it('should provide run-scoped state', async () => {
    const scoped = new ScopedState(adapter, 'run-123');

    await scoped.run.set('phase', 'research');
    expect(await scoped.run.get('phase')).toBe('research');
  });

  it('should provide session-scoped state', async () => {
    const scoped = new ScopedState(adapter, 'run-1', 'session-abc');

    expect(scoped.session).toBeDefined();
    await scoped.session!.state.set('topic', 'AI');
    expect(await scoped.session!.state.get('topic')).toBe('AI');
    expect(scoped.session!.sessionId).toBe('session-abc');
  });

  it('should provide user-scoped state', async () => {
    const scoped = new ScopedState(adapter, 'run-1', null, 'user-42');

    expect(scoped.user).toBeDefined();
    await scoped.user!.state.set('theme', 'dark');
    expect(await scoped.user!.state.get('theme')).toBe('dark');
    expect(scoped.user!.userId).toBe('user-42');
  });

  it('should return null for session/user when not provided', () => {
    const scoped = new ScopedState(adapter, 'run-1');

    expect(scoped.session).toBeNull();
    expect(scoped.user).toBeNull();
  });

  it('should isolate state across run/session/user scopes', async () => {
    const scoped = new ScopedState(adapter, 'run-1', 'session-1', 'user-1');

    await scoped.run.set('key', 'run-val');
    await scoped.session!.state.set('key', 'session-val');
    await scoped.user!.state.set('key', 'user-val');

    expect(await scoped.run.get('key')).toBe('run-val');
    expect(await scoped.session!.state.get('key')).toBe('session-val');
    expect(await scoped.user!.state.get('key')).toBe('user-val');
  });

  it('should lazily create scope accessors (same instance on repeated access)', () => {
    const scoped = new ScopedState(adapter, 'run-1', 'session-1', 'user-1');

    const run1 = scoped.run;
    const run2 = scoped.run;
    expect(run1).toBe(run2);

    const session1 = scoped.session;
    const session2 = scoped.session;
    expect(session1).toBe(session2);

    const user1 = scoped.user;
    const user2 = scoped.user;
    expect(user1).toBe(user2);
  });
});
