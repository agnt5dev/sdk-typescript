/**
 * Agent component for LLM-driven autonomous execution.
 *
 * Production ready with support for the new LM class and durable execution
 */

import type { Context, ToolSchema } from './types.js';
import { Tool } from './tool.js';
import { ContextImpl } from './context.js';
import type { LM } from './lm.js';
import type {
  Message as LMMessage,
  GenerateRequest as LMGenerateRequest,
  GenerateResponse as LMGenerateResponse,
  ToolCall as LMToolCall,
} from './lm.js';
import { randomUUID } from 'crypto';
import type { AgentEvent } from './events.js';
import {
  agentStarted,
  agentCompleted,
  agentFailed,
  iterationStarted,
  iterationCompleted,
  toolCallStarted,
  toolCallCompleted,
  toolCallFailed,
} from './events.js';

/**
 * Message role in conversation (for backwards compatibility)
 * @deprecated Use MessageRole from lm.js instead
 */
export enum MessageRole {
  System = 'system',
  User = 'user',
  Assistant = 'assistant'
}

/**
 * Conversation message (uses LM types internally)
 */
export type Message = LMMessage;

/**
 * Message factory functions
 */
export const Message = {
  system: (content: string): Message => ({ role: 'system', content }),
  user: (content: string): Message => ({ role: 'user', content }),
  assistant: (content: string): Message => ({ role: 'assistant', content })
};

/**
 * Tool call from LLM (uses LM types internally)
 */
export type ToolCall = LMToolCall;

/**
 * Token usage statistics
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Generation configuration (for backwards compatibility)
 * @deprecated Use GenerationConfig from lm.js instead
 */
export interface GenerationConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * LLM generation request (for backwards compatibility)
 * @deprecated Use GenerateRequest from lm.js instead
 */
export interface GenerateRequest {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolSchema[];
  config?: GenerationConfig;
}

/**
 * LLM generation response (for backwards compatibility)
 * @deprecated Use GenerateResponse from lm.js instead
 */
export interface GenerateResponse {
  text: string;
  usage?: TokenUsage;
  finishReason?: string;
  toolCalls?: ToolCall[];
}

/**
 * Language model interface (for backwards compatibility)
 * @deprecated Use LM class from lm.js instead
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
  /** Name of agent control was handed off to (null if no handoff) */
  handoffTo: string | null;
  /** Metadata from the handoff (empty if no handoff) */
  handoffMetadata: Record<string, any>;
}

/**
 * Handoff configuration for agent-to-agent delegation
 */
export class Handoff {
  readonly agent: Agent;
  readonly description: string;
  readonly toolName: string;
  readonly passFullHistory: boolean;

  constructor(
    agent: Agent,
    description?: string,
    toolName?: string,
    passFullHistory: boolean = true,
  ) {
    this.agent = agent;
    this.description = description || agent.instructions || `Transfer to ${agent.name}`;
    this.toolName = toolName || `transfer_to_${agent.name}`;
    this.passFullHistory = passFullHistory;
  }
}

/**
 * Create a handoff configuration for agent delegation
 */
export function handoff(
  agent: Agent,
  description?: string,
  toolName?: string,
  passFullHistory: boolean = true,
): Handoff {
  return new Handoff(agent, description, toolName, passFullHistory);
}

/**
 * Global registry for looking up agents by name.
 *
 * Provides discovery for multi-agent systems where agents need to find each
 * other, and for the worker to enumerate registered agents.
 *
 * @example
 * ```typescript
 * const researcher = new Agent({ name: 'researcher', ... });
 * // Agent is auto-registered in constructor
 *
 * // Look up later
 * const found = AgentRegistry.get('researcher');
 * ```
 */
export class AgentRegistry {
  private static agents = new Map<string, Agent>();

  static register(agent: Agent): void {
    if (this.agents.has(agent.name)) {
      console.warn(`Overwriting existing agent '${agent.name}'`);
    }
    this.agents.set(agent.name, agent);
  }

