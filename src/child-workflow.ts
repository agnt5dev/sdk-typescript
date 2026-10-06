import { createHash } from 'node:crypto';
import { Client } from './client.js';
import { ContextImpl } from './context.js';
import { activationId, childActivationRequestFromContext, runWithActivation } from './activation.js';
import type { ActivationClient, ActivationDecision } from './activation.js';
import { ActivationError, ActivationErrorCode, ConfigurationError, RunError } from './errors.js';
import { retrySleep } from './function-execution.js';
import { throwIfAborted } from './cancellation.js';
import { getCurrentSpanInfo } from './tracing.js';
import type { Context, WorkflowHandler } from './types.js';

/** Gateway invocation identity v1: project-scoped UUIDv5 of a framed caller key. */
export function invocationRunId(projectId: string, key: string): string {
  const frame = (text: string) => {
    const value = Buffer.from(text);
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(value.length));
    return Buffer.concat([length, value]);
  };
  const hash = createHash('sha1').update(Buffer.from('f4d297199f935b5a99e883c5d86986a1', 'hex'))
    .update(Buffer.from('agnt5.invocation.identity.v1\0')).update(frame(projectId)).update(frame(key)).digest().subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Managed children are separate submissions; their handler never receives the parent context. */
export async function runChildWorkflow<T>(ctx: Context, name: string, input: unknown, handler: WorkflowHandler<any, T>): Promise<T> {
  const metadata = ctx.metadata ?? {};
  const managed = metadata.component_type === 'workflow' || metadata.durable_activation_v1 === 'true';
  const allocator = (ctx as any).allocateActivationKey;
  const key = allocator?.call(ctx, 'child-workflow', name) ?? name;
  if (!managed) {
    const child = new ContextImpl(`child:${ctx.invocationId}:${key}`, `child:${ctx.runId}:${key}`, 0, name);
    try { return await handler(child, input); }
    finally { child.close(); }
  }
  const client = new Client({ deploymentId: metadata.deployment_id, tenantId: metadata.tenant_id });
  const join = async (idempotencyKey: string, expectedRunId?: string): Promise<T> => {
    throwIfAborted(ctx.signal);
    const submitted = await client.submit(name, input, { componentType: 'workflow', idempotencyKey, signal: ctx.signal,
      parentRunId: ctx.runId, rootRunId: metadata.root_run_id || ctx.runId,
      traceparent: (() => { const span = getCurrentSpanInfo(); return span ? `00-${span.traceId}-${span.spanId}-${span.sampled ? '01' : '00'}` : undefined; })(),
    });
    if (expectedRunId && submitted.runId !== expectedRunId) throw new ActivationError(ActivationErrorCode.NonDeterministicReplay, 'gateway child identity does not match the admitted linkage');
    while (true) {
      throwIfAborted(ctx.signal);
      const status = await client.getStatus(submitted.runId, ctx.signal);
      if (['completed', 'failed', 'cancelled', 'timeout'].includes(status.status)) {
        const result = await client.getResult<T>(submitted.runId, ctx.signal);
        if (!result.isSuccess) throw new RunError(result.error?.message ?? `Child workflow '${name}' ${result.status}`, submitted.runId, result.status);
        return await client.resolveOutput(result) as T;
      }
      await retrySleep(250, ctx.signal);
    }
  };
  if (metadata.durable_activation_v1 !== 'true') {
    return await ctx.step(`child:${name}`, () => join(`agnt5:child:${ctx.runId}:${key}`), { key, input });
  }
  const activationClient = (ctx as Context & { getActivationClient?(): ActivationClient }).getActivationClient?.();
  if (!activationClient || !allocator) throw new ConfigurationError('Managed child workflows require activation authority');
  let request = await childActivationRequestFromContext(ctx, { childName: name, stableKey: key, input });
  const id = await activationId(request.projectId, request.runId, request.parentActivationId, request.kind, request.stableKey);
  const idempotencyKey = `agnt5:child:${id}`;
  const childRunId = invocationRunId(request.projectId, idempotencyKey);
  request = { ...request, child: { ...request.child!, childRunId } };
  let decision: ActivationDecision | undefined;
  const start = Date.now();
  const { result } = await activationClient.run(request, () => runWithActivation(decision!, () => join(idempotencyKey, childRunId)), {
    encodeOutput: value => new TextEncoder().encode(JSON.stringify(value ?? null)),
    decodeOutput: value => JSON.parse(new TextDecoder().decode(value)) as T,
    latencyMs: () => Date.now() - start,
    onAdmitted: admitted => { decision = admitted; },
    failureErrorCode: 'CHILD_FAILED',
    failureRetryable: true,
  });
  return result;
}
