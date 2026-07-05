# Agent Instructions

## Core Commands
- `pnpm dev`: Run local dev server via `wrangler dev`.
- `pnpm deploy`: Deploy via `wrangler deploy`.
- `pnpm db:migrate`: Apply D1 migrations to the registry database.
- `pnpm prepare`: Run `node scripts/stub-registry.mjs`.

## Architecture & Purpose
- **Purpose**: Manages app manifests (JSON), collections, and the registry runtime for apps.
- **Deployment**: Deploys to `registry.construct.computer` and `apps.construct.computer`.
- **Stack**: Cloudflare Workers, D1, TypeScript.
- **Key Files**:
  - `src/apps/registry.ts`: The core registry runtime.
  - `apps/*.json`: App manifests.
  - `collections/*.json`: Curated app collections.

## Notes
- This is a submodule of the monorepo.
- Uses `@construct-computer/app-sdk`.
- Observability: pin `@construct/observability` to `#d3607bb` (same as construct worker). Emit errors with `log()` and success metrics with `track()`; `SERVICE_NAME=construct-app-registry`. Wrangler binds `ANALYTICS_QUEUE` → `construct-analytics`. See `construct/worker/docs/logging-policy.md`.
