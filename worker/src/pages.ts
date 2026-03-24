/**
 * Server-rendered HTML pages for the Construct App Registry.
 *
 * Routes:
 *   GET /              — Browse apps (search, categories, grid)
 *   GET /apps/:id      — App detail page
 *   GET /publish       — How to publish an app
 */

// ── Shared layout ──

function layout(title: string, content: string, activePage = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Construct App Registry</title>
  <meta name="description" content="Browse and discover apps for construct.computer — the AI-powered virtual desktop.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📦</text></svg>">
  <style>${CSS}</style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="logo">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
        <span>Construct Apps</span>
      </a>
      <div class="nav-links">
        <a href="/" class="${activePage === 'browse' ? 'active' : ''}">Browse</a>
        <a href="/publish" class="${activePage === 'publish' ? 'active' : ''}">Publish</a>
        <a href="https://github.com/construct-computer/app-registry" target="_blank" rel="noopener">GitHub</a>
        <a href="https://construct.computer" target="_blank" rel="noopener">construct.computer</a>
      </div>
    </div>
  </nav>
  <main>${content}</main>
  <footer class="footer">
    <div class="footer-inner">
      <p>&copy; 2026 <a href="https://construct.computer">construct.computer</a>. Registry is <a href="https://github.com/construct-computer/app-registry">open source</a>.</p>
    </div>
  </footer>
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
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
  has_ui: boolean
  icon_url: string
  repo_url: string
  tools: Array<{ name: string; description: string }>
  permissions: Record<string, unknown>
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
    featured: r.featured === 1, has_ui: r.has_ui === 1,
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

  const content = `
    <div class="hero">
      <h1>Construct App Store</h1>
      <p>Discover apps for your AI-powered desktop</p>
      <form class="search-form" action="/" method="get">
        ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
        <input type="search" name="q" value="${esc(q)}" placeholder="Search apps..." autofocus>
        <button type="submit">Search</button>
      </form>
    </div>
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

  return html(layout(category || q || 'Browse Apps', content, 'browse'))
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
    featured: r.featured === 1, has_ui: r.has_ui === 1,
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
      <h3>Tools</h3>
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
    <div class="container">
      <a href="/" class="back-link">&larr; Back to apps</a>
      <div class="detail-header">
        <img class="detail-icon" src="${esc(app.icon_url)}" alt="${esc(app.name)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22><rect width=%2280%22 height=%2280%22 rx=%2216%22 fill=%22%2327272a%22/><text x=%2240%22 y=%2248%22 text-anchor=%22middle%22 font-size=%2232%22>📦</text></svg>'">
        <div class="detail-title">
          <h1>${esc(app.name)}</h1>
          <p class="detail-author">by ${app.author.url ? `<a href="${esc(app.author.url)}">${esc(app.author.name)}</a>` : esc(app.author.name)} &middot; v${esc(app.latest_version)}</p>
          <div class="detail-stats">
            ${app.rating_count > 0 ? `${stars(app.avg_rating)} <span>(${app.rating_count})</span> <span class="meta-sep">&middot;</span>` : ''}
            <span>${formatCount(app.install_count)} installs</span>
            <span class="meta-sep">&middot;</span>
            <a href="/?category=${esc(app.category)}">${esc(app.category)}</a>
            ${app.has_ui ? '<span class="badge-ui">GUI</span>' : ''}
          </div>
        </div>
        <div class="detail-actions">
          <a href="${esc(app.repo_url)}" class="btn-outline" target="_blank" rel="noopener">View Source</a>
        </div>
      </div>

      <div class="detail-desc">
        <p>${esc(app.description)}</p>
        ${app.long_description ? `<p class="long-desc">${esc(app.long_description)}</p>` : ''}
      </div>

      <div class="detail-install">
        <h3>Install in Construct</h3>
        <p>Open the App Store in your Construct desktop, search for <strong>${esc(app.name)}</strong>, and click Install.</p>
      </div>

      ${screenshotsHtml}
      ${toolsList}
      ${permsList}

      <div class="detail-tags">
        ${app.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>

      ${versionsHtml}
      ${reviewsHtml}
    </div>`

  return html(layout(app.name, content))
}

