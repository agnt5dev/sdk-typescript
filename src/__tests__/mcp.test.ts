import { describe, it, expect } from 'vitest';
import { MCPClient, MCPError } from '../mcp.js';

describe('MCPClient', () => {
  it('should create client with id', () => {
    const client = new MCPClient('test-client');
    expect(client.id).toBe('test-client');
  });

  it('should add stdio server config', () => {
    const client = new MCPClient('test');
    client.addStdioServer('wiki', 'npx', ['-y', 'wikipedia-mcp']);
    // No error means config was accepted
    expect(client.connectedServers()).toEqual([]);
  });

  it('should add SSE server config', () => {
    const client = new MCPClient('test');
    client.addSseServer('remote', 'https://example.com/mcp', { Authorization: 'Bearer token' });
    expect(client.connectedServers()).toEqual([]);
  });

  it('should parse dict config with command (stdio)', () => {
    const client = new MCPClient('test', {
      myserver: { command: 'python', args: ['-m', 'mcp_server'] },
    });
    expect(client.id).toBe('test');
  });

  it('should reject invalid config', () => {
    expect(() => {
      new MCPClient('test', {
        bad: { invalid: true },
      });
    }).toThrow('Invalid server config');
  });

  it('should report not connected for unknown server', () => {
    const client = new MCPClient('test');
    expect(client.isConnected('unknown')).toBe(false);
  });

  it('should return empty tools when not connected', () => {
    const client = new MCPClient('test');
    expect(client.listTools()).toEqual([]);
  });

  it('should throw when listing tools for non-connected server', () => {
    const client = new MCPClient('test');
    expect(() => client.listServerTools('unknown')).toThrow("Server 'unknown' not connected");
  });

  it('should throw when calling tool on non-connected server', async () => {
    const client = new MCPClient('test');
    await expect(client.callTool('unknown', 'test')).rejects.toThrow("Server 'unknown' not connected");
  });

  it('should throw when calling tool auto with no servers', async () => {
    const client = new MCPClient('test');
    await expect(client.callToolAuto('test')).rejects.toThrow("Tool 'test' not found");
  });

  it('MCPError should be an Error', () => {
    const err = new MCPError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MCPError');
    expect(err.message).toBe('test error');
  });
});
