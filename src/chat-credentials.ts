/**
 * Chat bot tokens for hosted workers, fetched when a reply needs one.
 *
 * A chat run's input names the integration the message came through, but not
 * its bot token: run input is stored with the run's history, so a token there
 * could be read by anyone who can read the run. A hosted worker fetches the
 * token from the platform with its workload identity instead, and keeps it
 * only in memory until it expires.
 *
 * Outside a hosted worker (`agnt5 dev`, tests) there is no workload identity,
 * and the token configured on the `ChatBot` is used.
 */

import { readFile } from 'node:fs/promises';

const BROKER_URL_ENV = 'AGNT5_WORKLOAD_BROKER_URL';
const TOKEN_FILE_ENV = 'AGNT5_WORKLOAD_TOKEN_FILE';
const CREDENTIAL_AUDIENCE = 'agnt5-credentials';
const SCOPE = 'chat_bot_token';
// Fetch again this long before the platform's expiry, so a reply never starts
// with a token about to lapse.
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TTL_MS = 300_000;
const TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

interface Cached {
  token: string;
  expiresAt: number;
}

export interface BotTokenSourceOptions {
  brokerUrl?: string;
  tokenFile?: string;
  fetch?: Fetch;
  logger?: (message: string) => void;
}

/** Fetches and caches bot tokens by integration id. */
export class BotTokenSource {
  private readonly brokerUrl: string;
  private readonly tokenFile: string;
  private readonly fetchFn: Fetch;
  private readonly logger: (message: string) => void;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();

  constructor(options: BotTokenSourceOptions = {}) {
    this.brokerUrl = (options.brokerUrl ?? process.env[BROKER_URL_ENV] ?? '').replace(/\/+$/, '');
    this.tokenFile = options.tokenFile ?? process.env[TOKEN_FILE_ENV] ?? '';
    this.fetchFn = options.fetch ?? fetch;
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  /** Whether this worker has a workload identity to fetch with. */
  get available(): boolean {
    return Boolean(this.brokerUrl && this.tokenFile);
  }

  /**
   * The integration's bot token, or `undefined` when it can't be fetched. A
   * failed fetch is logged, without the token, so the caller can fall back to
   * a configured token.
   */
  async get(integrationId: string | undefined): Promise<string | undefined> {
    if (!integrationId || !this.available) return undefined;
    const cached = this.cache.get(integrationId);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;
    const pending = this.inflight.get(integrationId);
    if (pending) return pending;
    const request = this.fetchToken(integrationId)
      .then((fetched) => {
        this.cache.set(integrationId, fetched);
        return fetched.token;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger(`Could not fetch the chat bot token for integration ${integrationId}: ${reason}`);
        return undefined;
      })
      .finally(() => this.inflight.delete(integrationId));
    this.inflight.set(integrationId, request);
    return request;
  }

  private async fetchToken(integrationId: string): Promise<Cached> {
    const projected = (await readFile(this.tokenFile, 'utf-8')).trim();
    if (!projected) throw new Error('the workload token file is empty');
    const exchanged = await this.post('/internal/workload/token', {
      token: projected,
      audience: [CREDENTIAL_AUDIENCE],
    });
    if (!exchanged.ok) throw new Error(`workload token exchange failed (${exchanged.status})`);
    const workloadToken = ((await exchanged.json()) as { token?: string }).token;
    if (!workloadToken) throw new Error('the workload token exchange returned no token');
    const credential = await this.post(
      '/internal/workload/credential',
      { scope: SCOPE, ref: integrationId, purpose: 'chat_reply' },
      workloadToken,
    );
    if (!credential.ok) {
      // The broker's error says why (an integration that's gone, no bot token
      // on it); the response never carries a credential.
      const reason = await credential
        .json()
        .then((body) => (body as { error?: string }).error ?? '')
        .catch(() => '');
      throw new Error(`credential request failed (${credential.status}) ${reason}`.trim());
    }
    const body = (await credential.json()) as { value?: string; expires_at?: string };
    if (!body.value) throw new Error('the credential response held no token');
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
    return {
      token: body.value,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + DEFAULT_TTL_MS,
    };
  }

  private post(path: string, body: unknown, bearer?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return this.fetchFn(`${this.brokerUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

let defaultSource: BotTokenSource | undefined;

/** The process-wide source, built from the worker's environment. */
export function defaultBotTokenSource(): BotTokenSource {
  defaultSource ??= new BotTokenSource();
  return defaultSource;
}