// ── Page: Publish Guide ──

export function publishPage(): Response {
  const content = `
    <div class="container publish-page">
      <h1>Publish an App</h1>
      <p class="subtitle">Share your app with every Construct user. The registry is fully open — every listing is a transparent, reviewable pull request on GitHub.</p>

      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-body">
            <h3>Build your app</h3>
            <p>Create a Construct app following the standard structure. Your app runs on <strong>Deno</strong> and communicates via <strong>MCP</strong> (Model Context Protocol).</p>
            <pre><code>my-app/
├── manifest.json       # App metadata (required)
├── server.ts           # MCP server entry (required)
├── icon.png            # 256&times;256 icon (required)
├── README.md           # Store description (required)
├── screenshots/        # Store screenshots (optional)
│   ├── 1.png
│   └── 2.png
└── ui/                 # GUI window (optional)
    └── index.html</code></pre>
          </div>
        </div>

        <div class="step">
          <div class="step-num">2</div>
          <div class="step-body">
            <h3>Write your manifest</h3>
            <p>Define your app's metadata, tools, and permissions in <code>manifest.json</code>:</p>
            <pre><code>{
  "id": "my-app",
  "name": "My App",
  "version": "1.0.0",
  "description": "A short one-line description",
  "author": { "name": "Your Name", "url": "https://github.com/you" },
  "entry": "server.ts",
  "runtime": "deno",
  "transport": "stdio",
  "permissions": {
    "network": ["api.example.com"]
  },
  "categories": ["utilities"],
  "tags": ["example"],
  "tools": [
    { "name": "my_tool", "description": "What it does" }
  ]
}</code></pre>
          </div>
        </div>

        <div class="step">
          <div class="step-num">3</div>
          <div class="step-body">
            <h3>Push to GitHub</h3>
            <p>Create a public repo for your app. The naming convention is <code>construct-app-{name}</code>, but any name works.</p>
            <pre><code>git init && git add -A
git commit -m "Initial release"
git remote add origin git@github.com:you/construct-app-myapp.git
git push -u origin main</code></pre>
          </div>
        </div>

        <div class="step">
          <div class="step-num">4</div>
          <div class="step-body">
            <h3>Submit to the registry</h3>
            <p>Fork <a href="https://github.com/construct-computer/app-registry">construct-computer/app-registry</a> and add a pointer file for your app:</p>
            <pre><code># apps/my-app.json
{
  "repo": "https://github.com/you/construct-app-myapp",
  "versions": [
    {
      "version": "1.0.0",
      "commit": "abc123def456...",
      "date": "2026-03-24"
    }
  ]
}</code></pre>
            <p>The <strong>commit</strong> field must be the full 40-character SHA of the commit you want to publish. This pins users to an exact, auditable version.</p>
          </div>
        </div>

        <div class="step">
          <div class="step-num">5</div>
          <div class="step-body">
            <h3>Open a pull request</h3>
            <p>CI automatically validates your app:</p>
            <ul>
              <li>Clones your repo at the pinned commit</li>
              <li>Validates <code>manifest.json</code> schema</li>
              <li>Checks <code>server.ts</code> compiles with <code>deno check</code></li>
              <li>Verifies icon and README exist</li>
              <li>Flags dangerous permissions for review</li>
            </ul>
            <p>Once a maintainer approves and merges, your app appears in the Construct App Store.</p>
          </div>
        </div>

        <div class="step">
          <div class="step-num">6</div>
          <div class="step-body">
            <h3>Publishing updates</h3>
            <p>Push the update to your repo, then open a PR adding a new version entry:</p>
            <pre><code>{
  "repo": "https://github.com/you/construct-app-myapp",
  "versions": [
    { "version": "1.0.0", "commit": "abc123...", "date": "2026-03-15" },
    { "version": "1.1.0", "commit": "def456...", "date": "2026-03-24" }
  ]
}</code></pre>
            <p>The last version in the array becomes the latest in the store.</p>
          </div>
        </div>
      </div>

      <div class="publish-cta">
        <h2>Ready to publish?</h2>
        <p>Check out the <a href="https://github.com/construct-computer/construct-app-sample">DevTools reference app</a> to see a complete example.</p>
        <a href="https://github.com/construct-computer/app-registry/fork" class="btn-primary" target="_blank" rel="noopener">Fork the Registry &rarr;</a>
      </div>
    </div>`

  return html(layout('Publish an App', content, 'publish'))
}

