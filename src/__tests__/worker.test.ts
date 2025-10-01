import { describe, it, expect } from 'vitest';
import { Worker, getRuntime } from '../worker';

describe('Worker', () => {
  it('should create worker instance', () => {
    const worker = new Worker('test-service');
    expect(worker).toBeDefined();
  });

  it('should accept options', () => {
    const worker = new Worker('test-service', {
      runtime: 'managed',
    });
    expect(worker).toBeDefined();
  });
});

describe('getRuntime', () => {
  it('should detect runtime', () => {
    const runtime = getRuntime();
    expect(runtime).toMatch(/node|bun|deno|edge|unknown/);
  });
});
