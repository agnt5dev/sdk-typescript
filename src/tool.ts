/**
 * Tool component for Agent capabilities.
 *
 * Tools wrap functions with structured interfaces for agent invocation.
 * Phase 1: In-memory execution with basic schema support
 * Phase 2: Platform integration with durable execution
 */

import type { Context, ToolHandler, ToolOptions, ToolSchema, JSONSchema } from './types.js';

/**
 * Tool class representing a callable tool for agents
 */
export class Tool<TInput = any, TOutput = any> {
  readonly name: string;
  readonly description: string;
  readonly handler: ToolHandler<TInput, TOutput>;
  readonly inputSchema: JSONSchema;
  readonly confirmation: boolean;
  readonly outputSchema?: JSONSchema;

  constructor(
    name: string,
    description: string,
    handler: ToolHandler<TInput, TOutput>,
    options: Partial<ToolOptions> = {}
  ) {
    this.name = name;
    this.description = description;
    this.handler = handler;
    this.confirmation = options.confirmation || false;

    // Use provided schema or create default
    this.inputSchema = options.inputSchema || {
      type: 'object',
      properties: {},
      required: []
    };
  }

  /**
   * Invoke the tool with given arguments
   */
  async invoke(ctx: Context, args: Record<string, any>): Promise<TOutput> {
    if (this.confirmation) {
      ctx.logger.warn(
        `Tool '${this.name}' requires confirmation but confirmation is not implemented in Phase 1`
      );
    }

    ctx.logger.debug(`Invoking tool '${this.name}' with args: ${Object.keys(args).join(', ')}`);

    // Execute handler
    const result = await this.handler(ctx, args);

    ctx.logger.debug(`Tool '${this.name}' completed successfully`);
    return result;
  }

  /**
   * Get complete tool schema for agent consumption
   */
  getSchema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
      requires_confirmation: this.confirmation
    };
  }
}

/**
 * Global registry for tools
 */
export class ToolRegistry {
  private static tools: Map<string, Tool> = new Map();

  /**
   * Register a tool
   */
  static register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Overwriting existing tool '${tool.name}'`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name
   */
  static get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  static all(): Map<string, Tool> {
    return new Map(this.tools);
  }

  /**
   * List all tool names
   */
  static listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Clear all registered tools (for testing)
   */
  static clear(): void {
    this.tools.clear();
  }
}

/**
 * Decorator to mark a function as a tool
 *
 * @example
 * ```typescript
 * const searchWeb = tool('search_web', {
 *   description: 'Search the web for information',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       query: { type: 'string', description: 'Search query' },
 *       maxResults: { type: 'integer', description: 'Max results' }
 *     },
 *     required: ['query']
 *   }
 * }, async (ctx, args) => {
 *   const { query, maxResults = 10 } = args;
 *   // Implementation
 *   return results;
 * });
 * ```
 */
export function tool<TInput = any, TOutput = any>(
  name: string,
  options: ToolOptions,
  handler: ToolHandler<TInput, TOutput>
): ToolHandler<TInput, TOutput> {
  // Extract description
  const description = options.description || name;

  // Create Tool instance
  const toolInstance = new Tool(name, description, handler, options);

  // Register tool
  ToolRegistry.register(toolInstance);

  // Return wrapper that can invoke tool
  const toolWrapper = async (ctx: Context, ...args: any[]): Promise<TOutput> => {
    // If called with object args, use tool.invoke
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      return toolInstance.invoke(ctx, args[0]);
    }

    // Otherwise, direct call
    return toolInstance.handler(ctx, ...args);
  };

  // Attach tool instance for inspection
  (toolWrapper as any)._tool = toolInstance;

  return toolWrapper as ToolHandler<TInput, TOutput>;
}
