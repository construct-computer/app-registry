/**
 * HTTP request context: correlation ids and trace propagation.
 */

export interface RequestContext {
  requestId: string;
  traceId: string;
  correlationId: string;
  cfRay?: string;
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
  const headers = new Headers(request.headers);
  headers.set('x-request-id', ctx.requestId);
  headers.set('x-trace-id', ctx.traceId);
  return new Request(request, { headers });
}

/** Log context from an inbound request (trace ids for structured logs). */
export function logContextFromRequest(request: Request): RequestContext {
  return getRequestContext(request);
}
