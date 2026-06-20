/**
 * App registry logging — wraps @construct/observability.
 */

import {
  configureLogsForward,
  createServiceLogger,
  emitDeployEvent,
  type LogContext,
  type Logger,
  type LoggerForwardOptions,
  type ObservabilityEnv,
  type WideEvent,
} from '@construct/observability';
import { observabilityOptions } from './observability-config';

export type { LogContext, Logger } from '@construct/observability';

export interface RegistryLogEnv extends ObservabilityEnv {
  LOGS_QUEUE?: Queue<WideEvent>;
}

export function createLogger(
  source: string,
  ctx: LogContext = {},
  env?: RegistryLogEnv,
  forward?: LoggerForwardOptions,
): Logger {
  return createServiceLogger(
    env ?? { ENVIRONMENT: 'production' },
    observabilityOptions(env ?? {}),
    source,
    ctx,
    {
      queue: env?.LOGS_QUEUE,
      ...forward,
    },
  );
}

export function wireLogsForward(env: RegistryLogEnv, ctx: ExecutionContext): void {
  configureLogsForward(env.LOGS_QUEUE, ctx.waitUntil.bind(ctx));
}

export function maybeEmitDeploy(env: RegistryLogEnv): void {
  const opts = observabilityOptions(env);
  emitDeployEvent({
    env,
    serviceName: opts.serviceName,
    workerName: opts.workerName ?? opts.serviceName,
  });
}
