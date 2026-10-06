/** Publishing MCPServer definitions with the deployment (AGNT5-1569). */

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, AgentRegistry } from '../agent.js';
import type { GenerateRequest, GenerateResponse, LanguageModel } from '../agent.js';
import { fn, FunctionRegistry } from '../function.js';
import { MCPServer } from '../mcp-server.js';
import {
  MCP_MAX_VIEW_BYTES,
  MCP_MAX_VIEWS_BYTES,
  MCP_RUN_VIEW,
  MCPServerRegistry,
} from '../mcp-publish.js';
import { toJsonSchemaDocument } from '../schema-utils.js';
import { ToolRegistry } from '../tool.js';
import { Worker } from '../worker.js';
import { workflow, WorkflowRegistry } from '../workflow.js';

vi.mock('#native-loader', () => {
  class MockNativeWorker {
    workerId = 'worker-123';
    coordinatorEndpoint = 'http://localhost:34186';
    tenantId = 'project-123';
    deploymentId = 'deployment-123';
    async setComponents(components: unknown[]): Promise<void> {
      (globalThis as any).__agnt5RegisteredComponents = components;
    }
    setMessageHandler(_handler: unknown): void {}
    setCancelHandler(_handler: unknown): void {}
    async run(): Promise<void> {}
  }
  const native = {
    initialize: () => {},
    Worker: MockNativeWorker,
    checkPlatformConnectivity: async () => true,
  };
  return {
    getLoadedNativeBindings: () => null,
    loadNativeBindings: () => native,
    tryLoadNativeBindings: () => native,
  };
});

// zod is a transitive dev dependency here; the Zod test is skipped without it.
const zod = await import('zod').catch(() => null);

class MockLanguageModel implements LanguageModel {
  async generate(_request: GenerateRequest): Promise<GenerateResponse> {
    return { text: 'ok', finishReason: 'stop' };
  }
}

const BOARD = '<!doctype html><title>Order</title><p>An order board ✓</p>';

const orderSchema = {
  type: 'object' as const,
  properties: { order_id: { type: 'string' as const } },
  required: ['order_id'],
};

function defineComponents() {
  const lookupOrder = fn('mcp_test_lookup_order')
    .description('Look up an order by ID.\n\nLonger text that is not part of the tool description.')
    .inputSchema(orderSchema)
    .outputSchema({ type: 'object', properties: { order_id: { type: 'string' }, total: { type: 'number' } } })
    .run(async (_ctx, input: { order_id: string }) => ({ order_id: input.order_id, total: 1 }));

  const triage = workflow('mcp_test_triage', async () => 'ok', {
    description: 'Classify new tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        max_tickets: { type: 'integer', default: 25 },
      },
      required: ['account'],
    },
    outputSchema: { type: 'string' },
  });

  const agent = new Agent({
    name: 'mcp_test_agent',
    model: new MockLanguageModel(),
    instructions: 'Answer support questions.\nMore.',
  });
  return { lookupOrder, triage, agent };
}

function supportServer(): MCPServer {
  const { lookupOrder, triage, agent } = defineComponents();
  const server = new MCPServer('support', { instructions: 'Order and ticket tools.' });
  server.addFunction('lookup_order', lookupOrder, { annotations: { readOnlyHint: true } });
  server.addWorkflow('triage_ticket', triage, { mode: 'background', annotations: { destructiveHint: true } });
  server.addAgent('support_agent', agent);
  return server;
}

beforeEach(() => {
  MCPServerRegistry.clear();
  FunctionRegistry.clear();
  WorkflowRegistry.clear();
  ToolRegistry.clear();
  AgentRegistry.clear();
  (globalThis as any).__agnt5RegisteredComponents = [];
});

afterEach(() => {
  MCPServerRegistry.clear();
  delete (globalThis as any).__agnt5RegisteredComponents;
  vi.restoreAllMocks();
});

