/**
 * Server-rendered HTML pages for the Construct App Registry.
 *
 * Routes:
 *   GET /              — Browse apps (search, categories, grid)
 *   GET /apps/:id      — App detail page
 *   GET /publish       — How to publish an app
 */

import { layout, escapeHtml as esc } from './lib/ui';
import { withRegistryHtmlHeaders } from './lib/security-headers';

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: withRegistryHtmlHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    }),
  })
}

function stars(rating: number): string {
  const full = Math.floor(rating)
  const half = rating - full >= 0.5 ? 1 : 0
  const empty = 5 - full - half
  return '<span class="stars">' +
    '★'.repeat(full) +
    (half ? '½' : '') +
    '<span class="star-empty">' + '★'.repeat(empty) + '</span>' +
    '</span>'
}

function formatCount(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

interface AppData {
  id: string
  name: string
  description: string
  long_description?: string | null
  author: { name: string; url?: string | null }
  category: string
  tags: string[]
  latest_version: string
  install_count: number
  avg_rating: number
  rating_count: number
  featured: boolean
  verified: boolean
  has_ui: boolean
  icon_url: string
  repo_url: string
  tools: Array<{ name: string; description: string }>
  permissions: Record<string, unknown>
  auth?: Record<string, unknown> | null
  screenshots?: string[]
  readme_url?: string
  versions?: Array<{ version: string; commit: string; changelog?: string | null; date: string }>
  reviews?: Array<{ rating: number; body?: string | null; user?: string | null; date: string }>
}

// ── App card component ──

function appCard(app: AppData): string {
  const tagBadges = app.tags.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')
  return `
    <a href="/apps/${esc(app.id)}" class="app-card">
      <img class="app-icon" src="${esc(app.icon_url)}" alt="${esc(app.name)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%2216%22 fill=%22%2327272a%22/><text x=%2240%22 y=%2248%22 text-anchor=%22middle%22 font-size=%2232%22>📦</text></svg>'">
      <div class="app-info">
        <div class="app-name">${esc(app.name)}</div>
        <div class="app-desc">${esc(app.description)}</div>
        <div class="app-meta">
          ${app.rating_count > 0 ? `${stars(app.avg_rating)} <span class="meta-sep">&middot;</span>` : ''}
          <span>${formatCount(app.install_count)} installs</span>
          <span class="meta-sep">&middot;</span>
          <span>${esc(app.category)}</span>
          ${app.has_ui ? '<span class="badge-ui">GUI</span>' : ''}
          ${app.auth ? `<span class="badge-auth">${app.auth.oauth2 ? 'OAuth' : app.auth.apiKey ? 'API Key' : 'Auth'}</span>` : ''}
        </div>
      </div>
    </a>`
}

// ── Page: Browse ──

export async function browsePage(url: URL, env: { DB: D1Database }): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() || ''
  const category = url.searchParams.get('category') || ''
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'))
  const limit = 24
  const offset = (page - 1) * limit

  let where = "status = 'active'"
  const params: unknown[] = []

  if (category) {
    where += ' AND category = ?'
    params.push(category)
  }
  if (q) {
    where += ' AND (name LIKE ? OR description LIKE ? OR tags LIKE ? OR author_name LIKE ?)'
    const p = `%${q}%`
    params.push(p, p, p, p)
  }

  const countRow = await env.DB.prepare(`SELECT COUNT(*) as total FROM apps WHERE ${where}`)
    .bind(...params).first<{ total: number }>()
  const total = countRow?.total || 0

  const { results } = await env.DB.prepare(
    `SELECT * FROM apps WHERE ${where} ORDER BY install_count DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()

  // Categories for sidebar
  const { results: cats } = await env.DB.prepare(
    "SELECT category, COUNT(*) as count FROM apps WHERE status = 'active' GROUP BY category ORDER BY count DESC"
  ).all<{ category: string; count: number }>()

  const apps: AppData[] = (results || []).map((r: any) => ({
    id: r.id, name: r.name, description: r.description,
    author: { name: r.author_name, url: r.author_url },
    category: r.category,
    tags: r.tags ? r.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
    latest_version: r.latest_version, install_count: r.install_count,
    avg_rating: r.avg_rating, rating_count: r.rating_count,
    featured: r.featured === 1, verified: r.verified === 1, has_ui: r.has_ui === 1,
    icon_url: `https://raw.githubusercontent.com/${r.repo_owner}/${r.repo_name}/${r.latest_commit}/${r.icon_path}`,
    repo_url: `https://github.com/${r.repo_owner}/${r.repo_name}`,
    tools: r.tools_json ? JSON.parse(r.tools_json) : [],
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : {},
  }))

  // Fetch featured apps for the hero section
  const { results: featuredResults } = await env.DB.prepare(
    "SELECT * FROM apps WHERE featured = 1 AND status = 'active' ORDER BY install_count DESC LIMIT 6"
  ).all()
  
  const featuredApps: AppData[] = (featuredResults || []).map((r: any) => ({
    id: r.id, name: r.name, description: r.description,
    author: { name: r.author_name, url: r.author_url },
    category: r.category,
    tags: r.tags ? r.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
    latest_version: r.latest_version, install_count: r.install_count,
    avg_rating: r.avg_rating, rating_count: r.rating_count,
    featured: r.featured === 1, verified: r.verified === 1, has_ui: r.has_ui === 1,
    icon_url: `https://raw.githubusercontent.com/${r.repo_owner}/${r.repo_name}/${r.latest_commit}/${r.icon_path}`,
    repo_url: `https://github.com/${r.repo_owner}/${r.repo_name}`,
    tools: r.tools_json ? JSON.parse(r.tools_json) : [],
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : {},
  }))

  const pages = Math.ceil(total / limit)

  const categoryLinks = (cats || []).map((c: any) =>
    `<a href="/?category=${esc(c.category)}" class="cat-link ${category === c.category ? 'active' : ''}">${esc(c.category)} <span class="cat-count">${c.count}</span></a>`
  ).join('')

  const appGrid = apps.length > 0
    ? `<div class="app-grid">${apps.map(appCard).join('')}</div>`
    : `<div class="empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <p>No apps found${q ? ` for "${esc(q)}"` : ''}${category ? ` in ${esc(category)}` : ''}.</p>
       </div>`

  const pagination = pages > 1 ? `
    <div class="pagination">
      ${page > 1 ? `<a href="/?${new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}), page: String(page - 1) }).toString()}">&larr; Previous</a>` : '<span></span>'}
      <span class="page-info">Page ${page} of ${pages}</span>
      ${page < pages ? `<a href="/?${new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}), page: String(page + 1) }).toString()}">Next &rarr;</a>` : '<span></span>'}
    </div>` : ''

  const featuredSection = (!q && !category && featuredApps.length > 0) ? `
    <section class="featured-section">
      <div class="featured-header">
        <h2>Featured Apps</h2>
        <span class="featured-badge">Curated</span>
      </div>
      <div class="featured-grid">
        ${featuredApps.map(app => `
          <a href="/apps/${esc(app.id)}" class="featured-card">
            <img class="featured-icon" src="${esc(app.icon_url)}" alt="${esc(app.name)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%2216%22 fill=%22%2327272a%22/><text x=%2240%22 y=%2248%22 text-anchor=%22middle%22 font-size=%2232%22>📦</text></svg>'">
            <div class="featured-info">
              <div class="featured-name">${esc(app.name)} ${app.verified ? '<span class="verified-badge" title="Verified">✓</span>' : ''}</div>
              <div class="featured-desc">${esc(app.description)}</div>
              <div class="featured-meta">
                ${app.rating_count > 0 ? `${stars(app.avg_rating)} ·` : ''}
                ${formatCount(app.install_count)} installs
              </div>
            </div>
          </a>
        `).join('')}
      </div>
    </section>
  ` : ''

  const categoryChips = (cats || []).length > 0 ? `
    <div class="category-chips">
      <a href="/" class="chip ${!category ? 'active' : ''}">All</a>
      ${(cats || []).map((c: any) => `
        <a href="/?category=${esc(c.category)}" class="chip ${category === c.category ? 'active' : ''}">${esc(c.category)}</a>
      `).join('')}
    </div>
  ` : ''

  const content = `
    <div class="hero">
      <h1>Discover apps for your AI desktop</h1>
      <p class="hero-subtitle">Browse ${total}+ apps and integrations for Construct</p>
      <form class="search-form" action="/" method="get">
        ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
        <div class="search-box">
          <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" name="q" value="${esc(q)}" placeholder="Search apps..." autocomplete="off">
        </div>
      </form>
      ${categoryChips}
    </div>
    ${featuredSection}
    <div class="browse-layout">
      <aside class="sidebar">
        <h3>Categories</h3>
        <a href="/" class="cat-link ${!category ? 'active' : ''}">All apps <span class="cat-count">${total}</span></a>
        ${categoryLinks}
      </aside>
      <section class="browse-main">
        <div class="browse-header">
          <h2>${category ? esc(category) : q ? `Results for "${esc(q)}"` : 'All Apps'}</h2>
          <span class="result-count">${total} app${total !== 1 ? 's' : ''}</span>
        </div>
        ${appGrid}
        ${pagination}
      </section>
    </div>`

  return html(layout(category || q || 'Browse Apps', content, { activePage: 'browse' }))
}

