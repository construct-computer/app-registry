/**
 * Registry-hosted Construct SDK assets.
 *
 * The app SDK package is the canonical source for the browser bridge and CSS.
 * The registry worker only owns HTTP response headers because it serves those
 * package assets from both registry.construct.computer/sdk/* and app subdomain
 * /sdk/* mirrors.
 */

export { CONSTRUCT_SDK_CSS, CONSTRUCT_SDK_JS } from '@construct-computer/app-sdk'

/**
 * Response headers for SDK files. CORS is wide open so the SDK can be loaded
 * cross-origin from any app UI: local dev, tunnels, or published app subdomains.
 */
export const SDK_RESPONSE_HEADERS_JS: Record<string, string> = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
}

export const SDK_RESPONSE_HEADERS_CSS: Record<string, string> = {
  'Content-Type': 'text/css; charset=utf-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
}
