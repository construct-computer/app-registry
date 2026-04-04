/**
 * App Dispatch Worker — routes *.apps.construct.computer
 *
 * Extracts the app ID from the subdomain and routes:
 *   POST /mcp     → app's MCP endpoint (via service binding or fetch, future: WfP)
 *   GET  /ui/*    → static UI files from R2 (future)
 *   GET  /sdk/*   → shared Construct UI SDK from R2 (future)
 *   GET  /health  → 200 OK
 *
 * For now, this is a placeholder that returns structured errors
 * until Workers for Platforms and R2 are configured.
 */

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname; // e.g., "devtools.apps.construct.computer"

    // Extract app ID from subdomain
    const match = hostname.match(/^([^.]+)\.apps\.construct\.computer$/);
    if (!match) {
      return Response.json(
        { error: 'Invalid hostname. Expected {appId}.apps.construct.computer' },
        { status: 400, headers: corsHeaders() },
      );
    }

    const appId = match[1];

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { headers: corsHeaders() });
    }

    // MCP endpoint — future: dispatch to WfP user worker
    if (url.pathname === '/mcp' && request.method === 'POST') {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: `App "${appId}" is registered but not yet deployed. Workers for Platforms hosting is being set up.`,
          },
        },
        { status: 503, headers: corsHeaders() },
      );
    }

    // UI files — future: serve from R2
    if (url.pathname.startsWith('/ui/')) {
      return Response.json(
        { error: `UI for app "${appId}" is not yet deployed.` },
        { status: 404, headers: corsHeaders() },
      );
    }

    // SDK files — future: serve from R2
    if (url.pathname.startsWith('/sdk/')) {
      return Response.json(
        { error: 'Construct SDK not yet deployed to this endpoint.' },
        { status: 404, headers: corsHeaders() },
      );
    }

    return Response.json(
      { error: 'Not found', app: appId },
      { status: 404, headers: corsHeaders() },
    );
  },
};

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-construct-auth, x-construct-user',
    'Content-Type': 'application/json',
  };
}
