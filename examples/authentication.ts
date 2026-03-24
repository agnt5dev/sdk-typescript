/**
 * Example: Authentication patterns
 *
 * Demonstrates different ways to authenticate with the AGNT5 platform.
 */

import { Client } from '../src/index.js';

// ─── 1. API Key via constructor ─────────────────────────────────────

const client = new Client({
  gatewayUrl: 'https://api.agnt5.com',
  apiKey: 'agnt5_sk_your_api_key_here',
});

// ─── 2. API Key via environment variable ─────────────────────────────

// Set AGNT5_API_KEY in your environment, then:
const clientFromEnv = new Client({
  gatewayUrl: 'https://api.agnt5.com',
  // API key read automatically from process.env.AGNT5_API_KEY
});

// ─── 3. Local development (no auth needed) ──────────────────────────

const localClient = new Client();
// Defaults to http://localhost:34181, no API key required

// ─── 4. Custom subdomain URL ────────────────────────────────────────

const teamClient = new Client({
  gatewayUrl: 'https://myteam.agnt5.com',
  apiKey: 'agnt5_sk_team_key',
  timeout: 60000, // 60 second timeout
  maxRetries: 5,
});

// ─── Usage example ──────────────────────────────────────────────────

async function main() {
  // All clients use the same API
  const response = await client.run('greet', { name: 'Alice' });

  if (response.isSuccess) {
    console.log('Output:', response.output);
    console.log('Run ID:', response.runId);
    console.log('Duration:', response.durationMs, 'ms');
  } else {
    response.raiseForStatus();
  }
}

main().catch(console.error);
