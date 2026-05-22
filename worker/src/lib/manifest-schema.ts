/**
 * JSON Schema for Construct app `manifest.json` files.
 *
 * Served at https://registry.construct.computer/schemas/manifest.json so
 * editors (VS Code, etc.) can pick it up via the `$schema` field and offer
 * autocomplete + validation while a developer is writing a manifest.
 *
 * Why this isn't imported from `@construct-computer/app-sdk`:
 *   The SDK package ships the same shape at
 *   `@construct-computer/app-sdk/schemas/manifest.schema.json`, but Workers
 *   cannot import JSON from that package without tsconfig/build changes.
 *   When the registry worker build supports JSON module imports, replace
 *   this file with:
 *     export { default as MANIFEST_SCHEMA } from '@construct-computer/app-sdk/schemas/manifest.schema.json'
 *   (also enable `resolveJsonModule` in tsconfig).
 *
 * Keep in sync with:
 *   - `scripts/sync.ts`                    (Manifest interface + owners regex)
 *   - `.github/workflows/validate-pr.yml`  (CI gate — required fields)
 *   - `categories.json`                    (allowed category ids)
 *   - `DEVELOPER_DOCS.md`                  (prose reference)
 *   - `@construct-computer/app-sdk/schemas/manifest.schema.json`  (bump on next SDK release)
 */

export const MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://registry.construct.computer/schemas/manifest.json',
  title: 'Construct App Manifest',
  description:
    'Metadata for a Construct app. See https://registry.construct.computer/publish for the full developer guide.',
  type: 'object',
  required: ['name', 'description'],
  additionalProperties: false,
  properties: {
    $schema: {
      type: 'string',
      format: 'uri',
      description:
        'URL of this JSON Schema. Set to https://registry.construct.computer/schemas/manifest.json to enable editor autocomplete.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 60,
      description: 'Display name shown in the App Store and Launchpad.',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description:
        'Short one-line description shown in search results and app cards.',
    },
    author: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        url: { type: 'string', format: 'uri' },
      },
    },
    owners: {
      type: 'array',
      uniqueItems: true,
      description:
        'GitHub logins (lowercase) that gate registry PRs bumping this app and can manage env vars via the developer dashboard.',
      items: {
        type: 'string',
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$',
      },
    },
    icon: {
      type: 'string',
      minLength: 1,
      description:
        'Relative path to the app icon (PNG, SVG, or JPG). Defaults to "icon.png".',
    },
    categories: {
      type: 'array',
      description:
        'Category IDs. Only the first entry is used by the store — extras are ignored.',
      items: {
        type: 'string',
        enum: [
          'productivity',
          'developer-tools',
          'communication',
          'finance',
          'media',
          'ai-tools',
          'data',
          'utilities',
          'integrations',
          'shopping',
          'games',
        ],
      },
    },
    tags: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Searchable tags shown in the store listing.',
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      description: 'Visual UI configuration. Omit for tools-only apps.',
      properties: {
        entry: {
          type: 'string',
          default: 'ui/index.html',
          description: 'HTML entry point relative to the repo root.',
        },
        width: {
          type: 'integer',
          minimum: 200,
          maximum: 2400,
          default: 800,
          description: 'Default window width in pixels.',
        },
        height: {
          type: 'integer',
          minimum: 200,
          maximum: 2400,
          default: 600,
          description: 'Default window height in pixels.',
        },
      },
    },
    auth: {
      type: 'object',
      description:
        'Authentication configuration. Use schemes[] for new apps; the flat oauth2 field is a legacy single-scheme shorthand.',
      additionalProperties: false,
      properties: {
        schemes: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/authScheme' },
        },
        oauth2: { $ref: '#/$defs/oauth2Body' },
      },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      description: 'Declared permissions shown to users during install.',
      properties: {
        network: {
          type: 'array',
          items: { type: 'string' },
          description: 'External domains this app connects to.',
        },
        storage: {
          type: 'string',
          description: 'Maximum storage (e.g. "1MB", "10MB").',
        },
        uses: {
          type: 'object',
          additionalProperties: false,
          description:
            'Platform capabilities this app uses at runtime. Each must be declared to be callable via ctx.construct.',
          properties: {
            tools: {
              type: 'array',
              description:
                'Managed platform tool names (e.g. "drive.list_files") this app may call through ctx.construct.tools.call().',
              items: {
                type: 'string',
                pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$',
              },
              uniqueItems: true,
            },
            apps: {
              type: 'array',
              description: 'Other Construct apps this app may call through ctx.construct.apps.call().',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['app_id', 'tools'],
                properties: {
                  app_id: {
                    type: 'string',
                    description: 'Target app id as registered in the app registry.',
                  },
                  tools: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'string',
                      pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$',
                    },
                    description: 'Whitelisted tool names on the target app.',
                  },
                },
              },
            },
            inference: {
              type: 'boolean',
              description: 'Whether this app may use platform inference via ctx.construct.infer().',
            },
          },
        },
      },
    },
    tools: {
      type: 'array',
      description:
        'Pre-declared tool list. Auto-discovered on deploy if omitted; useful for the store listing before first deploy.',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name'],
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
          description: { type: 'string' },
        },
      },
    },
  },

  $defs: {
    authScheme: {
      oneOf: [
        { $ref: '#/$defs/oauth2Scheme' },
        { $ref: '#/$defs/apiKeyScheme' },
        { $ref: '#/$defs/bearerScheme' },
        { $ref: '#/$defs/basicScheme' },
      ],
    },
    oauth2Body: {
      type: 'object',
      required: ['authorization_url', 'token_url'],
      properties: {
        authorization_url: { type: 'string', format: 'uri' },
        token_url: { type: 'string', format: 'uri' },
        scopes: { type: 'array', items: { type: 'string' } },
        scope_separator: { type: 'string', default: ' ' },
      },
    },
    oauth2Scheme: {
      type: 'object',
      required: ['type', 'authorization_url', 'token_url'],
      properties: {
        type: { const: 'oauth2' },
        label: { type: 'string' },
        authorization_url: { type: 'string', format: 'uri' },
        token_url: { type: 'string', format: 'uri' },
        scopes: { type: 'array', items: { type: 'string' } },
        scope_separator: { type: 'string', default: ' ' },
      },
    },
    credentialField: {
      type: 'object',
      required: ['name', 'displayName', 'type', 'required'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
        displayName: { type: 'string' },
        type: { enum: ['text', 'password'] },
        required: { type: 'boolean' },
        placeholder: { type: 'string' },
        description: { type: 'string' },
      },
    },
    apiKeyScheme: {
      type: 'object',
      required: ['type', 'fields'],
      properties: {
        type: { const: 'api_key' },
        label: { type: 'string' },
        instructions: { type: 'string' },
        fields: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/credentialField' },
        },
      },
    },
    bearerScheme: {
      type: 'object',
      required: ['type', 'fields'],
      properties: {
        type: { const: 'bearer' },
        label: { type: 'string' },
        instructions: { type: 'string' },
        fields: {
          type: 'array',
          minItems: 1,
          items: { $ref: '#/$defs/credentialField' },
        },
      },
    },
    basicScheme: {
      type: 'object',
      required: ['type', 'fields'],
      properties: {
        type: { const: 'basic' },
        label: { type: 'string' },
        instructions: { type: 'string' },
        fields: {
          type: 'array',
          minItems: 2,
          items: { $ref: '#/$defs/credentialField' },
        },
      },
    },
  },
} as const;
