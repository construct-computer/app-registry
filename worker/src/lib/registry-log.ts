import { log, track, type AnalyticsEvent, type LogLevel } from '@construct/observability';
import { observabilityEnv, type RegistryObservabilityEnv } from './observability-env';

export interface RequestLogContext {
  requestId?: string;
  traceId?: string;
}

export function logRegistry(
  env: RegistryObservabilityEnv,
  ctx: ExecutionContext | undefined,
  opts: {
    level: LogLevel;
    source: string;
    message: string;
    error?: unknown;
    request?: RequestLogContext;
    context?: Record<string, unknown>;
  },
): void {
  log(
    observabilityEnv(env),
    {
      kind: 'log',
      level: opts.level,
      source: opts.source,
      message: opts.message,
      error: opts.error,
      requestId: opts.request?.requestId,
      traceId: opts.request?.traceId,
      context: opts.context,
    },
    ctx,
  );
}

export function trackRegistryEvent(
  env: RegistryObservabilityEnv,
  ctx: ExecutionContext | undefined,
  event: AnalyticsEvent,
): void {
  track(observabilityEnv(env), event, ctx);
}

let deployTracked = false;

export function maybeTrackDeploy(env: RegistryObservabilityEnv, ctx: ExecutionContext): void {
  if (deployTracked || !env.ANALYTICS_QUEUE) return;
  deployTracked = true;
  track(
    observabilityEnv(env),
    {
      event: 'system_event',
      trigger: 'platform',
      name: 'worker_deploy',
      source: 'worker.startup',
      detail: { app_version: env.APP_VERSION ?? null },
    },
    ctx,
  );
}
