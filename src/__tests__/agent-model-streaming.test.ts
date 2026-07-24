import { describe, expect, it } from 'vitest';

import {
  Agent,
  type GenerateRequest,
  type GenerateResponse,
  type LanguageModel,
  type LanguageModelStreamChunk,
} from '../agent.js';
import type { AgentEvent } from '../events.js';
import { tool } from '../tool.js';

class ScriptedStreamingModel implements LanguageModel {
  readonly supportsStreamingTools = true;
  private call = 0;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    throw new Error(`streaming model fell back to generate: ${JSON.stringify(request)}`);
  }

  async *stream(
    _request: GenerateRequest,
  ): AsyncIterableIterator<LanguageModelStreamChunk> {
    if (this.call === 0) {
      this.call += 1;
      yield {
        type: 'tool_call_start',
        id: 'call-lookup',
        name: 'stream_lookup',
        index: 0,
      };
      yield {
        type: 'tool_call_delta',
        inputDelta: '{"key":',
        index: 0,
      };
      yield {
        type: 'tool_call_delta',
        inputDelta: '"user_123"}',
        index: 0,
      };
      yield {
        type: 'tool_call_stop',
        id: 'call-lookup',
        name: 'stream_lookup',
        input: { key: 'user_123' },
        index: 0,
      };
      yield {
        type: 'completed',
        response: {
          text: '',
          toolCalls: [{
            id: 'call-lookup',
            name: 'stream_lookup',
            arguments: '{"key":"user_123"}',
          }],
        },
      };
      return;
    }

    yield { type: 'message_start', index: 0 };
    yield { type: 'message_delta', content: 'Alice', index: 0 };
    yield { type: 'message_delta', content: ' is', index: 0 };
    yield { type: 'message_delta', content: ' admin', index: 0 };
    yield { type: 'message_stop', index: 0 };
    yield {
      type: 'completed',
      response: { text: 'Alice is admin' },
    };
  }
}

describe('streaming model agents', () => {
  it('streams tool arguments, executes the tool, then streams final text', async () => {
    const lookup = tool(
      'stream_lookup',
      {
        description: 'Lookup a user',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
      async (_ctx, args: { key: string }) => ({
        key: args.key,
        name: 'Alice',
        role: 'admin',
      }),
    );
    const agent = new Agent({
      name: 'streaming-agent',
      model: new ScriptedStreamingModel(),
      instructions: 'Use the lookup tool.',
      tools: [lookup],
      maxIterations: 3,
    });

    const events: AgentEvent[] = [];
    let finalOutput = '';
    for await (const event of agent.stream('lookup user_123')) {
      if ('eventType' in event) {
        events.push(event);
      } else {
        finalOutput = event.output;
      }
    }

    const eventTypes = events.map(event => event.eventType);
    const expected = [
      'lm.tool_call.start',
      'lm.tool_call.delta',
      'lm.tool_call.delta',
      'lm.tool_call.stop',
      'tool_call.started',
      'tool_call.completed',
      'lm.message.start',
      'lm.message.delta',
      'lm.message.delta',
      'lm.message.delta',
      'lm.message.stop',
    ];
    let position = 0;
    for (const eventType of eventTypes) {
      if (eventType === expected[position]) position += 1;
    }

    expect(position).toBe(expected.length);
    expect(finalOutput).toBe('Alice is admin');
  });
});
