/**
 * App registry logging — wraps @construct/observability.
 */

import {
  createServiceLogger,
  type LogContext,
  type Logger,
  type ObservabilityEnv,
} from '@construct/observability';
import { observabilityOptions } from './observability-config';

export type { LogContext, Logger } from '@construct/observability';

export function createLogger(
  source: string,
  ctx: LogContext = {},
  env?: ObservabilityEnv,
): Logger {
  return createServiceLogger(env ?? { ENVIRONMENT: 'production' }, observabilityOptions(env ?? {}), source, ctx);
}
