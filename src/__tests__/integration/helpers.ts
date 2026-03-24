/**
 * Integration test helpers for the AGNT5 TypeScript SDK.
 *
 * These helpers set up the test environment for running integration tests
 * against a local or remote AGNT5 platform instance.
 *
 * Prerequisites:
 * - Running AGNT5 platform (dev server or managed)
 * - Set AGNT5_GATEWAY_URL (default: http://localhost:34181)
 * - Set AGNT5_COORDINATOR_ENDPOINT (default: http://localhost:34186)
 * - Optionally set AGNT5_API_KEY for authenticated tests
 */

import { Client } from '../../client.js';
import { Worker } from '../../worker.js';
import type { ClientOptions } from '../../client.js';

// ─── Environment ─────────────────────────────────────────────────────

export const GATEWAY_URL = process.env.AGNT5_GATEWAY_URL || 'http://localhost:34181';
export const COORDINATOR_ENDPOINT = process.env.AGNT5_COORDINATOR_ENDPOINT || 'http://localhost:34186';
export const API_KEY = process.env.AGNT5_API_KEY;
export const TENANT_ID = process.env.AGNT5_TENANT_ID;

/**
 * Check if the platform is reachable.
 * Integration tests should skip if this returns false.
 */
export async function isPlatformAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Create a Client configured for integration tests.
 */
export function createTestClient(overrides?: Partial<ClientOptions>): Client {
  return new Client({
    gatewayUrl: GATEWAY_URL,
    apiKey: API_KEY,
    timeout: 30000,
    maxRetries: 1,
    ...overrides,
  });
}

/**
 * Generate a unique test name to avoid collisions.
 */
export function uniqueName(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Wait for a condition with timeout.
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 10000,
  pollMs: number = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Skip test suite if platform is not available.
 * Use as: `beforeAll(skipIfNoPlatform)` in describe blocks.
 */
export async function skipIfNoPlatform(): Promise<void> {
  const available = await isPlatformAvailable();
  if (!available) {
    console.log(`⚠ Skipping integration tests: platform not reachable at ${GATEWAY_URL}`);
    // This will cause vitest to skip via the returned value
    throw new Error('Platform not available - skipping integration tests');
  }
}
