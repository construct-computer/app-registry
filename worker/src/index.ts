/**
 * Construct App Registry — Cloudflare Worker
 *
 * Read replica of the GitHub registry repo (construct-computer/app-registry).
 * Provides a fast, globally-distributed API for browsing and searching apps.
 *
 * HTML pages (registry.construct.computer):
 *   GET  /                     — Browse/search apps
 *   GET  /apps/:id             — App detail page
 *   GET  /publish              — How to publish an app
 *
 * Public API (no auth, cached):
 *   GET  /v1/apps              — List/search apps
 *   GET  /v1/apps/:id          — App detail + versions
 *   GET  /v1/categories        — Categories with counts
 *   GET  /v1/featured          — Featured apps + collections
 *
 * Authenticated endpoints (sync from GitHub Actions):
 *   POST /v1/sync              — Upsert app data from registry repo
 */

import { withAppUiHeaders } from './lib/security-headers'
import { browsePage, appDetailPage, publishPage } from './pages'
import { APP_HANDLERS } from './apps/registry'
import { handleDevRequest } from './dev'
import { decryptValue } from './lib/crypto'
import { MANIFEST_SCHEMA } from './lib/manifest-schema'
import { CONSTRUCT_SDK_JS, CONSTRUCT_SDK_CSS, SDK_RESPONSE_HEADERS_JS, SDK_RESPONSE_HEADERS_CSS } from './lib/construct-sdk'
import { mintCallToken } from './lib/call-token'
import { logContextFromRequest } from './lib/request-context'
import { logRegistry, maybeTrackDeploy, trackRegistryEvent } from './lib/registry-log'
import {
  ensureHttpsRedirect,
  isSecurityTxtPath,
  securityTxtRedirectResponse,
  withStrictTransportSecurity,
} from './lib/transport-security'

interface Env {
  DB: D1Database
  SYNC_SECRET: string
  ENVIRONMENT: string
  APP_VERSION?: string
  ANALYTICS_QUEUE?: Queue
  // Dev dashboard — GitHub OAuth + session cookies + per-app env var encryption
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  ENV_ENCRYPTION_KEY?: string
  // App gateway wiring (shared with construct worker). Both vars are
  // optional — when either is missing the gateway bridge is simply not
  // exposed to apps on that request, keeping old behavior.
  CALL_TOKEN_SECRET?: string
  GATEWAY_URL?: string
  // Shared secret for worker-to-worker reads (e.g. construct worker
  // fetching permissions.uses for a given app from the registry DB).
  INTERNAL_API_SECRET?: string
  CONSTRUCT_FRAME_ANCESTORS?: string
}

// Headers that must NEVER arrive at a bundled app handler from the outside.
// We strip them on every dispatch so the only place these can be set is
// inside handleAppProxy after we've looked up the caller's real appId.
const INTERNAL_HEADERS_TO_STRIP = [
  'x-construct-env',
  'x-construct-env-sig',
  // Gateway bridge: apps must not be able to forge a call token or
  // redirect the SDK bridge to a different gateway URL.
  'x-construct-call-token',
  'x-construct-gateway',
]

// ── Helpers ──

function json(data: unknown, status = 200, cacheSec = 60): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': status === 200 ? `public, max-age=${cacheSec}` : 'no-store',
    },
  })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status, 0)
}

function buildIconUrl(repoOwner: string, repoName: string, commit: string, iconPath: string): string {
  return `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${commit}/${iconPath}`
}

function iconContentType(iconPath: string): string {
  const ext = iconPath.split('.').pop()?.toLowerCase()
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

function buildScreenshots(repoOwner: string, repoName: string, commit: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${commit}/screenshots/${i + 1}.png`
  )
}

function buildRepoUrl(repoOwner: string, repoName: string): string {
  return `https://github.com/${repoOwner}/${repoName}`
}

interface AppRow {
  id: string
  name: string
  description: string
  long_description: string | null
  author_name: string
  author_url: string | null
  repo_owner: string
  repo_name: string
  icon_path: string
  screenshot_count: number
  category: string
  tags: string
  latest_version: string
  latest_commit: string
  install_count: number
  avg_rating: number
  rating_count: number
  featured: number
  verified: number
  status: string
  has_ui: number
  base_url: string | null
  tools_json: string | null
  permissions_json: string | null
  auth_json: string | null
  subdomain_id: string | null
  subdomain_label: string | null
  created_at: number
  updated_at: number
}

// ── Subdomain helpers ──────────────────────────────────────────────────────

/**
 * App ids that must NEVER be allocated, because their resulting hostname
 * (`${id}-${nanoid}.apps.construct.computer`) would still risk colliding
 * with reserved infrastructure names or just look confusing in URLs.
 * Used at publish time to refuse the upsert.
 */
const RESERVED_SUBDOMAINS = new Set([
  'registry', 'apps', 'api', 'www', 'mail', 'mx', 'auth',
  'cdn', 'static', 'assets', 'docs', 'blog', 'app',
  'beta', 'staging', 'production', 'dev', 'preview',
  'admin', 'dashboard', 'status', 'support',
  '_dmarc', '_domainkey',
])

const NANOID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Generate a 6-char DNS-safe nanoid (lowercase alnum). 36^6 ≈ 2.2B
 * combinations, ample for any registry. crypto.getRandomValues is available
 * in Workers; modulo bias is negligible for non-security uses.
 */
function generateNanoid(length = 6): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += NANOID_ALPHABET[bytes[i] % NANOID_ALPHABET.length]
  return out
}

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}[a-z0-9]?$/