// ── Stylesheet ──

const CSS = `
  :root {
    --bg: #09090b;
    --bg-subtle: #18181b;
    --surface: rgba(255,255,255,0.04);
    --surface-hover: rgba(255,255,255,0.07);
    --surface-raised: rgba(255,255,255,0.08);
    --border: rgba(255,255,255,0.10);
    --border-strong: rgba(255,255,255,0.18);
    --text: #fafafa;
    --text-muted: rgba(255,255,255,0.50);
    --text-subtle: rgba(255,255,255,0.30);
    --accent: #60A5FA;
    --accent-hover: #93C5FD;
    --accent-muted: rgba(96,165,250,0.12);
    --font: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    --mono: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
    --radius: 8px;
    --radius-sm: 4px;
    --radius-lg: 12px;
  }
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  html { height:100%; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { flex: 1; }
  img { display: block; }

  /* ── Nav ── */
  .nav {
    border-bottom: 1px solid var(--border);
    background: var(--bg-subtle);
    position: sticky; top: 0; z-index: 50;
  }
  .nav-inner {
    max-width: 1100px; margin: 0 auto; padding: 0 24px;
    display: flex; align-items: center; justify-content: space-between;
    height: 52px;
  }
  .logo {
    display: flex; align-items: center; gap: 8px;
    font-weight: 600; font-size: 15px; color: var(--text);
  }
  .logo:hover { text-decoration: none; }
  .logo svg { opacity: 0.8; }
  .nav-links { display: flex; gap: 4px; }
  .nav-links a {
    padding: 6px 12px; border-radius: var(--radius-sm);
    color: var(--text-muted); font-size: 13px; font-weight: 500;
    transition: color 0.15s, background 0.15s;
  }
  .nav-links a:hover { color: var(--text); background: var(--surface-hover); text-decoration: none; }
  .nav-links a.active { color: var(--accent); background: var(--accent-muted); }

  /* ── Footer ── */
  .footer {
    border-top: 1px solid var(--border);
    padding: 24px;
    margin-top: 48px;
  }
  .footer-inner {
    max-width: 1100px; margin: 0 auto;
    text-align: center; font-size: 12px; color: var(--text-subtle);
  }
  .footer a { color: var(--text-muted); }

  /* ── Hero ── */
  .hero {
    text-align: center;
    padding: 48px 24px 32px;
    border-bottom: 1px solid var(--border);
  }
  .hero h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
  .hero p { color: var(--text-muted); margin-bottom: 24px; font-size: 15px; }
  .search-form {
    display: flex; gap: 8px; max-width: 480px; margin: 0 auto;
  }
  .search-form input {
    flex: 1; padding: 10px 16px;
    border-radius: var(--radius); border: 1px solid var(--border-strong);
    background: var(--surface-hover); color: var(--text);
    font-size: 14px; font-family: var(--font); outline: none;
  }
  .search-form input:focus { border-color: var(--accent); }
  .search-form input::placeholder { color: var(--text-subtle); }
  .search-form button {
    padding: 10px 20px; border-radius: var(--radius); border: none;
    background: var(--accent); color: #fff; font-weight: 500;
    cursor: pointer; font-family: var(--font); font-size: 14px;
  }
  .search-form button:hover { background: var(--accent-hover); }

  /* ── Browse layout ── */
  .browse-layout {
    max-width: 1100px; margin: 0 auto; padding: 32px 24px;
    display: grid; grid-template-columns: 200px 1fr; gap: 32px;
  }
  @media (max-width: 768px) {
    .browse-layout { grid-template-columns: 1fr; }
    .sidebar { display: flex; flex-wrap: wrap; gap: 4px; }
    .sidebar h3 { display: none; }
  }
  .sidebar h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-subtle); margin-bottom: 12px; }
  .cat-link {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; border-radius: var(--radius-sm); font-size: 13px;
    color: var(--text-muted); transition: color 0.15s, background 0.15s;
  }
  .cat-link:hover { color: var(--text); background: var(--surface-hover); text-decoration: none; }
  .cat-link.active { color: var(--accent); background: var(--accent-muted); }
  .cat-count { font-size: 11px; color: var(--text-subtle); }

  .browse-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; }
  .browse-header h2 { font-size: 18px; font-weight: 600; }
  .result-count { font-size: 12px; color: var(--text-subtle); }

  /* ── App grid ── */
  .app-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
  }
  .app-card {
    display: flex; gap: 14px; padding: 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius-lg); transition: background 0.15s, border-color 0.15s;
    color: var(--text);
  }
  .app-card:hover { background: var(--surface-hover); border-color: var(--border-strong); text-decoration: none; }
  .app-icon { width: 52px; height: 52px; border-radius: var(--radius); flex-shrink: 0; object-fit: cover; background: var(--bg-subtle); }
  .app-info { min-width: 0; flex: 1; }
  .app-name { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
  .app-desc { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-meta { font-size: 11px; color: var(--text-subtle); margin-top: 6px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .meta-sep { opacity: 0.3; }
  .stars { color: #facc15; letter-spacing: -1px; font-size: 12px; }
  .star-empty { opacity: 0.2; }
  .badge-ui { font-size: 9px; background: var(--accent-muted); color: var(--accent); padding: 1px 6px; border-radius: 9999px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  .tag { font-size: 11px; background: var(--surface-raised); color: var(--text-muted); padding: 2px 8px; border-radius: 9999px; }

  .empty { text-align: center; padding: 60px 20px; color: var(--text-subtle); }
  .empty p { margin-top: 12px; }

  .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; font-size: 13px; }
  .page-info { color: var(--text-subtle); }

  /* ── Detail page ── */
  .container { max-width: 800px; margin: 0 auto; padding: 32px 24px; }
  .back-link { font-size: 13px; color: var(--text-muted); display: inline-block; margin-bottom: 24px; }
  .back-link:hover { color: var(--text); }

  .detail-header { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 24px; }
  .detail-icon { width: 80px; height: 80px; border-radius: var(--radius-lg); flex-shrink: 0; object-fit: cover; background: var(--bg-subtle); }
  .detail-title { flex: 1; min-width: 0; }
  .detail-title h1 { font-size: 24px; font-weight: 700; margin-bottom: 2px; }
  .detail-author { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
  .detail-stats { font-size: 12px; color: var(--text-subtle); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .detail-actions { flex-shrink: 0; display: flex; gap: 8px; }

  .btn-outline {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500;
    border: 1px solid var(--border-strong); color: var(--text-muted); background: var(--surface-hover);
    transition: color 0.15s, background 0.15s; display: inline-block;
  }
  .btn-outline:hover { color: var(--text); background: var(--surface-raised); text-decoration: none; }
  .btn-primary {
    display: inline-block; padding: 10px 24px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 500;
    background: var(--accent); color: #fff; transition: background 0.15s;
  }
  .btn-primary:hover { background: var(--accent-hover); text-decoration: none; }

  .detail-desc { margin-bottom: 24px; }
  .detail-desc p { color: var(--text-muted); line-height: 1.6; }
  .long-desc { margin-top: 8px; }

  .detail-install {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
    padding: 20px; margin-bottom: 24px;
  }
  .detail-install h3 { font-size: 14px; margin-bottom: 8px; }
  .detail-install p { font-size: 13px; color: var(--text-muted); }
  .alt-install { margin-top: 12px; font-size: 12px !important; color: var(--text-subtle) !important; }

  pre {
    background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px 16px; overflow-x: auto; margin-top: 8px; font-size: 12px; line-height: 1.6;
  }
  code { font-family: var(--mono); font-size: 0.92em; }
  pre code { font-size: 12px; }
  p code { background: var(--surface-raised); padding: 2px 6px; border-radius: 3px; }

  .detail-section { margin-bottom: 24px; }
  .detail-section h3 { font-size: 14px; margin-bottom: 12px; font-weight: 600; }

  .screenshots { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; }
  .screenshots img { height: 200px; border-radius: var(--radius); border: 1px solid var(--border); flex-shrink: 0; }

  .tools-list { display: flex; flex-direction: column; gap: 6px; }
  .tool-item { display: flex; gap: 12px; align-items: baseline; padding: 8px 12px; background: var(--surface); border-radius: var(--radius-sm); }
  .tool-item code { color: var(--accent); font-weight: 500; white-space: nowrap; }
  .tool-item span { font-size: 13px; color: var(--text-muted); }

  .perms-list { display: flex; flex-direction: column; gap: 4px; }
  .perm-item { display: flex; gap: 10px; font-size: 13px; padding: 6px 12px; background: var(--surface); border-radius: var(--radius-sm); }
  .perm-key { color: var(--accent); font-family: var(--mono); font-size: 12px; min-width: 80px; }
  .perm-val { color: var(--text-muted); }

  .detail-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 24px; }

  .versions-list { display: flex; flex-direction: column; gap: 8px; }
  .version-item { padding: 10px 14px; background: var(--surface); border-radius: var(--radius-sm); }
  .version-head { display: flex; justify-content: space-between; align-items: center; }
  .version-date { font-size: 12px; color: var(--text-subtle); }
  .version-changelog { font-size: 13px; color: var(--text-muted); margin-top: 4px; }

  .reviews-list { display: flex; flex-direction: column; gap: 12px; }
  .review-item { padding: 12px 14px; background: var(--surface); border-radius: var(--radius-sm); }
  .review-head { font-size: 12px; color: var(--text-subtle); display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .review-user { color: var(--text-muted); }
  .review-item p { font-size: 13px; color: var(--text-muted); }

  /* ── Publish page ── */
  .publish-page { max-width: 720px; }
  .publish-page h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
  .subtitle { color: var(--text-muted); font-size: 15px; margin-bottom: 40px; line-height: 1.6; }

  .steps { display: flex; flex-direction: column; gap: 32px; margin-bottom: 48px; }
  .step { display: flex; gap: 20px; }
  .step-num {
    width: 32px; height: 32px; flex-shrink: 0;
    background: var(--accent-muted); color: var(--accent);
    border-radius: 9999px; display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; margin-top: 2px;
  }
  .step-body { flex: 1; min-width: 0; }
  .step-body h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .step-body p { font-size: 13px; color: var(--text-muted); line-height: 1.6; margin-bottom: 8px; }
  .step-body ul { padding-left: 18px; font-size: 13px; color: var(--text-muted); line-height: 1.8; }
  .step-body li { margin-bottom: 2px; }
  .step-body pre { margin-bottom: 12px; }

  .publish-cta {
    text-align: center; padding: 40px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .publish-cta h2 { font-size: 20px; margin-bottom: 8px; }
  .publish-cta p { color: var(--text-muted); font-size: 14px; margin-bottom: 20px; }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

  @media (max-width: 640px) {
    .detail-header { flex-direction: column; }
    .detail-actions { width: 100%; }
    .detail-actions a { flex: 1; text-align: center; }
    .app-grid { grid-template-columns: 1fr; }
    .hero h1 { font-size: 22px; }
  }
`
