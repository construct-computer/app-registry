export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

export const CANONICAL_SECURITY_TXT_URL = 'https://construct.computer/.well-known/security.txt';

export function ensureHttpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get('X-Forwarded-Proto');
  if (url.protocol === 'http:' || forwardedProto === 'http') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return null;
}

export function isSecurityTxtPath(pathname: string): boolean {
  return pathname === '/.well-known/security.txt' || pathname === '/security.txt';
}

export function securityTxtRedirectResponse(): Response {
  return Response.redirect(CANONICAL_SECURITY_TXT_URL, 301);
}

export function withStrictTransportSecurity(response: Response, request: Request): Response {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && request.headers.get('X-Forwarded-Proto') !== 'https') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