/**
 * An app id is publishable iff it's a valid DNS label, ≤41 chars (so the
 * combined `${id}-${nanoid}` stays comfortably under the 63-char DNS limit),
 * and isn't on the reserved list.
 */
function isPublishableAppId(id: string): boolean {
  return APP_ID_RE.test(id) && !RESERVED_SUBDOMAINS.has(id)
}

function formatApp(app: AppRow, full = false) {
  const base = {
    id: app.id,
    name: app.name,
    description: app.description,
    author: { name: app.author_name, url: app.author_url },
    category: app.category,
    tags: app.tags ? app.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    latest_version: app.latest_version,
    install_count: app.install_count,
    avg_rating: app.avg_rating,
    rating_count: app.rating_count,
    featured: app.featured === 1,
    verified: app.verified === 1,
    has_ui: app.has_ui === 1,
    base_url: app.subdomain_label
      ? `https://${app.subdomain_label}.apps.construct.computer`
      : null,
    icon_url: buildIconUrl(app.repo_owner, app.repo_name, app.latest_commit, app.icon_path),
    repo_url: buildRepoUrl(app.repo_owner, app.repo_name),
    tools: app.tools_json ? JSON.parse(app.tools_json) : [],
    permissions: app.permissions_json ? JSON.parse(app.permissions_json) : {},
    auth: app.auth_json ? JSON.parse(app.auth_json) : null,
  }

  if (!full) return base

  return {
    ...base,
    long_description: app.long_description,
    screenshots: buildScreenshots(app.repo_owner, app.repo_name, app.latest_commit, app.screenshot_count),
    readme_url: `https://raw.githubusercontent.com/${app.repo_owner}/${app.repo_name}/${app.latest_commit}/README.md`,
  }
}

// ── Route Handlers ──