  static get(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  static all(): Map<string, Agent> {
    return new Map(this.agents);
  }

  static listNames(): string[] {
    return Array.from(this.agents.keys());
  }

  static clear(): void {
    this.agents.clear();
  }
}

/**
 * Agent configuration options
 */
export interface AgentOptions {
  /** Agent name/identifier */
  name: string;
  /** Language model instance (LM class or legacy LanguageModel) */
  model: LM | LanguageModel;
  /** System instructions for the agent */
  instructions: string;
  /** List of tools available to the agent */
  tools?: (Tool | any)[];
  /** Handoff targets for agent-to-agent delegation */
  handoffs?: (Agent | Handoff)[];
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
  readonly model: LM | LanguageModel;
  readonly instructions: string;
  readonly modelName: string;
  readonly temperature: number;
  readonly maxIterations: number;
  private tools: Map<string, Tool> = new Map();
  private handoffs: Handoff[] = [];
  private isNewLM: boolean;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.instructions = options.instructions;
    this.modelName = options.modelName || 'openai/gpt-4o-mini';
    this.temperature = options.temperature ?? 0.7;
    this.maxIterations = options.maxIterations || 10;

    // Detect if it's the new LM class (has static factory methods)
    this.isNewLM = 'generate' in options.model && !('stream' in (options.model as any).constructor);

    // Build tool registry
    if (options.tools) {
      for (const t of options.tools) {
        this.addTool(t);
      }
    }

    // Register handoff targets
    if (options.handoffs) {
      for (const item of options.handoffs) {
        const h = item instanceof Handoff ? item : new Handoff(item);
        this.handoffs.push(h);
        // Create and register the transfer tool
        const transferTool = this.createHandoffTool(h);
        this.tools.set(transferTool.name, transferTool);
      }
    }

    // Auto-register in global registry
    AgentRegistry.register(this);
  }

  /**
   * Add a tool to this agent's tool set
   */
  private addTool(t: Tool | any): void {
    if (t instanceof Tool) {
      this.tools.set(t.name, t);
    } else if ('name' in t && 'getSchema' in t) {
      this.tools.set(t.name, t);
    } else if ('_tool' in t) {
      const toolInstance = (t as any)._tool as Tool;
      this.tools.set(toolInstance.name, toolInstance);
    }
  }

