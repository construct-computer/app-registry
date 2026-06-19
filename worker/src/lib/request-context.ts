/**
 * HTTP request context: correlation ids, trace propagation, and access logging.
 */

import {
  applyTraceHeadersFromContext,
  withRequestContext as observabilityWithRequestContext,
} from '@construct/observability';
import { observabilityOptions } from './observability-config';

export interface RequestContext {
  requestId: string;
  traceId: string;
  correlationId: string;
  cfRay?: string;
}

export interface ObservabilityEnv {
  ENVIRONMENT: string;
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
    const inner = observabilityWithRequestContext(observabilityOptions(env), handler);
    return inner(request, env, executionCtx);
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
