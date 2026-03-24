/**
 * Scoped state management for AGNT5 components.
 *
 * Provides run/session/user scoped state with lazy loading
 * and an in-memory backend (platform-backed adapter can be swapped in later).
 */

/**
 * State adapter interface for pluggable backends.
 * The in-memory adapter is used by default; a platform-backed adapter
 * can be provided to persist state via the Rust core / gRPC.
 */
export interface StateAdapter {
  load(scope: string, scopeId: string): Promise<Record<string, any> | null>;
  save(scope: string, scopeId: string, state: Record<string, any>): Promise<void>;
}

/**
 * In-memory state adapter (default).
 * State lives only for the duration of the process.
 */
export class MemoryStateAdapter implements StateAdapter {
  private store = new Map<string, Record<string, any>>();

  private key(scope: string, scopeId: string): string {
    return `${scope}:${scopeId}`;
  }

  async load(scope: string, scopeId: string): Promise<Record<string, any> | null> {
    return this.store.get(this.key(scope, scopeId)) ?? null;
  }

  async save(scope: string, scopeId: string, state: Record<string, any>): Promise<void> {
    this.store.set(this.key(scope, scopeId), { ...state });
  }
}

/**
 * Scoped state manager with lazy loading.
 *
 * @example
 * ```typescript
 * const state = new StateManager(adapter, 'run', 'run-123');
 * await state.set('phase', 'research');
 * const phase = await state.get('phase'); // 'research'
 * ```
 */
export class StateManager {
  private _adapter: StateAdapter;
  private _scope: string;
  private _scopeId: string;
  private _cache: Record<string, any> | null = null;
  private _loaded = false;

  constructor(adapter: StateAdapter, scope: string, scopeId: string) {
    this._adapter = adapter;
    this._scope = scope;
    this._scopeId = scopeId;
  }

  /** Lazy-load state on first access */
  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    const data = await this._adapter.load(this._scope, this._scopeId);
    this._cache = data ?? {};
    this._loaded = true;
  }

  /** Save current state to adapter */
  private async save(): Promise<void> {
    if (this._cache) {
      await this._adapter.save(this._scope, this._scopeId, this._cache);
    }
  }

  async get<T = any>(key: string, defaultValue?: T): Promise<T | undefined> {
    await this.ensureLoaded();
    const val = this._cache![key];
    return val !== undefined ? val : defaultValue;
  }

  async set<T = any>(key: string, value: T): Promise<void> {
    await this.ensureLoaded();
    this._cache![key] = value;
    await this.save();
  }

  async delete(key: string): Promise<boolean> {
    await this.ensureLoaded();
    if (key in this._cache!) {
      delete this._cache![key];
      await this.save();
      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    this._cache = {};
    this._loaded = true;
    await this.save();
  }

  async keys(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this._cache!);
  }

  async getAll(): Promise<Record<string, any>> {
    await this.ensureLoaded();
    return { ...this._cache! };
  }
}

/**
 * Session-scoped context with its own StateManager.
 */
export class SessionContext {
  readonly sessionId: string;
  private _state: StateManager;

  constructor(adapter: StateAdapter, sessionId: string) {
    this.sessionId = sessionId;
    this._state = new StateManager(adapter, 'session', sessionId);
  }

  get state(): StateManager {
    return this._state;
  }
}

/**
 * User-scoped context with its own StateManager.
 */
export class UserContext {
  readonly userId: string;
  private _state: StateManager;

  constructor(adapter: StateAdapter, userId: string) {
    this.userId = userId;
    this._state = new StateManager(adapter, 'user', userId);
  }

  get state(): StateManager {
    return this._state;
  }
}

/**
 * Scoped state container providing run/session/user state access.
 * Properties are lazily created on first access.
 */
export class ScopedState {
  private _adapter: StateAdapter;
  private _runId: string;
  private _sessionId: string | null;
  private _userId: string | null;

  private _runState?: StateManager;
  private _session?: SessionContext;
  private _user?: UserContext;

  constructor(
    adapter: StateAdapter,
    runId: string,
    sessionId?: string | null,
    userId?: string | null,
  ) {
    this._adapter = adapter;
    this._runId = runId;
    this._sessionId = sessionId ?? null;
    this._userId = userId ?? null;
  }

  /** Run-scoped state (ephemeral, cleared when run completes) */
  get run(): StateManager {
    if (!this._runState) {
      this._runState = new StateManager(this._adapter, 'run', this._runId);
    }
    return this._runState;
  }

  /** Session-scoped context (multi-turn conversation state) */
  get session(): SessionContext | null {
    if (!this._sessionId) return null;
    if (!this._session) {
      this._session = new SessionContext(this._adapter, this._sessionId);
    }
    return this._session;
  }

  /** User-scoped context (long-term user preferences) */
  get user(): UserContext | null {
    if (!this._userId) return null;
    if (!this._user) {
      this._user = new UserContext(this._adapter, this._userId);
    }
    return this._user;
  }
}
