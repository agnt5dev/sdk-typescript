/**
 * Agent component for LLM-driven autonomous execution.
 *
 * Phase 1: Simple agent with external LLM integration and tool orchestration
 * Phase 2: Platform-backed agents with durable execution and multi-agent coordination
 */

import type { Context, ToolSchema } from './types.js';
import type { Tool } from './tool.js';
import { ContextImpl } from './context.js';

/**
 * Message role in conversation
 */
export enum MessageRole {
  System = 'system',
  User = 'user',
  Assistant = 'assistant'
}

/**
 * Conversation message
 */
export interface Message {
  role: MessageRole;
  content: string;
}

/**
 * Message factory functions
 */
export const Message = {
  system: (content: string): Message => ({ role: MessageRole.System, content }),
  user: (content: string): Message => ({ role: MessageRole.User, content }),
  assistant: (content: string): Message => ({ role: MessageRole.Assistant, content })
};

/**
 * Tool call from LLM
 */
export interface ToolCall {
  name: string;
  arguments: string; // JSON string
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Generation configuration
 */
export interface GenerationConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * LLM generation request
 */
export interface GenerateRequest {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolSchema[];
  config?: GenerationConfig;
}

/**
 * LLM generation response
 */
export interface GenerateResponse {
  text: string;
  usage?: TokenUsage;
  finishReason?: string;
  toolCalls?: ToolCall[];
}

/**
 * Language model interface
 */
export interface LanguageModel {
  /**
   * Generate completion from LLM
   */
  generate(request: GenerateRequest): Promise<GenerateResponse>;

  /**
   * Stream completion from LLM (Phase 2)
   */
  stream?(request: GenerateRequest): AsyncIterableIterator<string>;
}

/**
 * Agent execution result
 */
export interface AgentResult {
  output: string;
  toolCalls: Array<{ name: string; arguments: string; iteration: number }>;
  context: Context;
}

/**
 * Agent configuration options
 */
export interface AgentOptions {
  /** Agent name/identifier */
  name: string;
  /** Language model instance */
  model: LanguageModel;
  /** System instructions for the agent */
  instructions: string;
  /** List of tools available to the agent */
  tools?: (Tool | any)[];
  /** Model name to use (e.g., "gpt-4o-mini") */
  modelName?: string;
  /** LLM temperature (0.0 to 1.0) */
  temperature?: number;
  /** Maximum reasoning iterations */
  maxIterations?: number;
}

/**
 * Autonomous LLM-driven agent with tool orchestration
 *
 * @example
 * ```typescript
 * import { Agent, tool } from '@agnt5/sdk';
 *
 * const searchTool = tool('search_web', {
 *   description: 'Search the web for information',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       query: { type: 'string', description: 'Search query' }
 *     },
 *     required: ['query']
 *   }
 * }, async (ctx, args) => {
 *   const { query } = args;
 *   // Search implementation
 *   return [{ title: 'Result', url: '...' }];
 * });
 *
 * const agent = new Agent({
 *   name: 'researcher',
 *   model: myLanguageModel,
 *   instructions: 'You are a research assistant.',
 *   tools: [searchTool]
 * });
 *
 * const result = await agent.run('What are the latest AI trends?');
 * console.log(result.output);
 * ```
 */
export class Agent {
  readonly name: string;
  readonly model: LanguageModel;
  readonly instructions: string;
  readonly modelName: string;
  readonly temperature: number;
  readonly maxIterations: number;
  private tools: Map<string, Tool> = new Map();

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.instructions = options.instructions;
    this.modelName = options.modelName || 'gpt-4o-mini';
    this.temperature = options.temperature ?? 0.7;
    this.maxIterations = options.maxIterations || 10;

    // Build tool registry
    if (options.tools) {
      for (const tool of options.tools) {
        // Check if it's a Tool instance
        if ('name' in tool && 'getSchema' in tool) {
          this.tools.set(tool.name, tool);
        }
        // Check if it's a decorated function with _tool attached
        else if ('_tool' in tool) {
          const toolInstance = (tool as any)._tool as Tool;
          this.tools.set(toolInstance.name, toolInstance);
        }
      }
    }
  }