async function listApps(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams.get('q')?.trim()
  const category = url.searchParams.get('category')
  const sort = url.searchParams.get('sort') || 'popular'
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'))
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20')))
  const offset = (page - 1) * limit

  let where = "status = 'active'"
  const params: unknown[] = []

  if (category) {
    where += ' AND category = ?'
    params.push(category)
  }

  if (q) {
    // Simple LIKE search — sufficient for <10K apps
    where += ' AND (name LIKE ? OR description LIKE ? OR tags LIKE ? OR author_name LIKE ?)'
    const pattern = `%${q}%`
    params.push(pattern, pattern, pattern, pattern)
  }

  let orderBy: string
  switch (sort) {
    case 'recent':  orderBy = 'updated_at DESC'; break
    case 'rating':  orderBy = 'avg_rating DESC, rating_count DESC'; break
    case 'name':    orderBy = 'name ASC'; break
    default:        orderBy = 'install_count DESC, avg_rating DESC'; break
  }

  // Count total
  const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM apps WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>()
  const total = countResult?.total || 0

  // Fetch page
  const { results } = await env.DB.prepare(
    `SELECT * FROM apps WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<AppRow>()

  return json({
    apps: (results || []).map(app => formatApp(app)),
    total,
    page,
    pages: Math.ceil(total / limit),
  })
}

async function getApp(id: string, env: Env): Promise<Response> {
  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ? AND status = ?')
    .bind(id, 'active')
    .first<AppRow>()

  if (!app) return error('App not found', 404)

  // Fetch versions
  const { results: versions } = await env.DB.prepare(
    'SELECT version, commit_sha, changelog, published_at FROM app_versions WHERE app_id = ? ORDER BY published_at DESC'
  ).bind(id).all<{ version: string; commit_sha: string; changelog: string | null; published_at: number }>()

  // Fetch review summary
  const { results: reviews } = await env.DB.prepare(
    'SELECT rating, body, user_name, created_at FROM reviews WHERE app_id = ? ORDER BY created_at DESC LIMIT 10'
  ).bind(id).all<{ rating: number; body: string | null; user_name: string | null; created_at: number }>()

  return json({
    ...formatApp(app, true),
    versions: (versions || []).map(v => ({
      version: v.version,
      commit: v.commit_sha,
      changelog: v.changelog,
      date: new Date(v.published_at).toISOString().split('T')[0],
    })),
    reviews: (reviews || []).map(r => ({
      rating: r.rating,
      body: r.body,
      user: r.user_name,
      date: new Date(r.created_at).toISOString().split('T')[0],
    })),
  }, 200, 30)
}

async function getCategories(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT category, COUNT(*) as count FROM apps WHERE status = 'active' GROUP BY category ORDER BY count DESC"
  ).all<{ category: string; count: number }>()

  return json({ categories: results || [] }, 200, 300)
}

async function getFeatured(env: Env): Promise<Response> {
  // Featured apps
  const { results: featuredApps } = await env.DB.prepare(
    "SELECT * FROM apps WHERE featured = 1 AND status = 'active' ORDER BY install_count DESC LIMIT 10"
  ).all<AppRow>()

  // Collections
  const { results: collections } = await env.DB.prepare(
    'SELECT * FROM collections ORDER BY sort_order ASC'
  ).all<{ id: string; name: string; description: string | null; sort_order: number }>()

  const collectionData = []
  for (const col of (collections || [])) {
    const { results: colApps } = await env.DB.prepare(
      `SELECT a.* FROM apps a
       JOIN collection_apps ca ON a.id = ca.app_id
       WHERE ca.collection_id = ? AND a.status = 'active'
       ORDER BY ca.sort_order ASC`
    ).bind(col.id).all<AppRow>()

    collectionData.push({
      id: col.id,
      name: col.name,
      description: col.description,
      apps: (colApps || []).map(app => formatApp(app)),
    })
  }

  return json({
    featured: (featuredApps || []).map(app => formatApp(app)),
    collections: collectionData,
  }, 200, 120)
}

// ── Curated integrations (verified to work with Construct) ──

interface CuratedRow {
  slug: string
  name: string
  description: string
  category: string
  source: string
  icon_url: string | null
  sort_order: number
}

async function getCurated(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM curated_apps ORDER BY category ASC, sort_order ASC'
  ).all<CuratedRow>()

  const apps = (results || []).map(row => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    source: row.source,
    icon_url: row.icon_url,
  }))

  return json({ apps }, 200, 300)
}

// ── Sync endpoint (called by GitHub Actions after merge) ──

interface SyncAppPayload {
  id: string
  name: string
  description: string
  long_description?: string
  author_name: string
  author_url?: string
  repo_owner: string
  repo_name: string
  icon_path: string
  screenshot_count: number
  category: string
  tags: string
  has_ui: boolean
  verified?: boolean
  tools: Array<{ name: string; description: string }>
  permissions: Record<string, unknown>
  auth?: Record<string, unknown> | null
  // GitHub logins listed in manifest.owners[] — these users can manage the
  // app's env vars via the /dev dashboard.
  owners?: string[]
  versions: Array<{
    version: string
    commit: string
    changelog?: string
    manifest: Record<string, unknown>
    date: string
  }>
}

async function syncApps(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const start = Date.now()
  const reqCtx = logContextFromRequest(request)
  // Verify auth
  const auth = request.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${env.SYNC_SECRET}`) {
    return error('Unauthorized', 401)
  }

  let body: {
    apps: SyncAppPayload[]
    collections?: Array<{ id: string; name: string; description?: string; apps: string[] }>
    curated?: Array<{ slug: string; name: string; description: string; category: string; source: string; icon_url?: string; sort_order?: number }>
  }
  try {
    body = await request.json()
  } catch (err) {
    logRegistry(env, ctx, {
      level: 'error',
      source: 'registry.sync',
      message: 'registry_sync_parse_failed',
      error: err,
      request: reqCtx,
      context: { functionality: 'registry_sync', outcome: 'error' },
    })
    return error('Invalid JSON body', 400)
  }

  if (!body.apps || !Array.isArray(body.apps)) {
    return error('Missing apps array')
  }

  const now = Date.now()
  let synced = 0

  try {
  for (const app of body.apps) {
    const latestVersion = app.versions[app.versions.length - 1]
    if (!latestVersion) continue

    // Reject ids that aren't valid as DNS labels or that collide with a
    // reserved subdomain. This protects the wildcard route from squatting.
    if (!isPublishableAppId(app.id)) {
      logRegistry(env, ctx, {
        level: 'warn',
        source: 'registry.sync',
        message: 'registry_sync_rejected_app',
        request: reqCtx,
        context: { functionality: 'registry_sync', app_id: app.id, outcome: 'partial' },
      })
      continue
    }

    // Look up existing subdomain_id; assign one on first publish. The label
    // is stable across version bumps so installed users don't need to update.
    const existing = await env.DB.prepare('SELECT subdomain_id FROM apps WHERE id = ?')
      .bind(app.id)
      .first<{ subdomain_id: string | null }>()

    let subdomainId = existing?.subdomain_id || null
    if (!subdomainId) {
      // Try a few times in the (vanishingly unlikely) event of a collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateNanoid()
        const label = `${app.id}-${candidate}`
        const collision = await env.DB.prepare('SELECT 1 FROM apps WHERE subdomain_label = ?')
          .bind(label).first()
        if (!collision) { subdomainId = candidate; break }
      }
      if (!subdomainId) {
        console.error(`Sync: failed to allocate subdomain_id for "${app.id}"`)
        continue
      }
    }
    const subdomainLabel = `${app.id}-${subdomainId}`
    const baseUrl = `https://${subdomainLabel}.apps.construct.computer`

    // Upsert app
    await env.DB.prepare(`
      INSERT INTO apps (id, name, description, long_description, author_name, author_url,
        repo_owner, repo_name, icon_path, screenshot_count, category, tags,
        latest_version, latest_commit, has_ui, base_url, verified, tools_json, permissions_json, auth_json,
        subdomain_id, subdomain_label,
        status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        long_description = excluded.long_description,
        author_name = excluded.author_name,
        author_url = excluded.author_url,
        repo_owner = excluded.repo_owner,
        repo_name = excluded.repo_name,
        icon_path = excluded.icon_path,
        screenshot_count = excluded.screenshot_count,
        category = excluded.category,
        tags = excluded.tags,
        latest_version = excluded.latest_version,
        latest_commit = excluded.latest_commit,
        has_ui = excluded.has_ui,
        base_url = excluded.base_url,
        verified = excluded.verified,
        tools_json = excluded.tools_json,
        permissions_json = excluded.permissions_json,
        auth_json = excluded.auth_json,
        subdomain_id = excluded.subdomain_id,
        subdomain_label = excluded.subdomain_label,
        updated_at = excluded.updated_at
    `).bind(
      app.id, app.name, app.description, app.long_description || null,
      app.author_name, app.author_url || null,
      app.repo_owner, app.repo_name,
      app.icon_path, app.screenshot_count,
      app.category, app.tags,
      latestVersion.version, latestVersion.commit,
      app.has_ui ? 1 : 0, baseUrl,
      app.verified ? 1 : 0,
      JSON.stringify(app.tools), JSON.stringify(app.permissions),
      app.auth ? JSON.stringify(app.auth) : null,
      subdomainId, subdomainLabel,
      now, now
    ).run()

    // Upsert versions
    for (const ver of app.versions) {
      await env.DB.prepare(`
        INSERT INTO app_versions (app_id, version, commit_sha, changelog, manifest_json, published_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, version) DO UPDATE SET
          commit_sha = excluded.commit_sha,
          changelog = excluded.changelog,
          manifest_json = excluded.manifest_json
      `).bind(
        app.id, ver.version, ver.commit,
        ver.changelog || null,
        JSON.stringify(ver.manifest),
        new Date(ver.date).getTime()
      ).run()
    }

    // Sync owners from manifest (if the table exists — it's added by
    // migration 002). We replace the full set per app so removing a
    // login from manifest.owners[] immediately revokes their dashboard
    // access. Env vars themselves are untouched (they stay in app_env_vars
    // and remain usable by the app runtime until manually deleted).
    if (Array.isArray(app.owners)) {
      const cleaned = app.owners
        .map((o) => String(o).trim().replace(/^@/, '').toLowerCase())
        .filter((o) => {
          if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(o)) {
            console.warn(`Sync: owner "${o}" for app ${app.id} does not match login pattern — skipping`)
            return false
          }
          return true
        })
      try {
        await env.DB.prepare('DELETE FROM app_owners WHERE app_id = ?').bind(app.id).run()
        for (const login of cleaned) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO app_owners (app_id, github_login, added_at) VALUES (?, ?, ?)`,
          ).bind(app.id, login, now).run()
        }
      } catch (err) {
        // Table may not exist yet if migration 002 hasn't run; don't block sync.
        console.warn(`owners sync skipped for ${app.id}:`, err instanceof Error ? err.message : err)
      }
    }

    synced++
  }

  // Sync collections if provided
  if (body.collections) {
    for (const col of body.collections) {
      await env.DB.prepare(`
        INSERT INTO collections (id, name, description, sort_order)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description
      `).bind(col.id, col.name, col.description || null).run()

      // Clear + re-insert apps
      await env.DB.prepare('DELETE FROM collection_apps WHERE collection_id = ?').bind(col.id).run()
      for (let i = 0; i < col.apps.length; i++) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO collection_apps (collection_id, app_id, sort_order) VALUES (?, ?, ?)'
        ).bind(col.id, col.apps[i], i).run()
      }
    }
  }

  // Sync curated integrations if provided (full replace)
  if (body.curated && Array.isArray(body.curated)) {
    await env.DB.prepare('DELETE FROM curated_apps').run()
    for (const c of body.curated) {
      await env.DB.prepare(`
        INSERT INTO curated_apps (slug, name, description, category, source, icon_url, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        c.slug, c.name, c.description, c.category,
        c.source || 'composio', c.icon_url || null,
        c.sort_order ?? 0, now
      ).run()
    }
  }

  } catch (err) {
    const syncDuration = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    logRegistry(env, ctx, {
      level: 'error',
      source: 'registry.sync',
      message: 'registry_sync_failed',
      error: err,
      request: reqCtx,
      context: {
        functionality: 'registry_sync',
        outcome: 'error',
        duration_ms: syncDuration,
        error_message: msg,
      },
    })
    return error(`Sync failed: ${msg}`, 500)
  }

  const syncDuration = Date.now() - start
  trackRegistryEvent(env, ctx, {
    event: 'system_event',
    trigger: 'platform',
    name: 'registry_sync',
    source: 'registry.sync',
    detail: {
      functionality: 'registry_sync',
      outcome: 'success',
      duration_ms: syncDuration,
      apps_synced: synced,
    },
  })
  return json({ ok: true, synced })
}

