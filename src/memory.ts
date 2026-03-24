/**
 * Memory APIs for AGNT5 agents and workflows.
 *
 * Provides:
 * - ConversationMemory: Message history storage (state-adapter backed)
 * - SemanticMemory: Vector-backed similarity search (interface + adapter pattern)
 * - GraphMemory: In-memory knowledge graph with BFS traversal
 * - MemoryScope: Multi-scope isolation (user, session, agent, tenant, global)
 */

import { randomUUID } from 'crypto';
import type { StateAdapter } from './state.js';
import { MemoryStateAdapter } from './state.js';

// ─── Scopes ──────────────────────────────────────────────────────────

/** Memory scope for isolation */
export const MemoryScope = {
  USER: 'user',
  TENANT: 'tenant',
  AGENT: 'agent',
  SESSION: 'session',
  GLOBAL: 'global',

  validScopes(): string[] {
    return [this.USER, this.TENANT, this.AGENT, this.SESSION, this.GLOBAL];
  },

  isValid(scope: string): boolean {
    return this.validScopes().includes(scope);
  },

  /** Generate collection name for a scope */
  collectionName(scope: string, scopeId: string): string {
    const sanitized = scopeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${scope}_${sanitized}_memories`;
  },
} as const;

export type MemoryScopeType = 'user' | 'tenant' | 'agent' | 'session' | 'global';

// ─── Conversation Memory ─────────────────────────────────────────────

/** A message in conversation history */
export interface MemoryMessage {
  role: string;
  content: string;
  timestamp: number;
  metadata: Record<string, any>;
}

/**
 * Conversation memory backed by a StateAdapter.
 *
 * Stores message history per session, suitable for multi-turn conversations.
 *
 * @example
 * ```typescript
 * const memory = new ConversationMemory('session-123');
 * await memory.add('user', 'Hello!');
 * await memory.add('assistant', 'Hi there!');
 * const messages = await memory.getMessages();
 * ```
 */
export class ConversationMemory {
  private _sessionId: string;
  private _adapter: StateAdapter;
  private _storeKey: string;

  constructor(sessionId: string, adapter?: StateAdapter) {
    this._sessionId = sessionId;
    this._adapter = adapter || new MemoryStateAdapter();
    this._storeKey = `conversation:${sessionId}`;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /** Load the current session data */
  private async loadData(): Promise<Record<string, any>> {
    const data = await this._adapter.load('conversation', this._storeKey);
    return data || { messages: [], session_id: this._sessionId, created_at: Date.now(), message_count: 0 };
  }

  /** Save session data */
  private async saveData(data: Record<string, any>): Promise<void> {
    await this._adapter.save('conversation', this._storeKey, data);
  }

  /**
   * Get conversation messages, most recent first.
   *
   * @param limit - Maximum number of messages to return (default: 50)
   */
  async getMessages(limit: number = 50): Promise<MemoryMessage[]> {
    const data = await this.loadData();
    const messages: MemoryMessage[] = data.messages || [];
    return messages.slice(-limit);
  }

  /**
   * Add a message to the conversation.
   */
  async add(role: string, content: string, metadata?: Record<string, any>): Promise<void> {
    const data = await this.loadData();
    const messages: MemoryMessage[] = data.messages || [];

    messages.push({
      role,
      content,
      timestamp: Date.now() / 1000,
      metadata: metadata || {},
    });

    data.messages = messages;
    data.last_message_at = Date.now() / 1000;
    data.message_count = messages.length;
    await this.saveData(data);
  }

  /** Clear all messages */
  async clear(): Promise<void> {
    await this.saveData({
      messages: [],
      session_id: this._sessionId,
      created_at: Date.now(),
      message_count: 0,
    });
  }

  /**
   * Get messages formatted for LM consumption.
   *
   * @param limit - Maximum number of messages to return
   * @returns Messages as { role, content } objects
   */
  async getAsLmMessages(limit: number = 50): Promise<Array<{ role: string; content: string }>> {
    const messages = await this.getMessages(limit);
    return messages.map(m => ({ role: m.role, content: m.content }));
  }
}

// ─── Semantic Memory ─────────────────────────────────────────────────

/** Metadata associated with a memory entry */
export interface MemoryMetadata {
  source?: string;
  createdAt?: string;
  extra: Record<string, string>;
}

/** Result from a semantic memory search */
export interface MemoryResult {
  id: string;
  content: string;
  score: number;
  metadata: MemoryMetadata;
}

/**
 * Adapter interface for semantic memory backends (embeddings + vector DB).
 */
export interface SemanticMemoryAdapter {
  store(collection: string, content: string, metadata?: MemoryMetadata): Promise<string>;
  storeBatch(collection: string, contents: string[], metadata?: MemoryMetadata[]): Promise<string[]>;
  search(collection: string, query: string, limit: number, minScore?: number): Promise<MemoryResult[]>;
  get(collection: string, memoryId: string): Promise<MemoryResult | null>;
  forget(collection: string, memoryId: string): Promise<boolean>;
}

/**
 * In-memory semantic memory adapter using simple string similarity.
 *
 * Uses word overlap (Jaccard) as a stand-in for real embeddings.
 * For production, use a real vector DB adapter.
 */
export class InMemorySemanticAdapter implements SemanticMemoryAdapter {
  private collections = new Map<string, Map<string, { content: string; metadata: MemoryMetadata }>>();

  private getCollection(name: string): Map<string, { content: string; metadata: MemoryMetadata }> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  private tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  async store(collection: string, content: string, metadata?: MemoryMetadata): Promise<string> {
    const id = randomUUID();
    this.getCollection(collection).set(id, {
      content,
      metadata: metadata || { extra: {} },
    });
    return id;
  }

  async storeBatch(collection: string, contents: string[], metadata?: MemoryMetadata[]): Promise<string[]> {
    return Promise.all(contents.map((c, i) => this.store(collection, c, metadata?.[i])));
  }

  async search(collection: string, query: string, limit: number, minScore?: number): Promise<MemoryResult[]> {
    const coll = this.getCollection(collection);
    const queryTokens = this.tokenize(query);

    const results: MemoryResult[] = [];
    for (const [id, entry] of coll) {
      const score = this.jaccard(queryTokens, this.tokenize(entry.content));
      if (minScore !== undefined && score < minScore) continue;
      results.push({ id, content: entry.content, score, metadata: entry.metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async get(collection: string, memoryId: string): Promise<MemoryResult | null> {
    const entry = this.getCollection(collection).get(memoryId);
    if (!entry) return null;
    return { id: memoryId, content: entry.content, score: 1.0, metadata: entry.metadata };
  }

  async forget(collection: string, memoryId: string): Promise<boolean> {
    return this.getCollection(collection).delete(memoryId);
  }
}

/**
 * Semantic memory with vector-backed similarity search.
 *
 * @example
 * ```typescript
 * const memory = new SemanticMemory('user', 'user-123');
 * const id = await memory.store('TypeScript is great for type safety');
 * const results = await memory.search('type checking', 5);
 * ```
 */
export class SemanticMemory {
  private _scope: MemoryScopeType;
  private _scopeId: string;
  private _adapter: SemanticMemoryAdapter;
  private _collection: string;

  constructor(scope: MemoryScopeType, scopeId: string, adapter?: SemanticMemoryAdapter) {
    if (!MemoryScope.isValid(scope)) {
      throw new Error(`Invalid memory scope: ${scope}. Valid: ${MemoryScope.validScopes().join(', ')}`);
    }
    this._scope = scope;
    this._scopeId = scopeId;
    this._adapter = adapter || new InMemorySemanticAdapter();
    this._collection = MemoryScope.collectionName(scope, scopeId);
  }

  get scope(): MemoryScopeType {
    return this._scope;
  }

  get scopeId(): string {
    return this._scopeId;
  }

  get collectionName(): string {
    return this._collection;
  }

  /** Store a content string. Returns the memory ID. */
  async store(content: string, metadata?: MemoryMetadata): Promise<string> {
    return this._adapter.store(this._collection, content, metadata);
  }

  /** Store multiple content strings. Returns memory IDs. */
  async storeBatch(contents: string[], metadata?: MemoryMetadata[]): Promise<string[]> {
    return this._adapter.storeBatch(this._collection, contents, metadata);
  }

  /** Search for similar content. */
  async search(query: string, limit: number = 10, minScore?: number): Promise<MemoryResult[]> {
    return this._adapter.search(this._collection, query, limit, minScore);
  }

  /** Get a specific memory by ID. */
  async get(memoryId: string): Promise<MemoryResult | null> {
    return this._adapter.get(this._collection, memoryId);
  }

  /** Delete a memory by ID. */
  async forget(memoryId: string): Promise<boolean> {
    return this._adapter.forget(this._collection, memoryId);
  }
}

// ─── Graph Memory ────────────────────────────────────────────────────

/** A node in the knowledge graph */
export interface GraphNode {
  id: string;
  nodeType: string;
  properties: Record<string, string>;
}

/** A relationship between two nodes */
export interface GraphRelationship {
  id: string;
  fromNode: string;
  toNode: string;
  relationshipType: string;
  properties: Record<string, string>;
  createdAt: number;
}

/** Result of a graph traversal */
export interface GraphTraversalResult {
  startNode: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  depth: number;
}

/**
 * In-memory knowledge graph with BFS traversal.
 *
 * @example
 * ```typescript
 * const graph = new GraphMemory('user:alice');
 * await graph.upsertNode('alice', 'User', { name: 'Alice' });
 * await graph.upsertNode('python', 'Topic', { name: 'Python' });
 * await graph.relate('alice', 'python', 'likes');
 *
 * const result = await graph.traverse('alice', 2);
 * console.log(result.nodes); // alice + python
 * ```
 */
export class GraphMemory {
  private _scope: string;
  private _nodes = new Map<string, GraphNode>();
  private _relationships = new Map<string, GraphRelationship>();
  // Indices for fast lookup
  private _fromIndex = new Map<string, Set<string>>(); // nodeId -> Set<relId>
  private _toIndex = new Map<string, Set<string>>();   // nodeId -> Set<relId>

  constructor(scope: string) {
    this._scope = scope;
  }

  get scope(): string {
    return this._scope;
  }

  /** Create or update a node */
  async upsertNode(nodeId: string, nodeType: string, properties?: Record<string, string>): Promise<string> {
    const existing = this._nodes.get(nodeId);
    if (existing) {
      existing.nodeType = nodeType;
      if (properties) {
        Object.assign(existing.properties, properties);
      }
    } else {
      this._nodes.set(nodeId, {
        id: nodeId,
        nodeType,
        properties: properties || {},
      });
    }
    return nodeId;
  }

  /** Get a node by ID */
  async getNode(nodeId: string): Promise<GraphNode | null> {
    return this._nodes.get(nodeId) || null;
  }

  /** Delete a node and all its relationships */
  async deleteNode(nodeId: string): Promise<boolean> {
    if (!this._nodes.has(nodeId)) return false;

    // Remove all relationships involving this node
    const fromRels = this._fromIndex.get(nodeId) || new Set();
    const toRels = this._toIndex.get(nodeId) || new Set();
    for (const relId of [...fromRels, ...toRels]) {
      this._relationships.delete(relId);
    }
    this._fromIndex.delete(nodeId);
    this._toIndex.delete(nodeId);

    // Clean up reverse index entries
    for (const [, rels] of this._fromIndex) {
      for (const relId of [...rels]) {
        if (!this._relationships.has(relId)) rels.delete(relId);
      }
    }
    for (const [, rels] of this._toIndex) {
      for (const relId of [...rels]) {
        if (!this._relationships.has(relId)) rels.delete(relId);
      }
    }

    this._nodes.delete(nodeId);
    return true;
  }

  /** Create a relationship between two nodes */
  async relate(
    fromNode: string,
    toNode: string,
    relationshipType: string,
    properties?: Record<string, string>,
  ): Promise<string> {
    const id = randomUUID();
    const rel: GraphRelationship = {
      id,
      fromNode,
      toNode,
      relationshipType,
      properties: properties || {},
      createdAt: Date.now(),
    };

    this._relationships.set(id, rel);

    // Update indices
    if (!this._fromIndex.has(fromNode)) this._fromIndex.set(fromNode, new Set());
    this._fromIndex.get(fromNode)!.add(id);

    if (!this._toIndex.has(toNode)) this._toIndex.set(toNode, new Set());
    this._toIndex.get(toNode)!.add(id);

    return id;
  }

  /** Query relationships with optional filters */
  async queryRelationships(opts?: {
    fromNode?: string;
    toNode?: string;
    relationshipType?: string;
    limit?: number;
  }): Promise<GraphRelationship[]> {
    let results: GraphRelationship[] = [];

    if (opts?.fromNode) {
      const relIds = this._fromIndex.get(opts.fromNode) || new Set();
      for (const relId of relIds) {
        const rel = this._relationships.get(relId);
        if (rel) results.push(rel);
      }
    } else if (opts?.toNode) {
      const relIds = this._toIndex.get(opts.toNode) || new Set();
      for (const relId of relIds) {
        const rel = this._relationships.get(relId);
        if (rel) results.push(rel);
      }
    } else {
      results = Array.from(this._relationships.values());
    }

    // Apply filters
    if (opts?.fromNode && opts?.toNode) {
      results = results.filter(r => r.toNode === opts.toNode);
    }
    if (opts?.relationshipType) {
      results = results.filter(r => r.relationshipType === opts.relationshipType);
    }

    const limit = opts?.limit ?? 100;
    return results.slice(0, limit);
  }

  /** Delete a relationship by ID */
  async deleteRelationship(relationshipId: string): Promise<boolean> {
    const rel = this._relationships.get(relationshipId);
    if (!rel) return false;

    this._relationships.delete(relationshipId);
    this._fromIndex.get(rel.fromNode)?.delete(relationshipId);
    this._toIndex.get(rel.toNode)?.delete(relationshipId);
    return true;
  }

  /**
   * BFS traversal from a starting node.
   *
   * @param startNode - Starting node ID
   * @param depth - Maximum traversal depth (default: 2)
   * @param relationshipTypes - Filter by relationship types
   * @param nodeTypes - Filter by node types
   */
  async traverse(
    startNode: string,
    depth: number = 2,
    relationshipTypes?: string[],
    nodeTypes?: string[],
  ): Promise<GraphTraversalResult> {
    const visitedNodes = new Set<string>();
    const collectedNodes: GraphNode[] = [];
    const collectedRels: GraphRelationship[] = [];

    // BFS
    let frontier = [startNode];
    let currentDepth = 0;
    let maxDepthReached = 0;

    while (frontier.length > 0 && currentDepth <= depth) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        if (visitedNodes.has(nodeId)) continue;
        visitedNodes.add(nodeId);

        const node = this._nodes.get(nodeId);
        if (!node) continue;

        // Apply node type filter (always include start node)
        if (nodeTypes && nodeTypes.length > 0 && nodeId !== startNode && !nodeTypes.includes(node.nodeType)) {
          continue;
        }

        collectedNodes.push(node);
        if (currentDepth > maxDepthReached) maxDepthReached = currentDepth;

        if (currentDepth < depth) {
          // Explore outgoing relationships
          const relIds = this._fromIndex.get(nodeId) || new Set();
          for (const relId of relIds) {
            const rel = this._relationships.get(relId);
            if (!rel) continue;
            if (relationshipTypes && relationshipTypes.length > 0 && !relationshipTypes.includes(rel.relationshipType)) continue;
            if (!visitedNodes.has(rel.toNode)) {
              collectedRels.push(rel);
              nextFrontier.push(rel.toNode);
            }
          }

          // Explore incoming relationships too (undirected traversal)
          const inRelIds = this._toIndex.get(nodeId) || new Set();
          for (const relId of inRelIds) {
            const rel = this._relationships.get(relId);
            if (!rel) continue;
            if (relationshipTypes && relationshipTypes.length > 0 && !relationshipTypes.includes(rel.relationshipType)) continue;
            if (!visitedNodes.has(rel.fromNode)) {
              collectedRels.push(rel);
              nextFrontier.push(rel.fromNode);
            }
          }
        }
      }

      frontier = nextFrontier;
      currentDepth++;
    }

    return {
      startNode,
      nodes: collectedNodes,
      relationships: collectedRels,
      depth: maxDepthReached,
    };
  }
}
