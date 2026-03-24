import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryScope,
  ConversationMemory,
  SemanticMemory,
  InMemorySemanticAdapter,
  GraphMemory,
} from '../memory.js';
import { MemoryStateAdapter } from '../state.js';

describe('MemoryScope', () => {
  it('should list valid scopes', () => {
    const scopes = MemoryScope.validScopes();
    expect(scopes).toContain('user');
    expect(scopes).toContain('session');
    expect(scopes).toContain('global');
    expect(scopes).toHaveLength(5);
  });

  it('should validate scopes', () => {
    expect(MemoryScope.isValid('user')).toBe(true);
    expect(MemoryScope.isValid('invalid')).toBe(false);
  });

  it('should generate collection names', () => {
    const name = MemoryScope.collectionName('user', 'alice-123');
    expect(name).toBe('user_alice-123_memories');
  });

  it('should sanitize scope IDs', () => {
    const name = MemoryScope.collectionName('user', 'alice@example.com');
    expect(name).toBe('user_alice_example_com_memories');
  });
});

describe('ConversationMemory', () => {
  let adapter: MemoryStateAdapter;

  beforeEach(() => {
    adapter = new MemoryStateAdapter();
  });

  it('should add and retrieve messages', async () => {
    const memory = new ConversationMemory('session-1', adapter);
    await memory.add('user', 'Hello!');
    await memory.add('assistant', 'Hi there!');

    const messages = await memory.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello!');
    expect(messages[1].role).toBe('assistant');
  });

  it('should limit returned messages', async () => {
    const memory = new ConversationMemory('session-2', adapter);
    for (let i = 0; i < 10; i++) {
      await memory.add('user', `Message ${i}`);
    }

    const recent = await memory.getMessages(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe('Message 7');
    expect(recent[2].content).toBe('Message 9');
  });

  it('should clear messages', async () => {
    const memory = new ConversationMemory('session-3', adapter);
    await memory.add('user', 'Hello!');
    await memory.clear();

    const messages = await memory.getMessages();
    expect(messages).toHaveLength(0);
  });

  it('should get messages as LM format', async () => {
    const memory = new ConversationMemory('session-4', adapter);
    await memory.add('user', 'What is 2+2?');
    await memory.add('assistant', '4');

    const lmMessages = await memory.getAsLmMessages();
    expect(lmMessages).toEqual([
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
    ]);
  });

  it('should store metadata with messages', async () => {
    const memory = new ConversationMemory('session-5', adapter);
    await memory.add('user', 'Hello!', { source: 'chat' });

    const messages = await memory.getMessages();
    expect(messages[0].metadata).toEqual({ source: 'chat' });
  });

  it('should isolate sessions', async () => {
    const m1 = new ConversationMemory('session-a', adapter);
    const m2 = new ConversationMemory('session-b', adapter);

    await m1.add('user', 'From A');
    await m2.add('user', 'From B');

    expect((await m1.getMessages())[0].content).toBe('From A');
    expect((await m2.getMessages())[0].content).toBe('From B');
  });
});

describe('SemanticMemory', () => {
  let adapter: InMemorySemanticAdapter;

  beforeEach(() => {
    adapter = new InMemorySemanticAdapter();
  });

  it('should store and retrieve by ID', async () => {
    const memory = new SemanticMemory('user', 'alice', adapter);
    const id = await memory.store('TypeScript is a typed language');
    expect(id).toBeDefined();

    const result = await memory.get(id);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('TypeScript is a typed language');
  });

  it('should search by similarity', async () => {
    const memory = new SemanticMemory('user', 'alice', adapter);
    await memory.store('Python is great for data science');
    await memory.store('TypeScript has strong type checking');
    await memory.store('Go is fast and compiled');

    const results = await memory.search('type safety in programming');
    expect(results.length).toBeGreaterThan(0);
    // The TypeScript entry should rank higher for "type" query
  });

  it('should store batch', async () => {
    const memory = new SemanticMemory('session', 's1', adapter);
    const ids = await memory.storeBatch(['fact 1', 'fact 2', 'fact 3']);
    expect(ids).toHaveLength(3);
  });

  it('should forget memories', async () => {
    const memory = new SemanticMemory('user', 'bob', adapter);
    const id = await memory.store('secret info');

    expect(await memory.forget(id)).toBe(true);
    expect(await memory.get(id)).toBeNull();
    expect(await memory.forget('nonexistent')).toBe(false);
  });

  it('should use scope-based collection names', () => {
    const memory = new SemanticMemory('user', 'alice');
    expect(memory.collectionName).toBe('user_alice_memories');
    expect(memory.scope).toBe('user');
    expect(memory.scopeId).toBe('alice');
  });

  it('should reject invalid scopes', () => {
    expect(() => new SemanticMemory('bad' as any, 'id')).toThrow('Invalid memory scope');
  });

  it('should respect minScore filter', async () => {
    const memory = new SemanticMemory('user', 'test', adapter);
    await memory.store('completely unrelated content about cooking recipes');
    await memory.store('TypeScript types and interfaces');

    const results = await memory.search('TypeScript type system', 10, 0.5);
    // With high minScore, unrelated content may be filtered
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('GraphMemory', () => {
  let graph: GraphMemory;

  beforeEach(() => {
    graph = new GraphMemory('user:alice');
  });

  it('should create and retrieve nodes', async () => {
    await graph.upsertNode('alice', 'User', { name: 'Alice' });
    const node = await graph.getNode('alice');
    expect(node).not.toBeNull();
    expect(node!.id).toBe('alice');
    expect(node!.nodeType).toBe('User');
    expect(node!.properties.name).toBe('Alice');
  });

  it('should update existing nodes', async () => {
    await graph.upsertNode('alice', 'User', { name: 'Alice' });
    await graph.upsertNode('alice', 'Admin', { role: 'admin' });

    const node = await graph.getNode('alice');
    expect(node!.nodeType).toBe('Admin');
    expect(node!.properties.name).toBe('Alice');
    expect(node!.properties.role).toBe('admin');
  });

  it('should create relationships', async () => {
    await graph.upsertNode('alice', 'User');
    await graph.upsertNode('python', 'Topic');

    const relId = await graph.relate('alice', 'python', 'likes', { since: '2020' });
    expect(relId).toBeDefined();

    const rels = await graph.queryRelationships({ fromNode: 'alice' });
    expect(rels).toHaveLength(1);
    expect(rels[0].relationshipType).toBe('likes');
    expect(rels[0].toNode).toBe('python');
    expect(rels[0].properties.since).toBe('2020');
  });

  it('should query relationships with filters', async () => {
    await graph.upsertNode('alice', 'User');
    await graph.upsertNode('python', 'Topic');
    await graph.upsertNode('typescript', 'Topic');
    await graph.relate('alice', 'python', 'likes');
    await graph.relate('alice', 'typescript', 'uses');

    const likes = await graph.queryRelationships({ fromNode: 'alice', relationshipType: 'likes' });
    expect(likes).toHaveLength(1);
    expect(likes[0].toNode).toBe('python');

    const all = await graph.queryRelationships({ fromNode: 'alice' });
    expect(all).toHaveLength(2);
  });

  it('should delete nodes and their relationships', async () => {
    await graph.upsertNode('alice', 'User');
    await graph.upsertNode('bob', 'User');
    await graph.relate('alice', 'bob', 'knows');

    expect(await graph.deleteNode('alice')).toBe(true);
    expect(await graph.getNode('alice')).toBeNull();

    // Relationship should be gone too
    const rels = await graph.queryRelationships({ fromNode: 'alice' });
    expect(rels).toHaveLength(0);
  });

  it('should delete relationships', async () => {
    await graph.upsertNode('a', 'Node');
    await graph.upsertNode('b', 'Node');
    const relId = await graph.relate('a', 'b', 'connects');

    expect(await graph.deleteRelationship(relId)).toBe(true);
    expect(await graph.deleteRelationship(relId)).toBe(false);

    const rels = await graph.queryRelationships({ fromNode: 'a' });
    expect(rels).toHaveLength(0);
  });

  it('should traverse graph with BFS', async () => {
    // Build a small graph: alice -> bob -> charlie
    await graph.upsertNode('alice', 'User');
    await graph.upsertNode('bob', 'User');
    await graph.upsertNode('charlie', 'User');
    await graph.upsertNode('python', 'Topic');

    await graph.relate('alice', 'bob', 'knows');
    await graph.relate('bob', 'charlie', 'knows');
    await graph.relate('alice', 'python', 'likes');

    // Depth 1: should find alice + direct neighbors
    const d1 = await graph.traverse('alice', 1);
    expect(d1.startNode).toBe('alice');
    expect(d1.nodes.map(n => n.id)).toContain('alice');
    expect(d1.nodes.map(n => n.id)).toContain('bob');
    expect(d1.nodes.map(n => n.id)).toContain('python');
    expect(d1.nodes.map(n => n.id)).not.toContain('charlie');

    // Depth 2: should find charlie too
    const d2 = await graph.traverse('alice', 2);
    expect(d2.nodes.map(n => n.id)).toContain('charlie');
  });

  it('should filter traversal by relationship type', async () => {
    await graph.upsertNode('alice', 'User');
    await graph.upsertNode('bob', 'User');
    await graph.upsertNode('python', 'Topic');

    await graph.relate('alice', 'bob', 'knows');
    await graph.relate('alice', 'python', 'likes');

    const result = await graph.traverse('alice', 1, ['knows']);
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('bob');
    expect(nodeIds).not.toContain('python');
  });

  it('should handle cycles in traversal', async () => {
    await graph.upsertNode('a', 'Node');
    await graph.upsertNode('b', 'Node');
    await graph.relate('a', 'b', 'connects');
    await graph.relate('b', 'a', 'connects');

    // Should not infinite loop
    const result = await graph.traverse('a', 5);
    expect(result.nodes).toHaveLength(2);
  });

  it('should return empty for non-existent start node', async () => {
    const result = await graph.traverse('nonexistent', 2);
    expect(result.nodes).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });
});
