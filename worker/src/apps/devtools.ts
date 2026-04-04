/**
 * DevTools — Worker-native MCP server for the Construct platform.
 *
 * This is a Cloudflare Worker that speaks MCP (JSON-RPC 2.0 over HTTP POST).
 * It exports a standard fetch handler — no custom SDK required.
 *
 * MCP endpoint: POST /mcp
 * Health check: GET /health
 */

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'json_format',
    description: 'Format, minify, or validate a JSON string.',
    inputSchema: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'The JSON string to process' },
        mode: { type: 'string', enum: ['format', 'minify', 'validate'], description: 'Operation mode (default: format)' },
        indent: { type: 'number', description: 'Indent spaces for format mode (default: 2)' },
      },
      required: ['json'],
    },
  },
  {
    name: 'base64',
    description: 'Encode or decode a Base64 string.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to encode or decode' },
        mode: { type: 'string', enum: ['encode', 'decode'], description: 'Operation mode (default: encode)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'hash',
    description: 'Generate a hash of the given text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to hash' },
        algorithm: { type: 'string', enum: ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'], description: 'Hash algorithm (default: SHA-256)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'uuid',
    description: 'Generate one or more v4 UUIDs.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of UUIDs to generate (default: 1, max: 50)' },
      },
    },
  },
  {
    name: 'timestamp',
    description: 'Convert between Unix timestamps and ISO 8601 dates.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'A Unix timestamp or ISO date string. Omit for current time.' },
      },
    },
  },
  {
    name: 'url_encode',
    description: 'URL-encode or decode a string.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The string to encode or decode' },
        mode: { type: 'string', enum: ['encode', 'decode'], description: 'Operation mode (default: encode)' },
      },
      required: ['text'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'json_format': {
        const input = args.json as string;
        const mode = (args.mode as string) || 'format';
        const indent = (args.indent as number) || 2;
        const parsed = JSON.parse(input);

        if (mode === 'validate') {
          const type = Array.isArray(parsed) ? 'array' : typeof parsed;
          const keys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? Object.keys(parsed).length : 0;
          const items = Array.isArray(parsed) ? parsed.length : 0;
          let info = `✓ Valid JSON (${type})`;
          if (keys > 0) info += ` — ${keys} key${keys > 1 ? 's' : ''}`;
          if (items > 0) info += ` — ${items} item${items > 1 ? 's' : ''}`;
          info += `\nSize: ${input.length} chars → ${JSON.stringify(parsed).length} chars minified`;
          return { content: [{ type: 'text', text: info }] };
        }

        const output = mode === 'minify' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent);
        return { content: [{ type: 'text', text: output }] };
      }

      case 'base64': {
        const text = args.text as string;
        const mode = (args.mode as string) || 'encode';
        if (mode === 'decode') {
          const decoded = new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
          return { content: [{ type: 'text', text: decoded }] };
        }
        const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
        return { content: [{ type: 'text', text: encoded }] };
      }

      case 'hash': {
        const text = args.text as string;
        const algorithm = (args.algorithm as string) || 'SHA-256';
        const data = new TextEncoder().encode(text);
        const hashBuffer = await crypto.subtle.digest(algorithm, data);
        const hex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        return { content: [{ type: 'text', text: `${algorithm}: ${hex}` }] };
      }

      case 'uuid': {
        const count = Math.min(Math.max(1, (args.count as number) || 1), 50);
        const uuids = Array.from({ length: count }, () => crypto.randomUUID());
        return { content: [{ type: 'text', text: uuids.join('\n') }] };
      }

      case 'timestamp': {
        const value = args.value as string | undefined;
        let date: Date;
        if (!value || value.trim() === '') {
          date = new Date();
        } else {
          const num = Number(value);
          if (!isNaN(num)) {
            date = new Date(num > 1e12 ? num : num * 1000);
          } else {
            date = new Date(value);
            if (isNaN(date.getTime())) {
              return { content: [{ type: 'text', text: `Cannot parse: "${value}". Provide a Unix timestamp or ISO date.` }], isError: true };
            }
          }
        }
        const unixSec = Math.floor(date.getTime() / 1000);
        const unixMs = date.getTime();
        const now = Date.now();
        const diff = now - date.getTime();
        const abs = Math.abs(diff);
        const suffix = diff >= 0 ? 'ago' : 'from now';
        let relative = 'just now';
        if (abs >= 31_536_000_000) relative = `${Math.floor(abs / 31_536_000_000)} years ${suffix}`;
        else if (abs >= 2_592_000_000) relative = `${Math.floor(abs / 2_592_000_000)} months ${suffix}`;
        else if (abs >= 86_400_000) relative = `${Math.floor(abs / 86_400_000)} days ${suffix}`;
        else if (abs >= 3_600_000) relative = `${Math.floor(abs / 3_600_000)} hours ${suffix}`;
        else if (abs >= 60_000) relative = `${Math.floor(abs / 60_000)} minutes ${suffix}`;

        return {
          content: [{
            type: 'text',
            text: [
              `ISO 8601:    ${date.toISOString()}`,
              `Unix (sec):  ${unixSec}`,
              `Unix (ms):   ${unixMs}`,
              `Relative:    ${relative}`,
            ].join('\n'),
          }],
        };
      }

      case 'url_encode': {
        const text = args.text as string;
        const mode = (args.mode as string) || 'encode';
        const output = mode === 'decode' ? decodeURIComponent(text) : encodeURIComponent(text);
        return { content: [{ type: 'text', text: output }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

// ── MCP JSON-RPC Handler ────────────────────────────────────────────────────

export async function handleMcp(request: Request): Promise<Response> {
  const rpc = (await request.json()) as { id?: number; method: string; params?: Record<string, unknown> };

  // Notifications (no id) — acknowledge silently
  if (rpc.id == null) return new Response(null, { status: 204 });

  let result: unknown;

  switch (rpc.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'devtools', version: '1.0.0' },
      };
      break;

    case 'tools/list':
      result = { tools: TOOLS };
      break;

    case 'tools/call': {
      const params = rpc.params as { name: string; arguments?: Record<string, unknown> };
      result = await handleToolCall(params.name, params.arguments || {});
      break;
    }

    default:
      return Response.json(
        { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Method not found: ${rpc.method}` } },
        { headers: { 'Content-Type': 'application/json' } },
      );
  }

  return Response.json(
    { jsonrpc: '2.0', id: rpc.id, result },
    { headers: { 'Content-Type': 'application/json' } },
  );
}

// Exported as handleMcp — called by the registry worker's app proxy.