  /**
   * Create an auto-generated transfer tool for a handoff target
   */
  private createHandoffTool(h: Handoff): Tool {
    const targetAgent = h.agent;
    const passHistory = h.passFullHistory;

    return new Tool(
      h.toolName,
      h.description,
      async (ctx: Context, args: Record<string, any>) => {
        const message = args.message || args.prompt || '';

        // Run target agent to completion
        const result = await targetAgent.run(
          message,
          ctx,
          passHistory ? (ctx as any)._agentConversation : undefined,
        );

        // Return with handoff marker
        return {
          _handoff: true,
          to_agent: targetAgent.name,
          output: result.output,
          tool_calls: result.toolCalls,
        };
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to send to the target agent' },
          },
          required: ['message'],
        },
      },
    );
  }

  /**
   * Convert ToolSchema to LM ToolDefinition
   */
  private convertToolSchema(schema: ToolSchema): any {
    return {
      name: schema.name,
      description: schema.description,
      parameters: JSON.stringify(schema.input_schema),
      strict: false,
    };
  }

  /**
   * Generate using the model (handles both old and new LM types)
   */
  private async generateWithModel(messages: Message[], toolDefs: ToolSchema[]): Promise<GenerateResponse> {
    if (this.isNewLM) {
      // New LM class - use new types
      const lm = this.model as LM;
      const request: LMGenerateRequest = {
        model: this.modelName,
        systemPrompt: this.instructions,
        messages: messages as LMMessage[],
        tools: toolDefs.length > 0 ? toolDefs.map(t => this.convertToolSchema(t)) : undefined,
        config: {
          temperature: this.temperature,
        },
      };

      const response = await lm.generate(request);

      // Convert response to old format
      return {
        text: response.text,
        usage: response.usage ? {
          promptTokens: response.usage.promptTokens || 0,
          completionTokens: response.usage.completionTokens || 0,
          totalTokens: response.usage.totalTokens || 0,
        } : undefined,
        finishReason: response.finishReason,
        toolCalls: response.toolCalls,
      };
    } else {
      // Legacy LanguageModel - use old types
      const legacyModel = this.model as LanguageModel;
      const request: GenerateRequest = {
        model: this.modelName,
        systemPrompt: this.instructions,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        config: {
          temperature: this.temperature,
        },
      };

      return await legacyModel.generate(request);
    }
  }

  /**
   * Stream agent execution, yielding events at each stage.
   *
   * @example
   * ```typescript
   * for await (const event of agent.stream('Analyze tech news')) {
   *   if (event.eventType === 'agent.completed') {
   *     console.log('Done:', event.outputLength);
   *   }
   * }
   * ```
   */
  async *stream(
    userMessage: string,
    context?: Context,
    history?: Message[],
  ): AsyncGenerator<AgentEvent | AgentResult, void, undefined> {
    const agentCorrelationId = randomUUID();

    // Create context if not provided
    const ctx = context || new ContextImpl(
      `agent-${this.name}-${Date.now()}`,
      `run-${Date.now()}`,
      0,
      this.name,
    );

    // Stash conversation on context for handoff history passing
    const messages: Message[] = history ? [...history] : [];
    messages.push(Message.user(userMessage));
    (ctx as any)._agentConversation = messages;

    const toolNames = Array.from(this.tools.keys());
    const allToolCalls: Array<{ name: string; arguments: string; iteration: number }> = [];

    // ── AgentStarted ──
    yield agentStarted(this.name, agentCorrelationId, {
      agentModel: this.modelName,
      toolNames,
      maxIterations: this.maxIterations,
    });

    let completedIterations = 0;

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        const iterCorrelationId = randomUUID();

        // ── IterationStarted ──
        yield iterationStarted(iterCorrelationId, agentCorrelationId, {
          iteration: iteration + 1,
          maxIterations: this.maxIterations,
        });

        // Build tool definitions and call LLM
        const toolDefs = Array.from(this.tools.values()).map(t => t.getSchema());
        const response = await this.generateWithModel(messages, toolDefs);

        messages.push(Message.assistant(response.text));

        if (response.toolCalls && response.toolCalls.length > 0) {
          // Execute tool calls
          const toolResults: Array<{ tool: string; result: string | null; error: string | null }> = [];

          for (const tc of response.toolCalls) {
            const tcId = randomUUID();
            const toolName = tc.name;
            const toolArgsStr = tc.arguments;

            allToolCalls.push({ name: toolName, arguments: toolArgsStr, iteration: iteration + 1 });

            // ── ToolCallStarted ──
            yield toolCallStarted(tcId, iterCorrelationId, { toolName, toolCallId: tcId });

            try {
              const toolArgs = JSON.parse(toolArgsStr);
              const tool = this.tools.get(toolName);
              if (!tool) {
                yield toolCallFailed(tcId, iterCorrelationId, {
                  toolName,
                  toolCallId: tcId,
                  error: `Tool '${toolName}' not found`,
                });
                toolResults.push({ tool: toolName, result: null, error: `Tool '${toolName}' not found` });
                continue;
              }

              const result = await tool.invoke(ctx, toolArgs);

              // ── Handoff detection ──
              if (result && typeof result === 'object' && (result as any)._handoff) {
                yield toolCallCompleted(tcId, iterCorrelationId, { toolName, toolCallId: tcId });

                completedIterations = iteration + 1;
                const handoffResult: AgentResult = {
                  output: (result as any).output,
                  toolCalls: [...allToolCalls, ...((result as any).tool_calls || [])],
                  context: ctx,
                  handoffTo: (result as any).to_agent,
                  handoffMetadata: result as Record<string, any>,
                };

                // ── AgentCompleted (with handoff) ──
                yield agentCompleted(this.name, agentCorrelationId, {
                  iterations: completedIterations,
                  toolCallsCount: allToolCalls.length,
                  handoffTo: (result as any).to_agent,
                  outputLength: handoffResult.output.length,
                });

                yield handoffResult;
                return;
              }

              const resultText = JSON.stringify(result);
              yield toolCallCompleted(tcId, iterCorrelationId, { toolName, toolCallId: tcId });
              toolResults.push({ tool: toolName, result: resultText, error: null });
            } catch (error) {
              yield toolCallFailed(tcId, iterCorrelationId, {
                toolName,
                toolCallId: tcId,
                error: String(error),
              });
              toolResults.push({ tool: toolName, result: null, error: String(error) });
            }
          }

          // Add tool results to conversation
          const resultsText = toolResults
            .map(tr => tr.error ? `Tool: ${tr.tool}\nError: ${tr.error}` : `Tool: ${tr.tool}\nResult: ${tr.result}`)
            .join('\n\n');
          messages.push(Message.user(`Tool results:\n${resultsText}`));

          // ── IterationCompleted (with tools) ──
          yield iterationCompleted(iterCorrelationId, agentCorrelationId, {
            iteration: iteration + 1,
            hasToolCalls: true,
            toolCallsCount: response.toolCalls.length,
          });

          completedIterations = iteration + 1;
        } else {
          // No tool calls — agent is done
          completedIterations = iteration + 1;

          // ── IterationCompleted (final) ──
          yield iterationCompleted(iterCorrelationId, agentCorrelationId, {
            iteration: iteration + 1,
            hasToolCalls: false,
            toolCallsCount: 0,
          });

          // ── AgentCompleted ──
          yield agentCompleted(this.name, agentCorrelationId, {
            iterations: completedIterations,
            toolCallsCount: allToolCalls.length,
            handoffTo: null,
            outputLength: response.text.length,
          });

          yield {
            output: response.text,
            toolCalls: allToolCalls,
            context: ctx,
            handoffTo: null,
            handoffMetadata: {},
          } satisfies AgentResult;
          return;
        }
      }

      // Max iterations reached
      completedIterations = this.maxIterations;
      const finalOutput = messages[messages.length - 1]?.content || 'No output generated';

      yield agentCompleted(this.name, agentCorrelationId, {
        iterations: completedIterations,
        toolCallsCount: allToolCalls.length,
        handoffTo: null,
        outputLength: finalOutput.length,
      });

      yield {
        output: finalOutput,
        toolCalls: allToolCalls,
        context: ctx,
        handoffTo: null,
        handoffMetadata: {},
      } satisfies AgentResult;
    } catch (error) {
      yield agentFailed(this.name, agentCorrelationId, {
        iterations: completedIterations,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Run agent to completion (non-streaming).
   * Consumes stream() internally and returns the final AgentResult.
   *
   * @example
   * ```typescript
   * const result = await agent.run('Analyze recent tech news');
   * console.log(result.output);
   * ```
   */
  async run(
    userMessage: string,
    context?: Context,
    history?: Message[],
  ): Promise<AgentResult> {
    let result: AgentResult | undefined;

    for await (const event of this.stream(userMessage, context, history)) {
      // The last yielded value that has 'output' is the AgentResult
      if ('output' in event && 'toolCalls' in event && 'context' in event) {
        result = event as AgentResult;
      }
    }

    if (!result) {
      throw new Error(`Agent '${this.name}' completed without producing a result`);
    }

    return result;
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

    // Call LLM (no tools for simple chat, using helper)
    const response = await this.generateWithModel(conversation, []);

    // Add assistant response
    conversation.push(Message.assistant(response.text));

    return [response.text, conversation];
  }
}
