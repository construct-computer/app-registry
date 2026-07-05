export const REGISTRY_HTML_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const DEFAULT_CONSTRUCT_FRAME_ANCESTORS =
  "'self' https://beta.construct.computer https://staging.construct.computer http://localhost:8787 http://localhost:5173";

export function getAppFrameAncestorsCsp(env?: { CONSTRUCT_FRAME_ANCESTORS?: string }): string {
  const ancestors = env?.CONSTRUCT_FRAME_ANCESTORS?.trim() || DEFAULT_CONSTRUCT_FRAME_ANCESTORS;
  return `frame-ancestors ${ancestors}`;
}

export function withRegistryHtmlHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, ...REGISTRY_HTML_SECURITY_HEADERS };
}

export function withAppUiHeaders(
  headers: Record<string, string>,
  env?: { CONSTRUCT_FRAME_ANCESTORS?: string },
): Record<string, string> {
  return {
    ...headers,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': getAppFrameAncestorsCsp(env),
    'X-Content-Type-Options': 'nosniff',
  };
}
