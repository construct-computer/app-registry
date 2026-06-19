/**
 * HTTP request context: correlation ids, trace propagation, access logging, metrics.
 */

import {
  applyTraceHeadersFromContext,
  withRequestContext as observabilityWithRequestContext,
} from '@construct/observability';
import { observabilityOptions } from './observability-config';
import { metrics } from './metrics';

export interface RequestContext {
  requestId: string;
  traceId: string;
  correlationId: string;
  cfRay?: string;
}

export interface ObservabilityEnv {
  ENVIRONMENT: string;
  GRAFANA_OTLP_ENDPOINT?: string;
  GRAFANA_OTLP_AUTH?: string;
  APP_VERSION?: string;
}

function generateRequestId(request: Request): string {
  return request.headers.get('x-request-id')
    || request.headers.get('cf-ray')
    || crypto.randomUUID();
}

function generateTraceId(request: Request, requestId: string): string {
  const traceparent = request.headers.get('traceparent');
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  const cloudTrace = request.headers.get('x-cloud-trace-context');
  return request.headers.get('x-trace-id')
    || (cloudTrace ? cloudTrace.split('/')[0] : undefined)
    || requestId;
}

export function getRequestContext(request: Request): RequestContext {
  const requestId = generateRequestId(request);
  const traceId = generateTraceId(request, requestId);
  return {
    requestId,
    traceId,
    correlationId: traceId,
    cfRay: request.headers.get('cf-ray') || undefined,
  };
}

export function applyTraceHeaders(ctx: RequestContext, request: Request): Request {
  return applyTraceHeadersFromContext(ctx, request);
}

export function withRequestContext<E extends ObservabilityEnv>(
  handler: (request: Request, env: E) => Promise<Response>,
) {
  return async (request: Request, env: E, executionCtx?: ExecutionContext): Promise<Response> => {
    const start = Date.now();
    const url = new URL(request.url);
    const route = url.pathname;

    const inner = observabilityWithRequestContext(observabilityOptions(env), handler);
    const response = await inner(request, env, executionCtx);

    const durationMs = Date.now() - start;
    const status = response.status;
    const statusBucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';

    metrics.counter('http.requests', 1, {
      method: request.method,
      route,
      status_bucket: statusBucket,
    }, '{request}');
    metrics.histogram('http.duration', durationMs, {
      method: request.method,
      route,
    });

    if (env.GRAFANA_OTLP_ENDPOINT && env.GRAFANA_OTLP_AUTH) {
      const flush = metrics.pushAndLog(env.GRAFANA_OTLP_ENDPOINT, env.GRAFANA_OTLP_AUTH, env.ENVIRONMENT);
      if (executionCtx) {
        executionCtx.waitUntil(flush);
      } else {
        await flush;
      }
    }

    return response;
  };
}

/** Log context from an inbound request (trace ids for structured logs). */
export function logContextFromRequest(request: Request): {
  requestId: string;
  traceId: string;
  correlationId: string;
  cfRay?: string;
} {
  const ctx = getRequestContext(request);
  return {
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    correlationId: ctx.correlationId,
    cfRay: ctx.cfRay,
  };
}