// ── Increment install count (called by Construct backend) ──

async function incrementInstall(id: string, env: Env): Promise<Response> {
  await env.DB.prepare('UPDATE apps SET install_count = install_count + 1 WHERE id = ?').bind(id).run()
  return json({ ok: true })
}

// SDK constants live in ./lib/construct-sdk so they can be served both from
// the registry host (stable canonical URL) and from per-app subdomains.
// See that module for the actual SDK source strings.

// ── App Runtime Proxy (*.apps.construct.computer) ──

const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-construct-auth, x-construct-user',
}

/**
 * Fetch and decrypt env vars scoped to a single app, then return a Request
 * with stripped incoming `x-construct-env*` and a freshly set internal
 * header containing ONLY this app's variables.
 *
 * We always strip the inbound headers — even when the app has no env vars —
 * so a caller can't poison other apps' state by pre-setting them.
 *
 * Values are never logged and never attached to the Worker's top-level env
 * binding; they live only on the Request instance passed to this one app's
 * handler.
 */
async function buildScopedRequest(appId: string, request: Request, env: Env): Promise<Request> {
  const headers = new Headers(request.headers)
  for (const h of INTERNAL_HEADERS_TO_STRIP) headers.delete(h)

  let envObj: Record<string, string> | null = null
  try {
    const { results } = await env.DB.prepare(
      `SELECT name, value_encrypted FROM app_env_vars WHERE app_id = ?`,
    ).bind(appId).all<{ name: string; value_encrypted: string }>()

    if (results && results.length > 0) {
      if (!env.ENV_ENCRYPTION_KEY) {
        console.error(`App ${appId} has env vars but ENV_ENCRYPTION_KEY is not set`)
      } else {
        envObj = {}
        for (const row of results) {
          try {
            envObj[row.name] = await decryptValue(row.value_encrypted, env.ENV_ENCRYPTION_KEY)
          } catch (err) {
            console.error(`Failed to decrypt ${appId}.${row.name}:`, err)
          }
        }
      }
    }
  } catch (err) {
    console.error(`Failed to load env for ${appId}:`, err)
  }

  if (envObj && Object.keys(envObj).length > 0) {
    // base64-encoded JSON (easier for app handlers to parse than raw JSON,
    // and keeps arbitrary byte values safe for HTTP headers).
    const json = JSON.stringify(envObj)
    const b64 = btoa(unescape(encodeURIComponent(json)))
    headers.set('x-construct-env', b64)
  }

  // App-gateway bridge: mint a short-lived call token so `ctx.construct.*`
  // works inside the app handler. We only mint when:
  //   - both the secret and gateway URL are configured, AND
  //   - the caller supplied x-construct-user (no user = no bridge).
  // App→app dispatches already carry a token with depth>0; the gateway
  // re-mints for the inner call with its own depth, so we do not need to
  // preserve inbound tokens here.
  const userId = request.headers.get('x-construct-user')
  if (userId && env.CALL_TOKEN_SECRET && env.GATEWAY_URL) {
    try {
      const token = await mintCallToken(env.CALL_TOKEN_SECRET, {
        userId,
        appId,
        depth: 0,
      })
      headers.set('x-construct-call-token', token)
      headers.set('x-construct-gateway', env.GATEWAY_URL)
    } catch (err) {
      console.error(`Failed to mint call token for ${appId}:`, err)
    }
  }

  // Preserve method/body; we only rewrote headers.
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-ignore — duplex is required in some runtimes when body is a stream
    duplex: 'half',
  })
}