// ── Page: App Detail ──

export async function appDetailPage(appId: string, env: { DB: D1Database }): Promise<Response> {
  const r: any = await env.DB.prepare("SELECT * FROM apps WHERE id = ? AND status = 'active'")
    .bind(appId).first()
  if (!r) return html(layout('Not Found', '<div class="container"><h1>App not found</h1><p><a href="/">Back to browse</a></p></div>'), 404)

  const raw = `https://raw.githubusercontent.com/${r.repo_owner}/${r.repo_name}/${r.latest_commit}`

  const app: AppData = {
    id: r.id, name: r.name, description: r.description,
    long_description: r.long_description,
    author: { name: r.author_name, url: r.author_url },
    category: r.category,
    tags: r.tags ? r.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
    latest_version: r.latest_version, install_count: r.install_count,
    avg_rating: r.avg_rating, rating_count: r.rating_count,
    featured: r.featured === 1, verified: r.verified === 1, has_ui: r.has_ui === 1,
    icon_url: `${raw}/${r.icon_path}`,
    repo_url: `https://github.com/${r.repo_owner}/${r.repo_name}`,
    tools: r.tools_json ? JSON.parse(r.tools_json) : [],
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : {},
    screenshots: Array.from({ length: r.screenshot_count }, (_, i) => `${raw}/screenshots/${i + 1}.png`),
    readme_url: `${raw}/README.md`,
  }

  // Versions
  const { results: versions } = await env.DB.prepare(
    'SELECT version, commit_sha, changelog, published_at FROM app_versions WHERE app_id = ? ORDER BY published_at DESC'
  ).bind(appId).all()
  app.versions = (versions || []).map((v: any) => ({
    version: v.version, commit: v.commit_sha, changelog: v.changelog,
    date: new Date(v.published_at).toISOString().split('T')[0],
  }))

  // Reviews
  const { results: reviews } = await env.DB.prepare(
    'SELECT rating, body, user_name, created_at FROM reviews WHERE app_id = ? ORDER BY created_at DESC LIMIT 10'
  ).bind(appId).all()
  app.reviews = (reviews || []).map((rv: any) => ({
    rating: rv.rating, body: rv.body, user: rv.user_name,
    date: new Date(rv.created_at).toISOString().split('T')[0],
  }))

  const toolsList = app.tools.length > 0 ? `
    <div class="detail-section">
      <h3>Tools (${app.tools.length})</h3>
      <div class="tools-list">
        ${app.tools.map(t => `<div class="tool-item"><code>${esc(t.name)}</code><span>${esc(t.description)}</span></div>`).join('')}
      </div>
    </div>` : ''

  const permsList = Object.keys(app.permissions).length > 0 ? `
    <div class="detail-section">
      <h3>Permissions</h3>
      <div class="perms-list">
        ${Object.entries(app.permissions).map(([k, v]) =>
          `<div class="perm-item"><span class="perm-key">${esc(k)}</span><span class="perm-val">${esc(Array.isArray(v) ? v.join(', ') : String(v))}</span></div>`
        ).join('')}
      </div>
    </div>` : ''

  const screenshotsHtml = (app.screenshots || []).length > 0 ? `
    <div class="detail-section">
      <h3>Screenshots</h3>
      <div class="screenshots">
        ${(app.screenshots || []).map(s => `<img src="${esc(s)}" alt="Screenshot" loading="lazy">`).join('')}
      </div>
    </div>` : ''

  const versionsHtml = (app.versions || []).length > 0 ? `
    <div class="detail-section">
      <h3>Versions</h3>
      <div class="versions-list">
        ${(app.versions || []).map(v => `
          <div class="version-item">
            <div class="version-head">
              <strong>v${esc(v.version)}</strong>
              <span class="version-date">${esc(v.date)}</span>
            </div>
            ${v.changelog ? `<p class="version-changelog">${esc(v.changelog)}</p>` : ''}
          </div>
        `).join('')}
      </div>
    </div>` : ''

  const reviewsHtml = (app.reviews || []).length > 0 ? `
    <div class="detail-section">
      <h3>Reviews</h3>
      <div class="reviews-list">
        ${(app.reviews || []).map(rv => `
          <div class="review-item">
            <div class="review-head">${stars(rv.rating)} <span class="review-user">${esc(rv.user || 'Anonymous')}</span> <span class="review-date">${esc(rv.date)}</span></div>
            ${rv.body ? `<p>${esc(rv.body)}</p>` : ''}
          </div>
        `).join('')}
      </div>
    </div>` : ''

  const content = `
    <div class="detail-layout">
      <aside class="detail-sidebar">
        <a href="/" class="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
          Back to apps
        </a>
        
        <div class="sidebar-card">
          <img class="sidebar-icon" src="${esc(app.icon_url)}" alt="${esc(app.name)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%2216%22 fill=%22%2327272a%22/><text x=%2240%22 y=%2248%22 text-anchor=%22middle%22 font-size=%2232%22>📦</text></svg>'">
          <div class="sidebar-title">
            <h1>${esc(app.name)} ${app.verified ? '<span class="verified-badge-lg" title="Verified">✓</span>' : ''}</h1>
            <p class="sidebar-author">by ${app.author.url ? `<a href="${esc(app.author.url)}">${esc(app.author.name)}</a>` : esc(app.author.name)}</p>
          </div>
          
          <div class="sidebar-stats">
            <div class="stat">
              <span class="stat-value">${formatCount(app.install_count)}</span>
              <span class="stat-label">installs</span>
            </div>
            ${app.rating_count > 0 ? `
            <div class="stat">
              <span class="stat-value">${app.avg_rating.toFixed(1)}</span>
              <span class="stat-label">${stars(app.avg_rating)}</span>
            </div>
            ` : ''}
          </div>
          
          <div class="sidebar-meta">
            <div class="meta-row">
              <span class="meta-label">Version</span>
              <span class="meta-value">v${esc(app.latest_version)}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Category</span>
              <a href="/?category=${esc(app.category)}" class="meta-value">${esc(app.category)}</a>
            </div>
            ${app.has_ui ? `
            <div class="meta-row">
              <span class="meta-label">Interface</span>
              <span class="meta-value"><span class="badge-ui">GUI</span></span>
            </div>
            ` : ''}
            ${app.auth ? `
            <div class="meta-row">
              <span class="meta-label">Auth</span>
              <span class="meta-value"><span class="badge-auth">${app.auth.oauth2 ? 'OAuth' : app.auth.apiKey ? 'API Key' : 'Auth'}</span></span>
            </div>
            ` : ''}
          </div>
          
          <a href="${esc(app.repo_url)}" class="btn-sidebar" target="_blank" rel="noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38V14.3C3.73 14.77 3.26 13.43 3.26 13.43c-.36-.93-.88-1.17-.88-1.17-.72-.49.05-.48.05-.48.8.06 1.22.82 1.22.82.71 1.21 1.87.86 2.33.66.07-.51.28-.86.5-1.06-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            View Source
          </a>
        </div>
        
        <div class="sidebar-card">
          <h3 class="sidebar-section-title">Install</h3>
          <p class="sidebar-text">Open the App Registry in your Construct desktop, search for <strong>${esc(app.name)}</strong>, and click Install.</p>
        </div>
      </aside>
      
      <main class="detail-content">
        <div class="detail-desc">
          <p class="lead">${esc(app.description)}</p>
          ${app.long_description ? `<p class="long-desc">${esc(app.long_description)}</p>` : ''}
        </div>

        ${screenshotsHtml}
        ${toolsList}
        ${permsList}

        <div class="detail-tags">
          ${app.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>

        ${versionsHtml}
        ${reviewsHtml}
      </main>
    </div>`

  return html(layout(app.name, content))
}

