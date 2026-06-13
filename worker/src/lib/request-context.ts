/**
 * HTTP request context: correlation ids, trace propagation, access logging,
 * and metrics for the raw Cloudflare Workers fetch handler.
 *
 * Every request gets:
 *   - requestId  (from X-Request-ID, CF-Ray, or crypto UUID)
 *   - traceId    (from X-Trace-ID, X-Cloud-Trace-Context, or requestId)
 *   - cfRay      (Cloudflare ray id, when available)
 *
 * These ids are echoed back to the client and propagated to outbound
 * sub-requests via applyTraceHeaders so downstream logs can join with
 * registry logs.
 */

import { createLogger } from './log';
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
}

function generateRequestId(request: Request): string {
  return request.headers.get('x-request-id')
    || request.headers.get('cf-ray')
    || crypto.randomUUID();
}

function generateTraceId(request: Request, requestId: string): string {
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

export function applyTraceHeaders(
  ctx: RequestContext,
  request: Request,
): Request {
  const r = new Request(request, { body: request.body });
  r.headers.set('x-request-id', ctx.requestId);
  r.headers.set('x-trace-id', ctx.traceId);
  return r;
}

export function withRequestContext<E extends ObservabilityEnv>(
  handler: (request: Request, env: E) => Promise<Response>,
) {
  return async (
    request: Request,
    env: E,
    executionCtx?: ExecutionContext,
  ): Promise<Response> => {
    const ctx = getRequestContext(request);
    const start = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    const route = path;

    let response: Response;
    let caughtError: unknown;

    try {
      response = await handler(request, env);
    } catch (err) {
      caughtError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const log = createLogger('http', {
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        correlationId: ctx.correlationId,
        cfRay: ctx.cfRay,
      });
      log.error('worker_error', { error: msg });
      response = new Response(JSON.stringify({ error: `Internal server error: ${msg}` }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

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

    const log = createLogger('http', {
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      cfRay: ctx.cfRay,
    });

    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    log[level]('http_request', {
      method: request.method,
      path,
      route,
      status,
      status_bucket: statusBucket,
      duration_ms: durationMs,
      user_agent: request.headers.get('user-agent') ?? undefined,
      cf_ray: ctx.cfRay,
      error: caughtError instanceof Error ? caughtError.message : (caughtError ? String(caughtError) : undefined),
    });

    // Echo ids back so clients can include them in support requests / later calls.
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    response.headers.set('x-request-id', ctx.requestId);
    response.headers.set('x-trace-id', ctx.traceId);

    // Flush metrics without blocking the response when possible.
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
