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

import { browsePage, appDetailPage, publishPage } from './pages'

interface Env {
  DB: D1Database
  SYNC_SECRET: string
  ENVIRONMENT: string
}

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
  created_at: number
  updated_at: number
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
    base_url: app.base_url || `https://${app.id}.apps.construct.computer`,
    icon_url: buildIconUrl(app.repo_owner, app.repo_name, app.latest_commit, app.icon_path),
    repo_url: buildRepoUrl(app.repo_owner, app.repo_name),
    tools: app.tools_json ? JSON.parse(app.tools_json) : [],
    permissions: app.permissions_json ? JSON.parse(app.permissions_json) : {},
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
  versions: Array<{
    version: string
    commit: string
    changelog?: string
    manifest: Record<string, unknown>
    date: string
  }>
}

async function syncApps(request: Request, env: Env): Promise<Response> {
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
    console.error('Failed to parse sync body:', err)
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

    // Upsert app
    await env.DB.prepare(`
      INSERT INTO apps (id, name, description, long_description, author_name, author_url,
        repo_owner, repo_name, icon_path, screenshot_count, category, tags,
        latest_version, latest_commit, has_ui, base_url, verified, tools_json, permissions_json,
        status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
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
        updated_at = excluded.updated_at
    `).bind(
      app.id, app.name, app.description, app.long_description || null,
      app.author_name, app.author_url || null,
      app.repo_owner, app.repo_name,
      app.icon_path, app.screenshot_count,
      app.category, app.tags,
      latestVersion.version, latestVersion.commit,
      app.has_ui ? 1 : 0, `https://${app.id}.apps.construct.computer`,
      app.verified ? 1 : 0,
      JSON.stringify(app.tools), JSON.stringify(app.permissions),
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
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Sync D1 error:', msg, err)
    return error(`Sync failed: ${msg}`, 500)
  }

  return json({ ok: true, synced })
}

// ── Increment install count (called by Construct backend) ──

async function incrementInstall(id: string, env: Env): Promise<Response> {
  await env.DB.prepare('UPDATE apps SET install_count = install_count + 1 WHERE id = ?').bind(id).run()
  return json({ ok: true })
}

// ── Main Router ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    const url = new URL(request.url)
    const path = url.pathname

    try {
      // HTML pages — registry.construct.computer
      if (request.method === 'GET') {
        if (path === '/')               return await browsePage(url, env)
        if (path === '/publish')        return publishPage()

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
        return await syncApps(request, env)
      }

      // Install count bump (fire-and-forget from backend)
      if (request.method === 'POST') {
        const bumpMatch = path.match(/^\/v1\/apps\/([a-z0-9-]+)\/installed$/)
        if (bumpMatch) return await incrementInstall(bumpMatch[1], env)
      }

      // Health check
      if (path === '/health') {
        return json({ status: 'ok', timestamp: new Date().toISOString() })
      }

      return error('Not found', 404)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Worker error:', msg, err)
      return error(`Internal server error: ${msg}`, 500)
    }
  },
}
// deploy test
