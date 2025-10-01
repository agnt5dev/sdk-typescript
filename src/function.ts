import type {
  FunctionHandler,
  FunctionOptions,
  RetryPolicy,
  BackoffPolicy,
} from './types';

/**
 * Function builder for creating durable functions
 * @template TInput - Input parameter types
 * @template TOutput - Return type
 */
export class FunctionBuilder<TInput = any, TOutput = any> {
  private config: FunctionOptions = {};

  constructor(private name: string) {}

  /**
   * Configure retry policy
   */
  retry(policy: RetryPolicy): this {
    this.config.retries = policy;
    return this;
  }

  /**
   * Configure backoff strategy
   */
  backoff(policy: BackoffPolicy): this {
    this.config.backoff = policy;
    return this;
  }

  /**
   * Define the function handler
   */
  run(handler: FunctionHandler<TInput, TOutput>): FunctionHandler<TInput, TOutput> {
    // Register function with global registry
    FunctionRegistry.register(this.name, {
      handler,
      options: this.config,
    });

    return handler;
  }
}

/**
 * Create a new function builder
 * @param name - Unique function name
 * @returns Function builder instance
 *
 * @example
 * ```typescript
 * const greet = fn('greet').run(async (ctx, name: string) => {
 *   return `Hello, ${name}!`;
 * });
 * ```
 */
export function fn<TInput = any, TOutput = any>(
  name: string
): FunctionBuilder<TInput, TOutput> {
  return new FunctionBuilder<TInput, TOutput>(name);
}

/**
 * Internal function registry
 */
class FunctionRegistry {
  private static functions = new Map<
    string,
    { handler: FunctionHandler; options: FunctionOptions }
  >();

  static register(
    name: string,
    config: { handler: FunctionHandler; options: FunctionOptions }
  ) {
    this.functions.set(name, config);
  }

  static get(name: string) {
    return this.functions.get(name);
  }

  static getAll() {
    return Array.from(this.functions.entries());
  }

  static clear() {
    this.functions.clear();
  }
}

export { FunctionRegistry };