// ── Page: Publish Guide ──

export function publishPage(): Response {
  const content = `
    <div class="container publish-page">
      <h1>Build &amp; Publish an App</h1>
      <p class="subtitle">Create an app for Construct and share it with every user. Apps are just <strong>MCP servers</strong> — you write tools, the AI agent calls them. Optionally add a visual UI. The registry is fully open; every listing is a reviewable pull request. <a href="https://github.com/construct-computer/app-registry/blob/main/DEVELOPER_DOCS.md" target="_blank" rel="noopener">Full developer docs &rarr;</a></p>

      <div class="publish-nav" id="toc">
        <a href="#quickstart" class="toc-link">Quick Start</a>
        <a href="#structure" class="toc-link">Project Structure</a>
        <a href="#manifest" class="toc-link">manifest.json</a>
        <a href="#server" class="toc-link">MCP Server</a>
        <a href="#sdk" class="toc-link">App SDK</a>
        <a href="#ui" class="toc-link">Visual UI</a>
        <a href="#browser-sdk" class="toc-link">Browser SDK</a>
        <a href="#auth" class="toc-link">Authentication</a>
        <a href="#testing" class="toc-link">Testing</a>
        <a href="#publishing" class="toc-link">Publishing</a>
        <a href="#updating" class="toc-link">Updates</a>
        <a href="#categories" class="toc-link">Categories</a>
        <a href="#troubleshooting" class="toc-link">Troubleshooting</a>
      </div>

      <div class="section" id="quickstart">
        <h2>Quick Start</h2>
        <p>Scaffold a complete project in seconds:</p>
        <pre><code>git clone https://github.com/construct-computer/construct-app-sample.git my-app
cd my-app
pnpm install
pnpm dev</code></pre>
        <p>Your app is running at <code>http://localhost:8787</code>. Test it:</p>
        <pre><code># Health check
curl http://localhost:8787/health

# List tools
curl -X POST http://localhost:8787/mcp \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Call a tool
curl -X POST http://localhost:8787/mcp \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"hello","arguments":{"name":"World"}},"id":2}'</code></pre>
        <p>Use <code>--with-ui</code> to include a visual interface, or <code>--no-ui</code> for a tools-only app.</p>
      </div>

      <div class="section" id="structure">
        <h2>Project Structure</h2>
        <p>Every Construct app follows this layout:</p>
        <pre><code>my-app/
├── manifest.json        # App metadata (required)
├── server.ts            # MCP server &mdash; registers tools (required)
├── icon.png             # 256&times;256 icon (required; .svg and .jpg also work)
├── README.md            # Used as the store description (required)
├── package.json         # Dependencies and scripts
├── wrangler.toml        # Cloudflare Workers config for local dev
├── .gitignore
└── ui/                  # OPTIONAL &mdash; visual interface
    ├── index.html       # UI entry point, loads the Construct SDK
    └── construct.d.ts   # TypeScript types for construct.* globals</code></pre>
        <p><strong>Tools-only apps</strong> (no UI) skip the <code>ui/</code> directory and the <code>ui</code> field in their manifest.</p>
        <p><strong>Entry points:</strong> The registry looks for <code>server.ts</code>, <code>src/index.ts</code>, or <code>index.ts</code> (in that order).</p>
      </div>

      <div class="section" id="manifest">
        <h2>manifest.json</h2>
        <p>Defines your app's metadata. The shape is described by the <a href="/schemas/manifest.json">JSON Schema</a> &mdash; set <code>$schema</code> to get editor autocomplete + validation. CI re-checks required fields at PR time.</p>
        <pre><code>{
  "$schema": "https://raw.githubusercontent.com/construct-computer/app-sdk/main/schemas/manifest.schema.json",
  "name": "My App",
  "description": "A short one-line description of what your app does.",
  "author": { "name": "Your Name", "url": "https://github.com/you" },
  "owners": ["your-github-login"],
  "icon": "icon.png",
  "categories": ["utilities"],
  "tags": ["example", "demo"],
  "ui": {
    "entry": "ui/index.html",
    "width": 800,
    "height": 600
  }
}</code></pre>
        <h4>Required fields</h4>
        <table class="field-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>name</code></td><td>string</td><td>Display name. Shown in the store and Launchpad.</td></tr>
            <tr><td><code>description</code></td><td>string</td><td>Short description. Shown in search results.</td></tr>
          </tbody>
        </table>
        <h4>Optional fields</h4>
        <table class="field-table">
          <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>author</code></td><td>object</td><td><code>{ "name": string, "url?": string }</code></td></tr>
            <tr><td><code>owners</code></td><td>string[]</td><td>GitHub logins (lowercase, <code>^[a-z0-9][a-z0-9-]{0,38}$</code>). Gates who can submit registry PRs bumping this app's pinned commit, and who can manage env vars via the developer dashboard.</td></tr>
            <tr><td><code>icon</code></td><td>string</td><td>Relative path to icon file. Default: <code>"icon.png"</code>.</td></tr>
            <tr><td><code>categories</code></td><td>string[]</td><td>Only the first entry is used; extras are ignored. See <a href="#categories">Categories</a> below.</td></tr>
            <tr><td><code>tags</code></td><td>string[]</td><td>Searchable tags.</td></tr>
            <tr><td><code>ui</code></td><td>object</td><td>UI config. Omit for tools-only apps.</td></tr>
            <tr><td><code>ui.entry</code></td><td>string</td><td>Entry point. Default: <code>"ui/index.html"</code>.</td></tr>
            <tr><td><code>ui.width</code></td><td>integer</td><td>Window width in pixels. Default: 800.</td></tr>
            <tr><td><code>ui.height</code></td><td>integer</td><td>Window height in pixels. Default: 600.</td></tr>
            <tr><td><code>auth</code></td><td>object</td><td>Auth config. See <a href="#auth">Authentication</a>.</td></tr>
            <tr><td><code>permissions</code></td><td>object</td><td>Permissions shown during install. <code>{ "network": ["api.example.com"] }</code></td></tr>
            <tr><td><code>tools</code></td><td>array</td><td>Pre-declared tool list. Auto-discovered on deploy if omitted.</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section" id="server">
        <h2>MCP Server</h2>
        <p>Your <code>server.ts</code> is a Cloudflare Worker that handles JSON-RPC 2.0 requests on <code>POST /mcp</code>. Three methods:</p>
        <table class="field-table">
          <thead><tr><th>Method</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>initialize</code></td><td>Handshake &mdash; returns protocol version and server info</td></tr>
            <tr><td><code>tools/list</code></td><td>Returns all tool definitions</td></tr>
            <tr><td><code>tools/call</code></td><td>Executes a tool and returns the result</td></tr>
          </tbody>
        </table>

        <h4>Using the App SDK (recommended)</h4>
        <p>The <a href="https://www.npmjs.com/package/@construct-computer/app-sdk"><code>@construct-computer/app-sdk</code></a> handles all the JSON-RPC boilerplate for you:</p>
        <pre><code>import { ConstructApp } from '@construct-computer/app-sdk';

const app = new ConstructApp({ name: 'my-app', version: '1.0.0' });

app.tool('hello', {
  description: 'Say hello to someone',
  parameters: {
    name: { type: 'string', description: 'Who to greet' },
  },
  handler: async (args) =&gt; {
    return \`Hello, \${args.name}!\`;
  },
});

export default app;</code></pre>
        <p>For production, the SDK is inlined into your <code>server.ts</code> (the scaffolder does this automatically). You can also <code>npm install @construct-computer/app-sdk</code> for local development with TypeScript types.</p>

        <h4>Writing from scratch</h4>
        <p>If you prefer, handle the JSON-RPC protocol yourself. You must handle <code>initialize</code>, <code>tools/list</code>, and <code>tools/call</code>. Your handler must also respond to <code>GET /health</code> with <code>"ok"</code> and handle CORS preflight (<code>OPTIONS</code>). The <code>x-construct-user</code> and <code>x-construct-auth</code> headers may be present on any request.</p>

        <h4>Handler return values</h4>
        <p>Tool handlers can return:</p>
        <ul>
          <li><strong>A string</strong> &mdash; automatically wrapped in a text content block: <code>return "Hello!"</code></li>
          <li><strong>A ToolResult</strong> &mdash; for errors or multiple blocks:
<pre><code>return {
  content: [{ type: 'text', text: 'Query is required' }],
  isError: true
}</code></pre></li>
        </ul>
      </div>

      <div class="section" id="sdk">
        <h2>App SDK Reference</h2>
        <p>Install for local development: <code>npm install @construct-computer/app-sdk</code></p>
        <table class="field-table">
          <thead><tr><th>API</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>new ConstructApp({ name, version })</code></td><td>Create app instance</td></tr>
            <tr><td><code>app.tool(name, definition)</code></td><td>Register a tool. Chainable.</td></tr>
            <tr><td><code>export default app</code></td><td>Cloudflare Worker entry point</td></tr>
            <tr><td><code>requireAuth(ctx)</code></td><td>Throw if not authenticated. Use in tool handlers.</td></tr>
            <tr><td><code>ctx.userId</code></td><td>User ID from <code>x-construct-user</code> header</td></tr>
            <tr><td><code>ctx.auth.access_token</code></td><td>OAuth token from <code>x-construct-auth</code> header</td></tr>
            <tr><td><code>ctx.isAuthenticated</code></td><td>Whether valid auth credentials are present</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section" id="ui">
        <h2>Adding a Visual UI</h2>
        <p>If you want users to interact with your app directly (not just through the AI), add a <code>ui/</code> directory:</p>

        <h4>1. Add the <code>ui</code> field to your manifest:</h4>
        <pre><code>"ui": {
  "entry": "ui/index.html",
  "width": 800,
  "height": 600
}</code></pre>

        <h4>2. Create <code>ui/index.html</code></h4>
        <p>Include the Construct SDK to communicate with the platform:</p>
        <pre><code>&lt;!DOCTYPE html&gt;
&lt;html lang="en"&gt;
&lt;head&gt;
  &lt;meta charset="UTF-8"&gt;
  &lt;title&gt;My App&lt;/title&gt;
  &lt;link rel="stylesheet" href="/sdk/construct.css"&gt;
  &lt;script src="/sdk/construct.js"&gt;&lt;/script&gt;
&lt;/head&gt;
&lt;body&gt;
  &lt;div class="app"&gt;
    &lt;input id="name" type="text" placeholder="Enter name" /&gt;
    &lt;button class="btn" onclick="runTool()"&gt;Greet&lt;/button&gt;
    &lt;div id="output"&gt;&lt;/div&gt;
  &lt;/div&gt;
  &lt;script&gt;
    construct.ready(() =&gt; {
      construct.ui.setTitle('My App');
    });
    async function runTool() {
      const result = await construct.tools.callText('hello', {
        name: document.getElementById('name').value
      });
      document.getElementById('output').textContent = result;
    }
  &lt;/script&gt;
&lt;/body&gt;
&lt;/html&gt;</code></pre>

        <h4>3. Local development</h4>
        <p>Add a <code>[assets]</code> section to <code>wrangler.toml</code>:</p>
        <pre><code>[assets]
directory = "./ui"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = ["/*"]</code></pre>
        <p>Then serve static files through the ASSETS binding in your server. In production, UI files are served from GitHub's CDN automatically.</p>
      </div>

      <div class="section" id="browser-sdk">
        <h2>Browser SDK</h2>
        <p>The SDK is a <code>postMessage</code> bridge that lets your UI communicate with Construct. Add to your <code>ui/index.html</code>:</p>
        <pre><code>&lt;link rel="stylesheet" href="/sdk/construct.css"&gt;
&lt;script src="/sdk/construct.js"&gt;&lt;/script&gt;</code></pre>
        <p><strong>Core methods</strong> (always available):</p>
        <table class="field-table">
          <thead><tr><th>API</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>construct.ready(cb)</code></td><td>Run code when the SDK bridge is ready. Always wrap init code in this.</td></tr>
            <tr><td><code>construct.tools.call(name, args)</code></td><td>Call an MCP tool. Returns <code>{ content, isError }</code>.</td></tr>
            <tr><td><code>construct.tools.callText(name, args)</code></td><td>Call a tool, get just the text result. Most common.</td></tr>
            <tr><td><code>construct.ui.setTitle(title)</code></td><td>Update the window title bar.</td></tr>
            <tr><td><code>construct.ui.getTheme()</code></td><td>Get <code>{ mode: 'light'|'dark', accent }</code>.</td></tr>
            <tr><td><code>construct.ui.close()</code></td><td>Close this app window.</td></tr>
          </tbody>
        </table>
        <p><strong>Extended methods</strong> (only available inside the Construct desktop):</p>
        <table class="field-table">
          <thead><tr><th>API</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>construct.state.get()</code></td><td>Read persistent app state (max 1MB).</td></tr>
            <tr><td><code>construct.state.set(state)</code></td><td>Write state. Triggers <code>onUpdate</code> on all clients.</td></tr>
            <tr><td><code>construct.state.onUpdate(cb)</code></td><td>Subscribe to state changes from the agent or other tabs.</td></tr>
            <tr><td><code>construct.agent.notify(message)</code></td><td>Send a message to the AI agent.</td></tr>
          </tbody>
        </table>
        <p>TypeScript declarations are available at <code>ui/construct.d.ts</code> (included in the <a href="https://github.com/construct-computer/construct-app-sample" target="_blank" rel="noopener">template repo</a>). The full API reference is in the <a href="https://github.com/construct-computer/app-registry/blob/main/DEVELOPER_DOCS.md" target="_blank" rel="noopener">developer docs</a>.</p>
      </div>

      <div class="section" id="auth">
        <h2>Authentication</h2>
        <p>Construct supports four auth schemes: <code>oauth2</code>, <code>api_key</code>, <code>bearer</code>, and <code>basic</code>. Declare any combination in <code>auth.schemes[]</code>; the user picks one when connecting.</p>

        <h4>1. Declare auth schemes in your manifest:</h4>
        <pre><code>"auth": {
  "schemes": [
    {
      "type": "oauth2",
      "label": "Sign in with Example",
      "authorization_url": "https://api.example.com/oauth/authorize",
      "token_url": "https://api.example.com/oauth/token",
      "scopes": ["read", "write"],
      "scope_separator": " "
    },
    {
      "type": "api_key",
      "label": "Use API Key",
      "instructions": "Get your key at https://api.example.com/settings/keys",
      "fields": [
        { "name": "api_key", "displayName": "API Key", "type": "password", "required": true }
      ]
    }
  ]
}</code></pre>
        <p>OAuth <code>client_id</code> / <code>client_secret</code> are <strong>not</strong> put in the manifest. They are stored as platform secrets (<code>APP_OAUTH_&lt;APP_ID&gt;_CLIENT_ID</code> / <code>_CLIENT_SECRET</code>); open an issue on the registry repo to have them added.</p>

        <h4>2. Guard authenticated tools:</h4>
        <pre><code>import { requireAuth } from '@construct-computer/app-sdk';

app.tool('get_my_account', {
  description: 'Get the authenticated user account',
  handler: async (args, ctx) =&gt; {
    requireAuth(ctx); // throws if not authenticated
    // ctx.auth.type is 'oauth2' | 'api_key' | 'bearer' | 'basic'
    // OAuth: ctx.auth.access_token / refresh_token / expires_at
    // api_key/bearer: whichever field name you declared
    // basic: ctx.auth.username, ctx.auth.password
    const token = ctx.auth.access_token || ctx.auth.api_key;
    const res = await fetch('https://api.example.com/me', {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    return await res.text();
  },
});</code></pre>

        <p>Mix public and authenticated tools in the same app. The platform injects auth credentials via the <code>x-construct-auth</code> header when the user has connected their account. OAuth tokens are refreshed automatically before dispatch.</p>
      </div>

      <div class="section" id="testing">
        <h2>Testing Locally</h2>
        <pre><code># Start dev server
npm run dev      # runs on http://localhost:8787

# Health check
curl http://localhost:8787/health

# Test MCP endpoint
curl -X POST http://localhost:8787/mcp \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Test with auth headers
curl -X POST http://localhost:8787/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'x-construct-auth: {"access_token":"test-token","user_id":"user-123"}' \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"hello","arguments":{"name":"World"}},"id":2}'</code></pre>
        <p><strong>Test in Construct:</strong> Open Construct &rarr; <strong>Settings</strong> &rarr; <strong>Developer</strong>, toggle <em>Developer Mode</em> on, paste <code>http://localhost:8787</code> into <em>Connect Dev Server</em>, and click <em>Connect</em>. Construct validates <code>/health</code> + <code>/mcp</code>, registers your tools with the agent, and opens your UI in a sandboxed window.</p>

        <p><strong>Remote testing:</strong> Use <a href="https://developers.cloudflare.com/cloudflare-one/connections/app-network/create-tunnel/" target="_blank" rel="noopener">cloudflared tunnel</a> to expose your local server, then paste the tunnel URL into <em>Connect Dev Server</em>:</p>
        <pre><code>cloudflared tunnel --url http://localhost:8787</code></pre>
      </div>

      <div class="section" id="publishing">
        <h2>Publishing to the Registry</h2>

        <div class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-body">
              <h3>Prepare your app</h3>
              <p>Make sure your repo has all required files:</p>
              <ul>
                <li><code>manifest.json</code> &mdash; with <code>name</code> and <code>description</code></li>
                <li><code>server.ts</code> (or <code>src/index.ts</code> or <code>index.ts</code>) &mdash; MCP server entry point</li>
                <li><code>icon.png</code> &mdash; 256&times;256 icon (or <code>icon.svg</code>, <code>icon.jpg</code>)</li>
                <li><code>README.md</code> &mdash; used as the store description</li>
              </ul>
            </div>
          </div>

          <div class="step">
            <div class="step-num">2</div>
            <div class="step-body">
              <h3>Push to GitHub</h3>
              <p>Create a public repo. The naming convention is <code>construct-app-{name}</code>:</p>
              <pre><code>git init && git add -A
git commit -m "Initial release"
git remote add origin git@github.com:you/construct-app-myapp.git
git push -u origin main</code></pre>
            </div>
          </div>

          <div class="step">
            <div class="step-num">3</div>
            <div class="step-body">
              <h3>Get your commit SHA</h3>
              <pre><code>git rev-parse HEAD
# &rarr; abc123def456789abc123def456789abc123def4</code></pre>
              <p>This pins your app to an exact, auditable version.</p>
            </div>
          </div>

          <div class="step">
            <div class="step-num">4</div>
            <div class="step-body">
              <h3>Add a pointer file</h3>
              <p>Fork <a href="https://github.com/construct-computer/app-registry" target="_blank" rel="noopener">construct-computer/app-registry</a> and add <code>apps/{your-app-id}.json</code>:</p>
              <pre><code>{
  "repo": "https://github.com/you/construct-app-myapp",
  "versions": [
    {
      "version": "1.0.0",
      "commit": "abc123def456789abc123def456789abc123def4",
      "date": "2026-04-10"
    }
  ]
}</code></pre>
              <p>The pointer only needs <code>repo</code> and <code>versions</code>. The listing (name, description, icon, etc.) is read from your repo's <code>manifest.json</code> at the pinned commit.</p>
              <p>The app ID (filename without <code>.json</code>) must match <code>^[a-z0-9][a-z0-9-]{0,40}[a-z0-9]?$</code> and not be a reserved name (<code>registry</code>, <code>apps</code>, <code>api</code>, <code>www</code>, <code>auth</code>, <code>admin</code>, etc.). The registry appends a random suffix, so your app lives at <code>{your-app-id}-{nanoid}.apps.construct.computer</code>.</p>
            </div>
          </div>

          <div class="step">
            <div class="step-num">5</div>
            <div class="step-body">
              <h3>Open a pull request</h3>
              <p>CI automatically validates your submission:</p>
              <ul>
                <li>Clones your repo at the pinned commit</li>
                <li>Validates <code>manifest.json</code> has <code>name</code> and <code>description</code></li>
                <li>Enforces the <strong>ownership gate</strong>: if <code>manifest.owners[]</code> is set, the PR author's GitHub login must be in it</li>
                <li>Checks that <code>server.ts</code> / <code>src/index.ts</code> / <code>index.ts</code> exists and compiles (<code>npm run build</code> or <code>deno check</code>)</li>
                <li>Verifies <code>icon.png</code> (or <code>.svg</code>/<code>.jpg</code>) and <code>README.md</code> exist</li>
              </ul>
              <p>Once a maintainer approves and merges, your app goes live within minutes!</p>
            </div>
          </div>
        </div>
      </div>

      <div class="section" id="updating">
        <h2>Updating Your App</h2>
        <p>Push the update to your repo, then open a PR to the registry adding a new version:</p>
        <pre><code>{
  "repo": "https://github.com/you/construct-app-myapp",
  "versions": [
    { "version": "1.0.0", "commit": "abc123...", "date": "2026-04-01" },
    { "version": "1.1.0", "commit": "def456...", "date": "2026-04-10" }
  ]
}</code></pre>
        <p>The <strong>last entry</strong> in the <code>versions</code> array becomes the current version. Previous versions remain accessible in the version history.</p>
        <p>Bumps require the PR author to be in <code>manifest.owners[]</code> (when set), so add co-maintainers there in your app repo before they try to publish.</p>
      </div>

      <div class="section" id="categories">
        <h2>Categories</h2>
        <div class="cat-grid">
          <span class="cat-badge">productivity</span>
          <span class="cat-badge">developer-tools</span>
          <span class="cat-badge">communication</span>
          <span class="cat-badge">finance</span>
          <span class="cat-badge">media</span>
          <span class="cat-badge">ai-tools</span>
          <span class="cat-badge">data</span>
          <span class="cat-badge">utilities</span>
          <span class="cat-badge">integrations</span>
          <span class="cat-badge">shopping</span>
          <span class="cat-badge">games</span>
        </div>
      </div>

      <div class="section" id="troubleshooting">
        <h2>Troubleshooting</h2>
        <div class="faq">
          <div class="faq-item">
            <h4>CI validation failed</h4>
            <p>Common fixes:</p>
            <ul>
              <li><strong>Missing manifest.json</strong> &mdash; add it to your repo root</li>
              <li><strong>Missing required fields</strong> &mdash; ensure <code>name</code> and <code>description</code> are present</li>
              <li><strong>No entry point</strong> &mdash; create <code>server.ts</code>, <code>src/index.ts</code>, or <code>index.ts</code></li>
              <li><strong>No icon</strong> &mdash; add <code>icon.png</code> (or <code>.svg</code>/<code>.jpg</code>)</li>
              <li><strong>Missing README.md</strong> &mdash; add one to your repo root</li>
            </ul>
          </div>
          <div class="faq-item">
            <h4>App not appearing in the store</h4>
            <p>Make sure the PR was merged (not just opened), the commit SHA is correct, and wait a few minutes for the sync pipeline.</p>
          </div>
          <div class="faq-item">
            <h4>Auth header not received</h4>
            <p>The <code>x-construct-auth</code> header is only present when the user has connected their account. Test locally by adding headers manually with <code>curl</code>.</p>
          </div>
          <div class="faq-item">
            <h4>UI not loading</h4>
            <p>Make sure <code>manifest.json</code> has the <code>ui</code> field, <code>ui/index.html</code> exists, and you're loading the SDK from <code>/sdk/construct.js</code> and <code>/sdk/construct.css</code>.</p>
          </div>
        </div>
      </div>

      <div class="publish-cta">
        <h2>Ready to build?</h2>
        <div class="cta-links">
          <a href="https://github.com/construct-computer/construct-app-sample" class="btn-primary" target="_blank" rel="noopener">Template Repo &rarr;</a>
          <a href="https://github.com/construct-computer/app-registry/fork" class="btn-outline" target="_blank" rel="noopener">Fork the Registry</a>
        </div>
      </div>
    </div>`

  return html(layout('Build & Publish an App', content, { activePage: 'publish' }))
}

// ── Stylesheet ──