async function handleAppProxy(appId: string, subpath: string, request: Request, env: Env): Promise<Response> {
  // Construct SDK — served for app UIs (host-prefixed under each app's
  // subdomain so the SDK loads with the same origin as the app).
  if (subpath.startsWith('/sdk/')) {
    const file = subpath.replace('/sdk/', '')
    if (file === 'construct.css') {
      return new Response(CONSTRUCT_SDK_CSS, { headers: SDK_RESPONSE_HEADERS_CSS })
    }
    if (file === 'construct.js') {
      return new Response(CONSTRUCT_SDK_JS, { headers: SDK_RESPONSE_HEADERS_JS })
    }
    return new Response('Not found', { status: 404 })
  }

  // Health check
  if (subpath === '/health') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  // MCP endpoint — call bundled app handler directly.
  //
  // Per-app env vars arrive here via the x-construct-env header. Isolation
  // model: we strip any inbound x-construct-env (so an outside caller can
  // never spoof another app's env), then look up THIS app's env vars only
  // (scoped by appId from the router, not from anything app code can set),
  // decrypt with ENV_ENCRYPTION_KEY, and hand the new Request to the
  // targeted app handler. Values never touch the global Worker env binding,
  // and a second app's handler never receives a Request that carries
  // another app's env.
  if (subpath === '/mcp' && request.method === 'POST') {
    const handler = APP_HANDLERS[appId]
    if (!handler) {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: `App "${appId}" is not installed on this server.` } },
        { status: 404, headers: CORS_HEADERS },
      )
    }

    const scopedRequest = await buildScopedRequest(appId, request, env)

    try {
      const response = await handler(scopedRequest)
      // Add CORS headers to the response
      const body = await response.text()
      return new Response(body, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: `App "${appId}" error: ${msg}` } },
        { status: 500, headers: CORS_HEADERS },
      )
    }
  }

  // UI files — proxy from GitHub raw content at pinned commit
  if (subpath.startsWith('/ui/') || subpath === '/ui') {
    const app = await env.DB.prepare('SELECT repo_owner, repo_name, latest_commit FROM apps WHERE id = ?')
      .bind(appId).first<{ repo_owner: string; repo_name: string; latest_commit: string }>()

    if (!app) {
      return Response.json({ error: `App "${appId}" not found` }, { status: 404, headers: CORS_HEADERS })
    }

    // Map /ui/ to /ui/index.html
    let filePath = subpath === '/ui' || subpath === '/ui/' ? '/ui/index.html' : subpath
    const rawUrl = `https://raw.githubusercontent.com/${app.repo_owner}/${app.repo_name}/${app.latest_commit}${filePath}`

    try {
      const res = await fetch(rawUrl)
      if (!res.ok) {
        return new Response('File not found', { status: 404, headers: CORS_HEADERS })
      }

      // Determine content type
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const contentTypes: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8',
        js: 'application/javascript; charset=utf-8',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
        woff2: 'font/woff2',
        woff: 'font/woff',
      }

      const contentType = contentTypes[ext] || 'application/octet-stream';
      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      };

      return new Response(res.body, {
        headers: ext === 'html'
          ? withAppUiHeaders(responseHeaders, env)
          : responseHeaders,
      })
    } catch {
      return new Response('Failed to fetch UI', { status: 502, headers: CORS_HEADERS })
    }
  }

  // Icon
  if (subpath === '/icon' || /^\/icon\.(png|svg|jpe?g|webp)$/.test(subpath)) {
    const app = await env.DB.prepare('SELECT repo_owner, repo_name, latest_commit, icon_path FROM apps WHERE id = ?')
      .bind(appId).first<{ repo_owner: string; repo_name: string; latest_commit: string; icon_path: string }>()
    if (!app) return new Response('Not found', { status: 404 })
    const rawUrl = `https://raw.githubusercontent.com/${app.repo_owner}/${app.repo_name}/${app.latest_commit}/${app.icon_path}`
    const res = await fetch(rawUrl)
    return new Response(res.body, {
      headers: { 'Content-Type': iconContentType(app.icon_path), 'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS },
    })
  }

  return Response.json(
    { error: 'Not found' },
    { status: 404, headers: CORS_HEADERS },
  )
}

