/**
 * Agent component for LLM-driven autonomous execution.
 *
 * Production ready with support for the new LM class and durable execution
 */

import type { Context, ToolSchema } from './types.js';
import { Tool } from './tool.js';
import { ContextImpl } from './context.js';
import { validateModelForProvider } from './lm.js';
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
  lmStarted,
  lmCompleted,
  lmFailed,
  generateCid,
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

export type MaybePromise<T> = T | Promise<T>;

export interface CallbackOverride<T = any> {
  readonly __agnt5CallbackOverride: true;
  readonly value: T;
}

export function callbackOverride<T>(value: T): CallbackOverride<T> {
  return { __agnt5CallbackOverride: true, value };
}

export interface AgentCallbackContext {
  agent: Agent;
  context: Context;
  userMessage: string;
  history?: Message[];
}

export interface ModelCallbackContext {
  agent: Agent;
  context: Context;
  iteration: number;
  messages: Message[];
  toolDefs: ToolSchema[];
}

export interface ToolCallbackContext {
  agent: Agent;
  context: Context;
  iteration: number;
  toolName: string;
  toolCallId: string;
  toolCall: ToolCall;
  args: Record<string, any>;
  tool?: Tool;
}

export interface AgentCallbacks {
  beforeAgent?: (
    ctx: AgentCallbackContext,
  ) => MaybePromise<AgentResult | string | Record<string, any> | CallbackOverride | void>;
  afterAgent?: (
    ctx: AgentCallbackContext,
    result: AgentResult,
  ) => MaybePromise<AgentResult | string | Record<string, any> | CallbackOverride | void>;
  beforeModel?: (
    ctx: ModelCallbackContext,
    request: GenerateRequest | LMGenerateRequest,
  ) => MaybePromise<GenerateResponse | LMGenerateResponse | CallbackOverride | void>;
  afterModel?: (
    ctx: ModelCallbackContext,
    request: GenerateRequest | LMGenerateRequest,
    response: GenerateResponse,
  ) => MaybePromise<GenerateResponse | LMGenerateResponse | CallbackOverride | void>;
  beforeTool?: (
    ctx: ToolCallbackContext,
    call: ToolCall,
  ) => MaybePromise<any | CallbackOverride | void>;
  afterTool?: (
    ctx: ToolCallbackContext,
    call: ToolCall,
    result: any,
  ) => MaybePromise<any | CallbackOverride | void>;
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
  /** Execution callbacks for agent/model/tool interception */
  callbacks?: AgentCallbacks;
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
  private callbacks: AgentCallbacks;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.instructions = options.instructions;
    const requestedModelName = options.modelName || 'openai/gpt-4o-mini';
    const providerName = (options.model as any).providerName;
    this.modelName = requestedModelName.includes('/') || providerName
      ? validateModelForProvider(requestedModelName, providerName)
      : requestedModelName;
    this.temperature = options.temperature ?? 0.7;
    this.maxIterations = options.maxIterations || 10;
    this.callbacks = options.callbacks || {};

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
    } else if (t instanceof Agent) {
      // Agent-as-tool: wrap the agent in a Tool that invokes its run() method
      // so a coordinator can delegate to specialist agents by name. Mirrors
      // sdk-python's pattern of passing Agent instances directly in tools.
      const subAgent = t;
      const wrapped = new Tool(
        subAgent.name,
        `Delegate a task to the ${subAgent.name} agent. Pass the task as the 'message' argument.`,
        async (ctx: Context, args: Record<string, any>) => {
          const message = args.message || args.prompt || JSON.stringify(args);
          const result = await subAgent.run(message, ctx);
          return result.output;
        },
        {
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The task or question to delegate to this agent',
              },
            },
            required: ['message'],
          },
        },
      );
      this.tools.set(subAgent.name, wrapped);
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

  private isCallbackOverride(value: any): value is CallbackOverride {
    return Boolean(value && typeof value === 'object' && value.__agnt5CallbackOverride === true);
  }

  private callbackValue(value: any): { hasValue: boolean; value: any } {
    if (this.isCallbackOverride(value)) {
      return { hasValue: true, value: value.value };
    }
    if (value === undefined) {
      return { hasValue: false, value: undefined };
    }
    return { hasValue: true, value };
  }

  private agentResultFromCallback(value: any, ctx: Context): AgentResult {
    if (value && typeof value === 'object' && 'output' in value && 'toolCalls' in value && 'context' in value) {
      return value as AgentResult;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const outputValue = 'output' in value ? value.output : value;
      return {
        output: typeof outputValue === 'string' ? outputValue : JSON.stringify(outputValue),
        toolCalls: value.toolCalls || value.tool_calls || [],
        context: ctx,
        handoffTo: value.handoffTo || value.handoff_to || null,
        handoffMetadata: value.handoffTo || value.handoff_to ? value : {},
      };
    }

    return {
      output: typeof value === 'string' ? value : JSON.stringify(value),
      toolCalls: [],
      context: ctx,
      handoffTo: null,
      handoffMetadata: {},
    };
  }

  private normalizeGenerateResponse(response: GenerateResponse | LMGenerateResponse | any): GenerateResponse {
    if (!response || typeof response !== 'object') {
      throw new TypeError('model callbacks must return a generate response object');
    }

    return {
      text: response.text ?? '',
      usage: response.usage ? {
        promptTokens: response.usage.promptTokens ?? response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completionTokens ?? response.usage.completion_tokens ?? 0,
        totalTokens: response.usage.totalTokens ?? response.usage.total_tokens ?? 0,
      } : undefined,
      finishReason: response.finishReason ?? response.finish_reason,
      toolCalls: response.toolCalls ?? response.tool_calls,
    };
  }

  private buildModelRequest(messages: Message[], toolDefs: ToolSchema[]): GenerateRequest | LMGenerateRequest {
    if (this.isNewLM) {
      return {
        model: this.modelName,
        systemPrompt: this.instructions,
        messages: messages as LMMessage[],
        tools: toolDefs.length > 0 ? toolDefs.map(t => this.convertToolSchema(t)) : undefined,
        config: {
          temperature: this.temperature,
        },
      } satisfies LMGenerateRequest;
    }

    return {
      model: this.modelName,
      systemPrompt: this.instructions,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      config: {
        temperature: this.temperature,
      },
    } satisfies GenerateRequest;
  }

  private async dispatchModelRequest(request: GenerateRequest | LMGenerateRequest): Promise<GenerateResponse> {
    if (this.isNewLM) {
      const lm = this.model as LM;
      return this.normalizeGenerateResponse(await lm.generate(request as LMGenerateRequest));
    }

    const legacyModel = this.model as LanguageModel;
    return this.normalizeGenerateResponse(await legacyModel.generate(request as GenerateRequest));
  }

  /**
   * Generate using the model (handles both old and new LM types).
   *
   * Emits `lm.started` and `lm.completed`/`lm.failed` around the model
   * call, parented under the agent iteration (matches sdk-python's
   * lm/client.py emission so the platform journal records model name,
   * provider, and token counts).
   */
  private async generateWithModel(
    messages: Message[],
    toolDefs: ToolSchema[],
    callbackContext?: { context: Context; iteration: number; parentCorrelationId?: string },
  ): Promise<GenerateResponse> {
    const request = this.buildModelRequest(messages, toolDefs);

    if (!callbackContext) {
      return this.dispatchModelRequest(request);
    }

    const modelCtx: ModelCallbackContext = {
      agent: this,
      context: callbackContext.context,
      iteration: callbackContext.iteration,
      messages,
      toolDefs,
    };

    // LM event metadata. Model name format is `provider/model` (e.g.
    // `openai/gpt-5-mini`); split for the metadata fields. parentCid points
    // at the iteration cid passed in from stream() — Python parents lm.* on
    // iteration.
    const slashIdx = this.modelName.indexOf('/');
    const provider = slashIdx > 0 ? this.modelName.slice(0, slashIdx) : '';
    const model = this.modelName;
    const parentCid =
      callbackContext.parentCorrelationId ??
      (callbackContext.context as any).getCurrentCorrelationId?.();

    const lmCid = generateCid();
    const startMs = Date.now();
    const reqAny = request as any;
    const ctx = callbackContext.context;

    if (parentCid) {
      try {
        await ctx.emit(
          lmStarted(lmCid, parentCid, {
            model,
            provider,
            messages: reqAny.messages ?? [],
            systemPrompt: reqAny.systemPrompt ?? reqAny.system_prompt,
            toolsCount: toolDefs.length,
            temperature: reqAny.config?.temperature,
            maxTokens: reqAny.config?.maxTokens ?? reqAny.config?.max_tokens ?? null,
          }),
        );
      } catch {
        // Best-effort: emission failure must not block the model call.
      }
    }

    let response: GenerateResponse | undefined;
    try {
      if (this.callbacks.beforeModel) {
        const raw = await this.callbacks.beforeModel(modelCtx, request);
        const resolved = this.callbackValue(raw);
        if (resolved.hasValue) {
          response = this.normalizeGenerateResponse(resolved.value);
        }
      }

      if (!response) {
        response = await this.dispatchModelRequest(request);
      }

      if (this.callbacks.afterModel) {
        const raw = await this.callbacks.afterModel(modelCtx, request, response);
        const resolved = this.callbackValue(raw);
        if (resolved.hasValue) {
          response = this.normalizeGenerateResponse(resolved.value);
        }
      }
    } catch (err) {
      if (parentCid) {
        try {
          await ctx.emit(
            lmFailed(lmCid, parentCid, {
              model,
              provider,
              errorCode: 'LM_ERROR',
              errorMessage: (err as Error).message ?? String(err),
              durationMs: Date.now() - startMs,
            }),
          );
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }

    if (parentCid) {
      const durationMs = Date.now() - startMs;
      const usage = response.usage;
      try {
        await ctx.emit(
          lmCompleted(lmCid, parentCid, {
            model,
            provider,
            output: response.text ?? '',
            toolCalls: response.toolCalls ?? null,
            inputTokens: usage?.promptTokens ?? 0,
            outputTokens: usage?.completionTokens ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
            durationMs,
          }),
        );
      } catch {
        /* best-effort */
      }
    }

    return response;
  }

  private async runBeforeAgentCallback(
    ctx: Context,
    userMessage: string,
    history?: Message[],
  ): Promise<AgentResult | undefined> {
    if (!this.callbacks.beforeAgent) return undefined;

    const raw = await this.callbacks.beforeAgent({
      agent: this,
      context: ctx,
      userMessage,
      history,
    });
    const resolved = this.callbackValue(raw);
    return resolved.hasValue ? this.agentResultFromCallback(resolved.value, ctx) : undefined;
  }

  private async runAfterAgentCallback(
    ctx: Context,
    userMessage: string,
    history: Message[] | undefined,
    result: AgentResult,
  ): Promise<AgentResult> {
    if (!this.callbacks.afterAgent) return result;

    const raw = await this.callbacks.afterAgent({
      agent: this,
      context: ctx,
      userMessage,
      history,
    }, result);
    const resolved = this.callbackValue(raw);
    return resolved.hasValue ? this.agentResultFromCallback(resolved.value, ctx) : result;
  }

  private async invokeToolWithCallbacks(
    toolCtx: ToolCallbackContext,
  ): Promise<any> {
    if (this.callbacks.beforeTool) {
      const raw = await this.callbacks.beforeTool(toolCtx, toolCtx.toolCall);
      const resolved = this.callbackValue(raw);
      if (resolved.hasValue) {
        return resolved.value;
      }
    }

    if (!toolCtx.tool) {
      throw new Error(`Tool '${toolCtx.toolName}' not found`);
    }

    let result = await toolCtx.tool.invoke(toolCtx.context, toolCtx.args);

    if (this.callbacks.afterTool) {
      const raw = await this.callbacks.afterTool(toolCtx, toolCtx.toolCall, result);
      const resolved = this.callbackValue(raw);
      if (resolved.hasValue) {
        result = resolved.value;
      }
    }

    return result;
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
      const beforeAgentResult = await this.runBeforeAgentCallback(ctx, userMessage, history);
      if (beforeAgentResult) {
        yield agentCompleted(this.name, agentCorrelationId, {
          iterations: 0,
          toolCallsCount: beforeAgentResult.toolCalls.length,
          handoffTo: beforeAgentResult.handoffTo,
          outputLength: beforeAgentResult.output.length,
        });
        yield beforeAgentResult;
        return;
      }

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        const iterCorrelationId = randomUUID();

        // ── IterationStarted ──
        yield iterationStarted(iterCorrelationId, agentCorrelationId, {
          iteration: iteration + 1,
          maxIterations: this.maxIterations,
        });

        // Build tool definitions and call LLM
        const toolDefs = Array.from(this.tools.values()).map(t => t.getSchema());
        const response = await this.generateWithModel(messages, toolDefs, {
          context: ctx,
          iteration: iteration + 1,
          parentCorrelationId: iterCorrelationId,
        });

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

              const result = await this.invokeToolWithCallbacks({
                agent: this,
                context: ctx,
                iteration: iteration + 1,
                toolName,
                toolCallId: tc.id || tcId,
                toolCall: { ...tc, id: tc.id || tcId },
                args: toolArgs,
                tool,
              });

              // ── Handoff detection ──
              if (result && typeof result === 'object' && (result as any)._handoff) {
                yield toolCallCompleted(tcId, iterCorrelationId, { toolName, toolCallId: tcId });

                completedIterations = iteration + 1;
                let handoffResult: AgentResult = {
                  output: (result as any).output,
                  toolCalls: [...allToolCalls, ...((result as any).tool_calls || [])],
                  context: ctx,
                  handoffTo: (result as any).to_agent,
                  handoffMetadata: result as Record<string, any>,
                };
                handoffResult = await this.runAfterAgentCallback(ctx, userMessage, history, handoffResult);

                // ── AgentCompleted (with handoff) ──
                yield agentCompleted(this.name, agentCorrelationId, {
                  iterations: completedIterations,
                  toolCallsCount: allToolCalls.length,
                  handoffTo: handoffResult.handoffTo,
                  outputLength: handoffResult.output.length,
                });

                yield handoffResult;
                return;
              }

              const resultText = JSON.stringify(result);
              yield toolCallCompleted(tcId, iterCorrelationId, { toolName, toolCallId: tcId });
              toolResults.push({ tool: toolName, result: resultText, error: null });
            } catch (error) {
              // HITL: WaitingForUserInputError must propagate to pause the
              // workflow — do NOT treat it as a tool failure or the LLM will
              // retry the tool in the next iteration.
              if ((error as any)?.name === 'WaitingForUserInputError') {
                throw error;
              }
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

          let agentResult: AgentResult = {
            output: response.text,
            toolCalls: allToolCalls,
            context: ctx,
            handoffTo: null,
            handoffMetadata: {},
          };
          agentResult = await this.runAfterAgentCallback(ctx, userMessage, history, agentResult);
          // ── AgentCompleted ──
          yield agentCompleted(this.name, agentCorrelationId, {
            iterations: completedIterations,
            toolCallsCount: agentResult.toolCalls.length,
            handoffTo: agentResult.handoffTo,
            outputLength: agentResult.output.length,
          });
          yield agentResult;
          return;
        }
      }

      // Max iterations reached
      completedIterations = this.maxIterations;
      const finalOutput = messages[messages.length - 1]?.content || 'No output generated';

      let agentResult: AgentResult = {
        output: finalOutput,
        toolCalls: allToolCalls,
        context: ctx,
        handoffTo: null,
        handoffMetadata: {},
      };
      agentResult = await this.runAfterAgentCallback(ctx, userMessage, history, agentResult);

      yield agentCompleted(this.name, agentCorrelationId, {
        iterations: completedIterations,
        toolCallsCount: agentResult.toolCalls.length,
        handoffTo: agentResult.handoffTo,
        outputLength: agentResult.output.length,
      });

      yield agentResult;
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
        continue;
      }
      // Forward lifecycle events (agent.started/completed/failed, iteration.*,
      // tool_call.started/completed/failed, output.*) to the platform via the
      // provided context emitter. Without this, agent.run() called from inside
      // a function or workflow handler silently swallows every tool-level
      // event and downstream projections/tests can't see them.
      if (context) {
        try {
          await context.emit(event as any);
        } catch {
          // Best effort — emission failures should not break the agent
        }
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
