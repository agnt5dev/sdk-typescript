/**
 * Tool component for Agent capabilities.
 *
 * Tools wrap functions with structured interfaces for agent invocation.
 * Phase 1: In-memory execution with basic schema support
 * Phase 2: Platform integration with durable execution
 */

import type { Context, ToolHandler, ToolOptions, ToolSchema, JSONSchema } from './types.js';
import type { ContextImpl } from './context.js';
import { ConfigurationError } from './errors.js';

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

// ─── Built-in Human-in-the-Loop Tools ────────────────────────────────

/**
 * Built-in tool that agents can use to request text input from users.
 *
 * Pauses workflow execution and waits for the user to provide a text response.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   name: 'research_agent',
 *   model: LM.openai(),
 *   instructions: 'You are a research assistant.',
 *   tools: [new AskUserTool(wfCtx)],
 * });
 * ```
 */
export class AskUserTool extends Tool<{ question: string }, string | null> {
  constructor(context: ContextImpl) {
    if (!context || typeof (context as any).waitForUser !== 'function') {
      throw new ConfigurationError(
        'AskUserTool requires a ContextImpl with waitForUser. ' +
        'This tool can only be used within workflows.'
      );
    }
    const wfContext = context;
    super(
      'ask_user',
      'Ask the user a question and wait for their text response',
      async (_ctx: Context, args: any) => {
        const question = typeof args === 'string' ? args : args.question;
        return wfContext.waitForUser(question, { inputType: 'text' });
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Question to ask the user' },
          },
          required: ['question'],
        },
      },
    );
  }
}

/**
 * Built-in tool that agents can use to request approval from users.
 *
 * Pauses workflow execution and presents approve/reject options to the user.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   name: 'deploy_agent',
 *   model: LM.openai(),
 *   instructions: 'You help deploy code changes safely.',
 *   tools: [new RequestApprovalTool(wfCtx)],
 * });
 * ```
 */
export class RequestApprovalTool extends Tool<{ action: string; details?: string }, string | null> {
  constructor(context: ContextImpl) {
    if (!context || typeof (context as any).waitForUser !== 'function') {
      throw new ConfigurationError(
        'RequestApprovalTool requires a ContextImpl with waitForUser. ' +
        'This tool can only be used within workflows.'
      );
    }
    const wfContext = context;
    super(
      'request_approval',
      'Request user approval for an action before proceeding',
      async (_ctx: Context, args: any) => {
        let question = `Action: ${args.action}`;
        if (args.details) {
          question += `\n\nDetails:\n${args.details}`;
        }
        question += '\n\nDo you approve?';
        return wfContext.waitForUser(question, {
          inputType: 'approval',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
        });
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'The action requiring approval' },
            details: { type: 'string', description: 'Additional details about the action' },
          },
          required: ['action'],
        },
      },
    );
  }
}