describe('MCPServer publishing', () => {
  it('takes a short constructor and keeps the options-object form', () => {
    const short = new MCPServer('support', { title: 'Acme Support', instructions: 'Tools.' });
    expect([short.id, short.name, short.version, short.title]).toEqual([
      'support',
      'support',
      '0.1.0',
      'Acme Support',
    ]);
    const old = new MCPServer({ id: 'legacy-id', name: 'Legacy Server', version: '2.0.0' });
    expect([old.id, old.name, old.version]).toEqual(['legacy-id', 'Legacy Server', '2.0.0']);
  });

  it('builds a definition that follows the platform contract', () => {
    const definition = supportServer().definition();
    expect(definition.schema_version).toBe(1);
    expect(definition.name).toBe('support');
    expect(definition.instructions).toBe('Order and ticket tools.');
    expect(definition).not.toHaveProperty('title');

    const [lookup, triage, agentTool] = definition.tools;
    expect(lookup.component).toEqual({ type: 'function', name: 'mcp_test_lookup_order' });
    expect(lookup.description).toBe('Look up an order by ID.');
    expect(lookup.annotations).toEqual({ readOnlyHint: true });
    expect(lookup.input_schema).toEqual(orderSchema);
    expect(lookup.output_schema?.type).toBe('object');
    expect(lookup).not.toHaveProperty('mode'); // the platform fills in the default mode

    expect(triage.component).toEqual({ type: 'workflow', name: 'mcp_test_triage' });
    expect(triage.mode).toBe('background');
    // Hints are explicit: an unstated readOnlyHint means the tool writes.
    expect(triage.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(triage).not.toHaveProperty('output_schema'); // a string result is not an object schema
    expect(triage.input_schema.properties?.max_tickets.default).toBe(25);
    expect(triage.description).toBe('Classify new tickets.');

    expect(agentTool.component).toEqual({ type: 'agent', name: 'mcp_test_agent' });
    expect(agentTool.input_schema.required).toEqual(['input']);
    expect(agentTool.description).toBe('Answer support questions.');
    expect(agentTool.annotations).toEqual({ readOnlyHint: false });

    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
  });

  it('publishes title, description, visibility and annotation title as given', () => {
    const { lookupOrder } = defineComponents();
    const server = new MCPServer('support', { title: 'Acme Support' });
    server.addFunction('lookup_order', lookupOrder, {
      title: 'Look up an order',
      description: 'Find an order.',
      mode: 'sync',
      visibility: ['app'],
      annotations: { title: 'Lookup', idempotentHint: true, openWorldHint: false },
    });
    const definition = server.definition();
    expect(definition.title).toBe('Acme Support');
    expect(definition.tools[0]).toMatchObject({
      title: 'Look up an order',
      description: 'Find an order.',
      mode: 'sync',
      visibility: ['app'],
      annotations: { readOnlyHint: false, title: 'Lookup', idempotentHint: true, openWorldHint: false },
    });
  });

  it('keeps full JSON Schemas: $defs, $ref, anyOf, additionalProperties and defaults', () => {
    const inputSchema = {
      type: 'object' as const,
      $defs: { Item: { type: 'object', properties: { sku: { type: 'string' } }, additionalProperties: false } },
      properties: {
        items: { type: 'array' as const, items: { $ref: '#/$defs/Item' } },
        note: { anyOf: [{ type: 'string' as const }, { type: 'null' as const }], default: null },
        tags: { type: 'object' as const, additionalProperties: { type: 'string' } },
      },
      required: ['items'],
      additionalProperties: false,
    };
    const place = fn('mcp_test_place').inputSchema(inputSchema).run(async () => ({}));
    const server = new MCPServer('orders');
    server.addFunction('place_order', place);
    expect(server.definition().tools[0].input_schema).toEqual(inputSchema);
  });

  it('defaults to an empty object schema and drops a non-2020-12 $schema', () => {
    const noSchema = fn('mcp_test_no_schema').run(async () => 'ok');
    const draft7 = fn('mcp_test_draft7')
      .inputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} })
      .run(async () => 'ok');
    const server = new MCPServer('orders');
    server.addFunction('no_schema', noSchema);
    server.addFunction('draft7', draft7);
    const [a, b] = server.definition().tools;
    expect(a.input_schema).toEqual({ type: 'object', properties: {} });
    expect(b.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it.skipIf(!zod)('converts Zod 4 schemas to JSON Schema 2020-12 with defaults', () => {
    const { z } = zod!;
    const input = z.object({
      account: z.string().describe('Account id'),
      max_tickets: z.number().int().default(25),
      kind: z.union([z.literal('bug'), z.object({ other: z.string() })]),
    });
    const doc = toJsonSchemaDocument(input, 'input')!;
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(doc.type).toBe('object');
    expect(doc.properties?.max_tickets.default).toBe(25);
    expect(doc.properties?.kind.anyOf).toHaveLength(2);
    expect(doc.required).toEqual(['account', 'kind']);

    const triage = workflow('mcp_test_zod', async () => 'ok', { inputSchema: input as any });
    const server = new MCPServer('support');
    server.addWorkflow('triage', triage);
    expect(server.definition().tools[0].input_schema).toEqual(doc);
  });

  it('checks options where they are written', () => {
    const { lookupOrder, triage } = defineComponents();
    const server = new MCPServer('support');
    expect(() => server.addFunction('a', lookupOrder, { mode: 'eventually' as any })).toThrow(/mode/);
    expect(() => server.addFunction('a', lookupOrder, { visibility: ['browser' as any] })).toThrow(/visibility/);
    expect(() => server.addFunction('a', lookupOrder, { visibility: [] })).toThrow(/visibility/);
    expect(() => server.addFunction('a', lookupOrder, { visibility: ['app', 'app'] })).toThrow(/visibility/);
    expect(() => server.addFunction('a', lookupOrder, { annotations: { readonly: true } as any })).toThrow(
      /unknown annotation/,
    );
    expect(() => server.addFunction('a', lookupOrder, { annotations: { readOnlyHint: 'yes' as any } })).toThrow(
      /true or false/,
    );
    expect(() => server.addFunction('get_run', lookupOrder)).toThrow(/reserved/);
    expect(() => server.addFunction('cancel_run', lookupOrder)).toThrow(/reserved/);
    expect(() => server.addFunction('look up', lookupOrder)).toThrow(/1 to 128/);
    expect(() => server.addFunction('x'.repeat(129), lookupOrder)).toThrow(/1 to 128/);
    expect(() => server.addFunction('plain', async () => null)).toThrow(TypeError);
    expect(server.published).toBe(false);
    server.addFunction('lookup', lookupOrder);
    expect(() => server.addWorkflow('lookup', triage)).toThrow(/already has a tool/);
  });

  it('turns the run card off with view: null', () => {
    const { lookupOrder, triage, agent } = defineComponents();
    const server = new MCPServer('support');
    server.addWorkflow('triage_ticket', triage);
    server.addWorkflow('quiet_triage', triage, { view: null });
    server.addAgent('support_agent', agent, { view: null });
    server.addFunction('lookup', lookupOrder, { mode: 'background', view: MCP_RUN_VIEW });
    const tools = Object.fromEntries(server.definition().tools.map(t => [t.name, t]));

    expect(tools.triage_ticket).not.toHaveProperty('view');
    expect(tools.lookup).not.toHaveProperty('view');
    expect(tools.quiet_triage.view).toBe('none');
    expect(tools.support_agent.view).toBe('none');

    expect(() => server.addWorkflow('custom', triage, { view: 'board' as any })).toThrow(/view must be/);
  });

  it('ships custom views that tools name, in any mode', () => {
    const { lookupOrder, triage } = defineComponents();
    const server = new MCPServer('support');
    const board = server.addView('order', { html: BOARD });
    expect([board.name, board.server, board.size]).toEqual(['order', 'support', Buffer.byteLength(BOARD)]);
    expect(board.sha256).toBe(createHash('sha256').update(BOARD).digest('hex'));
    expect(Object.keys(board)).not.toContain('html');

    const dir = mkdtempSync(join(tmpdir(), 'agnt5-view-'));
    const built = join(dir, 'receipt.html');
    writeFileSync(built, '<!doctype html><p>Receipt</p>');
    const receipt = server.addView('receipt', { path: pathToFileURL(built) });

    // Sync tools too; by handle or by name.
    server.addFunction('lookup', lookupOrder, { view: board });
    server.addWorkflow('triage_ticket', triage, { view: 'receipt' });
    server.addWorkflow('plain', triage);
    const definition = server.definition();
    const tools = Object.fromEntries(definition.tools.map(t => [t.name, t]));
    expect(tools.lookup.view).toBe('order');
    expect(tools.triage_ticket.view).toBe('receipt');
    expect(tools.plain).not.toHaveProperty('view');
    expect(definition.views).toEqual([
      { name: 'order', sha256: board.sha256, size: board.size, html: BOARD },
      { name: 'receipt', sha256: receipt.sha256, size: receipt.size, html: '<!doctype html><p>Receipt</p>' },
    ]);
    expect([...server.views.keys()]).toEqual(['order', 'receipt']);
  });

  it('checks views where they are added and named', () => {
    const { lookupOrder } = defineComponents();
    const server = new MCPServer('support');
    expect(() => server.addView('Order Board', { html: BOARD })).toThrow(/lowercase/);
    expect(() => server.addView('run', { html: BOARD })).toThrow(/reserved/);
    expect(() => server.addView('none', { html: BOARD })).toThrow(/reserved/);
    expect(() => server.addView('order', {} as any)).toThrow(/one of \{ html \} or \{ path \}/);
    expect(() => server.addView('order', { html: BOARD, path: 'x.html' } as any)).toThrow(/one of/);
    expect(() => server.addView('order', { path: join(tmpdir(), 'agnt5-missing-view.html') })).toThrow(
      /does not exist. Build it first/,
    );
    expect(() => server.addView('order', { html: ' ' })).toThrow(/no HTML/);
    expect(() => server.addView('order', { html: 'x'.repeat(MCP_MAX_VIEW_BYTES + 1) })).toThrow(/limit is 2097152/);
    server.addView('order', { html: BOARD });
    expect(() => server.addView('order', { html: BOARD })).toThrow(/already has a view/);

    const invoice = new MCPServer('billing').addView('invoice', { html: BOARD });
    expect(() => server.addFunction('lookup', lookupOrder, { view: invoice })).toThrow(/belongs to MCP server "billing"/);
    expect(() => server.addFunction('lookup', lookupOrder, { view: 'chart' })).toThrow(/view must be/);
  });

  it("holds a worker's views to one budget", () => {
    const big = 'x'.repeat(MCP_MAX_VIEW_BYTES);
    new MCPServer('one').addView('a', { html: big });
    expect(() => new MCPServer('two').addView('b', { html: big })).toThrow(/bytes together/);
    expect(MCP_MAX_VIEWS_BYTES).toBeLessThan(4 * 1024 * 1024);
  });

  it('does not publish stdio-only servers', () => {
    const stdio = new MCPServer({
      id: 'legacy',
      name: 'Legacy',
      version: '1.0.0',
      workflows: { plain: async () => null },
    });
    stdio.addWorkflow('also_plain', async () => null);
    expect(stdio.published).toBe(false);
    expect(MCPServerRegistry.get('legacy')).toBe(stdio);
  });
});

describe('Worker MCP registration', () => {
  it('registers published servers as mcp components and serves their agents', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    supportServer().addView('board', { html: BOARD });
    new MCPServer('stdio-only'); // nothing published: not registered

    await new Worker('ts-worker').run();

    const components = (globalThis as any).__agnt5RegisteredComponents as any[];
    const mcp = components.filter(c => c.componentType === 'mcp');
    expect(mcp.map(c => c.name)).toEqual(['support']);
    const definition = JSON.parse(mcp[0].definition);
    expect(definition.tools.map((t: any) => t.component.name)).toEqual([
      'mcp_test_lookup_order',
      'mcp_test_triage',
      'mcp_test_agent',
    ]);
    // The bundle travels with the registration, byte for byte.
    expect(definition.views[0].html).toBe(BOARD);
    const byName = new Map(components.map(c => [c.name, c.componentType]));
    expect(byName.get('mcp_test_lookup_order')).toBe('function');
    expect(byName.get('mcp_test_triage')).toBe('workflow');
    // The published agent is served without a registerAgents call.
    expect(byName.get('mcp_test_agent')).toBe('agent');
  });

  it('logs, but still registers, a server name the platform will refuse', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { lookupOrder } = defineComponents();
    new MCPServer('Support Tools').addFunction('lookup_order', lookupOrder);

    await new Worker('ts-worker').run();

    const components = (globalThis as any).__agnt5RegisteredComponents as any[];
    expect(components.filter(c => c.componentType === 'mcp').map(c => c.name)).toEqual(['Support Tools']);
    expect(errors.mock.calls.some(call => String(call[0]).includes('will be refused'))).toBe(true);
  });
});