  /**
   * Run agent to completion
   *
   * @example
   * ```typescript
   * const result = await agent.run('Analyze recent tech news');
   * console.log(result.output);
   * ```
   */
  async run(userMessage: string, context?: Context): Promise<AgentResult> {
    // Create context if not provided
    const ctx = context || new ContextImpl(
      `agent-${this.name}-${Date.now()}`,
      `run-${Date.now()}`,
      0,
      this.name
    );

    // Initialize conversation
    const messages: Message[] = [Message.user(userMessage)];
    const allToolCalls: Array<{ name: string; arguments: string; iteration: number }> = [];

    // Reasoning loop
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      ctx.logger.info(`Agent iteration ${iteration + 1}/${this.maxIterations}`);

      // Build tool definitions for LLM
      const toolDefs = Array.from(this.tools.values()).map(tool => tool.getSchema());

      // Create LLM request
      const request: GenerateRequest = {
        model: this.modelName,
        systemPrompt: this.instructions,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        config: {
          temperature: this.temperature
        }
      };

      // Call LLM
      const response = await this.model.generate(request);

      // Add assistant response to messages
      messages.push(Message.assistant(response.text));

      // Check if LLM wants to use tools
      if (response.toolCalls && response.toolCalls.length > 0) {
        ctx.logger.info(`Agent calling ${response.toolCalls.length} tool(s)`);

        // Execute tool calls
        const toolResults: Array<{ tool: string; result: string | null; error: string | null }> = [];

        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.name;
          const toolArgsStr = toolCall.arguments;

          // Track tool call
          allToolCalls.push({
            name: toolName,
            arguments: toolArgsStr,
            iteration: iteration + 1
          });

          // Execute tool
          try {
            // Parse arguments
            const toolArgs = JSON.parse(toolArgsStr);

            // Get tool
            const tool = this.tools.get(toolName);
            if (!tool) {
              toolResults.push({
                tool: toolName,
                result: null,
                error: `Tool '${toolName}' not found`
              });
              continue;
            }

            // Execute tool
            const result = await tool.invoke(ctx, toolArgs);
            const resultText = JSON.stringify(result);

            toolResults.push({
              tool: toolName,
              result: resultText,
              error: null
            });
          } catch (error) {
            ctx.logger.error(`Tool execution error: ${error}`);
            toolResults.push({
              tool: toolName,
              result: null,
              error: String(error)
            });
          }
        }

        // Add tool results to conversation
        const resultsText = toolResults
          .map(tr => {
            if (tr.error) {
              return `Tool: ${tr.tool}\nError: ${tr.error}`;
            }
            return `Tool: ${tr.tool}\nResult: ${tr.result}`;
          })
          .join('\n\n');

        messages.push(Message.user(`Tool results:\n${resultsText}`));

        // Continue loop for agent to process results
      } else {
        // No tool calls - agent is done
        ctx.logger.info(`Agent completed after ${iteration + 1} iterations`);
        return {
          output: response.text,
          toolCalls: allToolCalls,
          context: ctx
        };
      }
    }

    // Max iterations reached
    ctx.logger.warn(`Agent reached max iterations (${this.maxIterations})`);
    const finalOutput = messages[messages.length - 1]?.content || 'No output generated';
    return {
      output: finalOutput,
      toolCalls: allToolCalls,
      context: ctx
    };
  }

  /**
   * Continue multi-turn conversation
   *
   * @example
   * ```typescript
   * let messages: Message[] = [];
   * let response: string;
   *
   * [response, messages] = await agent.chat('Hello', messages);
   * [response, messages] = await agent.chat('Tell me more', messages);
   * ```
   */
  async chat(
    userMessage: string,
    messages: Message[],
    context?: Context
  ): Promise<[string, Message[]]> {
    const ctx = context || new ContextImpl(
      `agent-chat-${this.name}-${Date.now()}`,
      `run-${Date.now()}`,
      0,
      this.name
    );

    // Add user message
    const conversation = [...messages, Message.user(userMessage)];

    // Build request (no tools for simple chat)
    const request: GenerateRequest = {
      model: this.modelName,
      systemPrompt: this.instructions,
      messages: conversation,
      config: {
        temperature: this.temperature
      }
    };

    // Call LLM
    const response = await this.model.generate(request);

    // Add assistant response
    conversation.push(Message.assistant(response.text));

    return [response.text, conversation];
  }
}