// ── Main Router ──

async function appFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-construct-auth, x-construct-user',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    const url = new URL(request.url)
    const path = url.pathname
    const hostname = url.hostname

    try {
      // ── Per-app subdomain — `${id}-${nanoid}.apps.construct.computer` ─
      // The wildcard `*.apps.construct.computer/*` route catches one-level
      // sub-subdomains under `apps.construct.computer`. We dispatch by
      // hostname:
      //   - `<id>-<nanoid>.apps.construct.computer` → handleAppProxy
      //   - `registry.construct.computer`           → fall through to HTML + API
      //   - anything else                            → 421 (defense-in-depth;
      //     should not normally reach this worker)
      //
      // The wildcard intentionally lives at `.apps.construct.computer` (one
      // level below the apex) so it never collides with first-level
      // construct hostnames like `staging.construct.computer` or
      // `beta.construct.computer`, which are owned by the construct worker
      // via `custom_domain = true`. The previous `*.construct.computer/*`
      // wildcard caused exactly that collision.
      const APP_HOST_SUFFIX = '.apps.construct.computer'
      if (hostname.endsWith(APP_HOST_SUFFIX)) {
        const label = hostname.slice(0, -APP_HOST_SUFFIX.length)
        if (label && !label.includes('.')) {
          const app = await env.DB.prepare(
            "SELECT id FROM apps WHERE subdomain_label = ? AND status = 'active'"
          ).bind(label).first<{ id: string }>()
          if (app) {
            return await handleAppProxy(app.id, path || '/', request, env)
          }
          return new Response('App not found', { status: 404, headers: CORS_HEADERS })
        }
        // Multi-level or empty label — not a valid app subdomain.
        return new Response('Not found', { status: 404, headers: CORS_HEADERS })
      }

      // Reject any other construct.computer hostname that somehow reaches
      // this worker — only `registry.construct.computer` is legitimately
      // served from here. Defense-in-depth in case stale route bindings
      // leak traffic across workers.
      if (hostname !== 'registry.construct.computer' && hostname.endsWith('.construct.computer')) {
        return new Response(
          `Misdirected request: ${hostname} is not served by the app registry.`,
          {
            status: 421,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
          },
        )
      }

      // Developer dashboard — /dev/* on registry.construct.computer. Needs
      // GITHUB_CLIENT_ID/SECRET + SESSION_SECRET + ENV_ENCRYPTION_KEY; if
      // those aren't set the handler returns a clear 503.
      if (path === '/dev' || path.startsWith('/dev/')) {
        if (
          !env.DB ||
          !env.SESSION_SECRET ||
          !env.ENV_ENCRYPTION_KEY ||
          !env.GITHUB_CLIENT_ID ||
          !env.GITHUB_CLIENT_SECRET
        ) {
          return new Response(
            'Developer dashboard is not configured on this worker. Required secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, ENV_ENCRYPTION_KEY.',
            { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
          )
        }
        return await handleDevRequest(request, {
          DB: env.DB,
          GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
          GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
          SESSION_SECRET: env.SESSION_SECRET,
          ENV_ENCRYPTION_KEY: env.ENV_ENCRYPTION_KEY,
        }, url, ctx, env)
      }

      // HTML pages — registry.construct.computer only.
      if (request.method === 'GET') {
        if (path === '/')               return await browsePage(url, env)
        if (path === '/publish')        return publishPage()

        // JSON Schema for manifest.json. Referenced via the `$schema` field
        // in app manifests; cached aggressively since it changes rarely.
        if (path === '/schemas/manifest.json') {
          return new Response(JSON.stringify(MANIFEST_SCHEMA, null, 2), {
            status: 200,
            headers: {
              'Content-Type': 'application/schema+json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=3600',
            },
          })
        }

        // Construct SDK — canonical cross-origin URL that app UIs load
        // directly (in both local dev and production). CORS is open so
        // any app origin (localhost:8787, cloudflared tunnel, or the
        // published subdomain) can fetch it.
        if (path === '/sdk/construct.js') {
          return new Response(CONSTRUCT_SDK_JS, { status: 200, headers: SDK_RESPONSE_HEADERS_JS })
        }
        if (path === '/sdk/construct.css') {
          return new Response(CONSTRUCT_SDK_CSS, { status: 200, headers: SDK_RESPONSE_HEADERS_CSS })
        }

        // /apps/:id (HTML detail page — no /v1/ prefix)
        const htmlAppMatch = path.match(/^\/apps\/([a-z0-9-]+)$/)
        if (htmlAppMatch)               return await appDetailPage(htmlAppMatch[1], env)
      }

      // Public API endpoints
      if (request.method === 'GET') {
        if (path === '/v1/apps')        return await listApps(url, env)
        if (path === '/v1/curated')     return await getCurated(env)
        if (path === '/v1/categories')  return await getCategories(env)
        if (path === '/v1/featured')    return await getFeatured(env)

        // /v1/apps/:id
        const appMatch = path.match(/^\/v1\/apps\/([a-z0-9-]+)$/)
        if (appMatch) return await getApp(appMatch[1], env)

        // /v1/apps/:id/download — return repo tarball URL for a version
        const dlMatch = path.match(/^\/v1\/apps\/([a-z0-9-]+)\/download(?:\/(.+))?$/)
        if (dlMatch) {
          const appId = dlMatch[1]
          const version = dlMatch[2]

          let ver: { commit_sha: string } | null
          if (version) {
            ver = await env.DB.prepare('SELECT commit_sha FROM app_versions WHERE app_id = ? AND version = ?')
              .bind(appId, version).first()
          } else {
            const app = await env.DB.prepare('SELECT latest_commit as commit_sha, repo_owner, repo_name FROM apps WHERE id = ?')
              .bind(appId).first<{ commit_sha: string; repo_owner: string; repo_name: string }>()
            ver = app
          }

          if (!ver) return error('Version not found', 404)

          const app = await env.DB.prepare('SELECT repo_owner, repo_name FROM apps WHERE id = ?')
            .bind(appId).first<{ repo_owner: string; repo_name: string }>()
          if (!app) return error('App not found', 404)

          // Increment install count
          await env.DB.prepare('UPDATE apps SET install_count = install_count + 1 WHERE id = ?').bind(appId).run()

          const tarballUrl = `https://github.com/${app.repo_owner}/${app.repo_name}/archive/${ver.commit_sha}.tar.gz`
          return Response.redirect(tarballUrl, 302)
        }
      }

      // Authenticated sync endpoint
      if (request.method === 'POST' && path === '/v1/sync') {
        return await syncApps(request, env, ctx)
      }

      // Internal: permissions.uses for a given app. Called by the
      // construct worker's gateway before dispatching tool/app calls.
      // Authenticated with the shared INTERNAL_API_SECRET. Not cached
      // at the edge — the construct worker holds its own short-lived
      // in-memory cache.
      if (request.method === 'GET') {
        const permsMatch = path.match(/^\/internal\/permissions\/([a-z0-9-]+)$/)
        if (permsMatch) {
          if (!env.INTERNAL_API_SECRET) {
            return error('Internal API not configured', 503)
          }
          const auth = request.headers.get('Authorization')
          if (auth !== `Bearer ${env.INTERNAL_API_SECRET}`) return error('Unauthorized', 401)

          const appId = permsMatch[1]
          const row = await env.DB.prepare(
            'SELECT permissions_json, subdomain_label FROM apps WHERE id = ? AND status = ?'
          ).bind(appId, 'active').first<{ permissions_json: string | null; subdomain_label: string | null }>()

          if (!row) return error('App not found', 404)

          const permissions = row.permissions_json ? JSON.parse(row.permissions_json) as Record<string, unknown> : {}
          const uses = (permissions.uses ?? {}) as Record<string, unknown>
          const base_url = row.subdomain_label
            ? `https://${row.subdomain_label}.apps.construct.computer`
            : null
          return json({ app_id: appId, uses, base_url }, 200, 0)
        }
      }

      // Install count bump (fire-and-forget from backend)
      if (request.method === 'POST') {
        const bumpMatch = path.match(/^\/v1\/apps\/([a-z0-9-]+)\/installed$/)
        if (bumpMatch) return await incrementInstall(bumpMatch[1], env)
      }

      // Update tool definitions (called by CI/CD after deploy)
      if (request.method === 'POST') {
        const toolsMatch = path.match(/^\/v1\/apps\/([a-z0-9-]+)\/tools$/)
        if (toolsMatch) {
          const auth = request.headers.get('Authorization')
          if (auth !== `Bearer ${env.SYNC_SECRET}`) return error('Unauthorized', 401)
          const appId = toolsMatch[1]
          const tools = await request.json() as Array<{ name: string; description: string }>
          await env.DB.prepare('UPDATE apps SET tools_json = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(tools), Date.now(), appId).run()
          return json({ ok: true, app: appId, tools: tools.length })
        }
      }

      // Health check
      if (path === '/health') {
        return json({ status: 'ok', timestamp: new Date().toISOString() })
      }

      return error('Not found', 404)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logRegistry(env, ctx, {
        level: 'error',
        source: 'registry.http',
        message: 'worker_error',
        error: err,
        request: logContextFromRequest(request),
        context: { functionality: 'http', outcome: 'error', path, error_message: msg },
      })
      return error(`Internal server error: ${msg}`, 500)
    }
  }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    maybeTrackDeploy(env, ctx)

    const httpsRedirect = ensureHttpsRedirect(request)
    if (httpsRedirect) return httpsRedirect

    const url = new URL(request.url)
    if (isSecurityTxtPath(url.pathname)) {
      return securityTxtRedirectResponse()
    }

    const response = await appFetch(request, env, ctx)
    return withStrictTransportSecurity(response, request)
  },
}
