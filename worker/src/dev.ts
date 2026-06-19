/**
 * Developer dashboard — GitHub-auth'd per-app env var management.
 *
 * Routes (all under /dev on registry.construct.computer):
 *   GET  /dev                        — entry; redirect to dashboard or login
 *   GET  /dev/login                  — redirect to GitHub OAuth
 *   GET  /dev/callback               — OAuth callback; create session
 *   POST /dev/logout                 — destroy session
 *   GET  /dev/dashboard              — list apps the logged-in user owns
 *   GET  /dev/apps/:id               — per-app dashboard with env var CRUD
 *   POST /dev/apps/:id/env           — upsert a single env var (form-encoded)
 *   POST /dev/apps/:id/env/delete    — delete an env var (form-encoded)
 *
 * Isolation model
 *   Env var *values* live encrypted in D1 (app_env_vars.value_encrypted) with
 *   AES-256-GCM, keyed off ENV_ENCRYPTION_KEY. Values are never returned to
 *   the dashboard (only names + last-updated timestamps). Apps receive their
 *   own env vars — and no one else's — via an internal x-construct-env header
 *   set by handleAppProxy at dispatch time.
 */

import { encryptValue } from './lib/crypto';
import {
  authorizationUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  signState,
  verifyState,
} from './lib/github';
import {
  SESSION_COOKIE,
  buildClearCookieHeader,
  createSession,
  destroySession,
  readSession,
  sessionCookie,
  type DevSession,
} from './lib/session';
import { layout } from './lib/ui';
import { createLogger } from './lib/log';
import { logContextFromRequest } from './lib/request-context';

export interface DevEnv {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ENV_ENCRYPTION_KEY: string;
}

// ── Entry ──────────────────────────────────────────────────────────────────

export async function handleDevRequest(
  request: Request,
  env: DevEnv,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  try {
    if (method === 'GET' && path === '/dev') return indexRedirect(request, env);
    if (method === 'GET' && path === '/dev/login') return loginRedirect(env, url);
    if (method === 'GET' && path === '/dev/callback') return oauthCallback(request, env, url);
    if (method === 'POST' && path === '/dev/logout') return logout(request, env);
    if (method === 'GET' && path === '/dev/dashboard') return dashboardPage(request, env);

    const appMatch = path.match(/^\/dev\/apps\/([a-z0-9-]+)$/);
    if (method === 'GET' && appMatch) return appDashboardPage(request, env, appMatch[1]);

    const envMatch = path.match(/^\/dev\/apps\/([a-z0-9-]+)\/env$/);
    if (method === 'POST' && envMatch) return upsertEnvVar(request, env, envMatch[1]);

    const delMatch = path.match(/^\/dev\/apps\/([a-z0-9-]+)\/env\/delete$/);
    if (method === 'POST' && delMatch) return deleteEnvVar(request, env, delMatch[1]);

    return textResponse('Not found', 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    createLogger('registry.dev', logContextFromRequest(request), { ENVIRONMENT: 'production' }).error('dev_dashboard_error', {
      functionality: 'dev_dashboard',
      outcome: 'error',
      path,
      error_message: msg,
    });
    return textResponse(`Dashboard error: ${msg}`, 500);
  }
}

// ── OAuth ──────────────────────────────────────────────────────────────────

async function indexRedirect(request: Request, env: DevEnv): Promise<Response> {
  const session = await readSession(env, request);
  return redirect(session ? '/dev/dashboard' : '/dev/login');
}

async function loginRedirect(env: DevEnv, url: URL): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return textResponse(
      'GitHub OAuth is not configured (set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET).',
      503,
    );
  }
  const returnTo = url.searchParams.get('next') || '/dev/dashboard';
  const state = await signState(env, returnTo);
  const redirectUri = `${url.origin}/dev/callback`;
  return redirect(authorizationUrl(env, redirectUri, state));
}

async function oauthCallback(request: Request, env: DevEnv, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return htmlErrorPage('GitHub returned an error', oauthError);
  if (!code || !state) return htmlErrorPage('Invalid callback', 'Missing code or state');

  const verified = await verifyState(env, state);
  if (!verified) return htmlErrorPage('Invalid callback', 'State did not verify');

  const redirectUri = `${url.origin}/dev/callback`;
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken(env, code, redirectUri);
  } catch (err) {
    return htmlErrorPage('GitHub token exchange failed', (err as Error).message);
  }

  let user;
  try {
    user = await fetchGitHubUser(accessToken);
  } catch (err) {
    return htmlErrorPage('Could not fetch GitHub user', (err as Error).message);
  }

  const { cookie } = await createSession(env, user.id, user.login);

  const safeReturn = verified.returnTo.startsWith('/dev/') ? verified.returnTo : '/dev/dashboard';
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeReturn,
      'Set-Cookie': sessionCookie(cookie),
      'Cache-Control': 'no-store',
    },
  });
}

async function logout(request: Request, env: DevEnv): Promise<Response> {
  if (!isSameOrigin(request)) return textResponse('Forbidden', 403);
  const session = await readSession(env, request);
  if (session) await destroySession(env, session.id);
  // Return HTML page with JS redirect instead of 302 — ensures the
  // Set-Cookie header is processed by the browser before navigation.
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Logged out</title></head>` +
    `<body style="background:#0a0a12;color:#e4e4ed;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<p>Signing out…</p>` +
    `<script>setTimeout(function(){window.location.href='/';},300);</script>` +
    `</body></html>`,
    {
      status: 200,
      headers: {
        'Set-Cookie': buildClearCookieHeader(SESSION_COOKIE),
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function dashboardPage(request: Request, env: DevEnv): Promise<Response> {
  const session = await readSession(env, request);
  if (!session) return redirect('/dev/login');

  const apps = await listOwnedApps(env.DB, session.githubLogin);
  const body = renderDashboard(session, apps);
  return htmlResponse(body);
}

async function appDashboardPage(request: Request, env: DevEnv, appId: string): Promise<Response> {
  const session = await readSession(env, request);
  if (!session) return redirect(`/dev/login?next=${encodeURIComponent(`/dev/apps/${appId}`)}`);

  const ownership = await assertOwnership(env.DB, appId, session.githubLogin);
  if (ownership.status !== 'ok') return ownership.response;

  const vars = await env.DB.prepare(
    `SELECT name, updated_at, updated_by FROM app_env_vars WHERE app_id = ? ORDER BY name ASC`,
  )
    .bind(appId)
    .all<{ name: string; updated_at: number; updated_by: string }>();

  const rendered = renderAppPage(session, ownership.app, vars.results ?? []);
  const withFlash = injectFlashFromQuery(rendered, new URL(request.url));
  return htmlResponse(withFlash);
}

async function upsertEnvVar(request: Request, env: DevEnv, appId: string): Promise<Response> {
  if (!isSameOrigin(request)) return textResponse('Forbidden', 403);
  const session = await readSession(env, request);
  if (!session) return redirect('/dev/login');

  const ownership = await assertOwnership(env.DB, appId, session.githubLogin);
  if (ownership.status !== 'ok') return ownership.response;

  const form = await request.formData();
  const rawName = (form.get('name') || '').toString().trim();
  const value = (form.get('value') || '').toString();

  const validation = validateVarName(rawName);
  if (!validation.ok) {
    return appRedirect(appId, { error: validation.reason });
  }
  if (!value) {
    return appRedirect(appId, { error: 'Value cannot be empty' });
  }
  if (value.length > 8 * 1024) {
    return appRedirect(appId, { error: 'Value too long (8 KiB max)' });
  }

  let encrypted: string;
  try {
    encrypted = await encryptValue(value, env.ENV_ENCRYPTION_KEY);
  } catch (err) {
    return appRedirect(appId, { error: `Encryption failed: ${(err as Error).message}` });
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO app_env_vars (app_id, name, value_encrypted, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, name) DO UPDATE SET
       value_encrypted = excluded.value_encrypted,
       updated_at      = excluded.updated_at,
       updated_by      = excluded.updated_by`,
  )
    .bind(appId, rawName, encrypted, now, now, session.githubLogin)
    .run();

  return appRedirect(appId, { ok: `Saved ${rawName}` });
}

async function deleteEnvVar(request: Request, env: DevEnv, appId: string): Promise<Response> {
  if (!isSameOrigin(request)) return textResponse('Forbidden', 403);
  const session = await readSession(env, request);
  if (!session) return redirect('/dev/login');

  const ownership = await assertOwnership(env.DB, appId, session.githubLogin);
  if (ownership.status !== 'ok') return ownership.response;

  const form = await request.formData();
  const name = (form.get('name') || '').toString().trim();
  if (!name) return appRedirect(appId, { error: 'Missing name' });

  await env.DB.prepare(`DELETE FROM app_env_vars WHERE app_id = ? AND name = ?`)
    .bind(appId, name)
    .run();

  return appRedirect(appId, { ok: `Deleted ${name}` });
}

// ── DB helpers ─────────────────────────────────────────────────────────────

interface OwnedApp {
  id: string;
  name: string;
  icon_url: string | null;
  repo_owner: string;
  repo_name: string;
  var_count: number;
}

async function listOwnedApps(db: D1Database, githubLogin: string): Promise<OwnedApp[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.repo_owner, a.repo_name, a.icon_path, a.latest_commit,
              COALESCE((SELECT COUNT(*) FROM app_env_vars e WHERE e.app_id = a.id), 0) AS var_count
       FROM apps a
       JOIN app_owners o ON o.app_id = a.id
       WHERE o.github_login = ? COLLATE NOCASE
         AND a.status = 'active'
       ORDER BY a.name ASC`,
    )
    .bind(githubLogin)
    .all<{
      id: string;
      name: string;
      repo_owner: string;
      repo_name: string;
      icon_path: string;
      latest_commit: string;
      var_count: number;
    }>();

  return (results || []).map((r) => ({
    id: r.id,
    name: r.name,
    repo_owner: r.repo_owner,
    repo_name: r.repo_name,
    icon_url: `https://raw.githubusercontent.com/${r.repo_owner}/${r.repo_name}/${r.latest_commit}/${r.icon_path}`,
    var_count: r.var_count,
  }));
}

type OwnershipResult =
  | { status: 'ok'; app: { id: string; name: string; repo_owner: string; repo_name: string } }
  | { status: 'err'; response: Response };

async function assertOwnership(
  db: D1Database,
  appId: string,
  githubLogin: string,
): Promise<OwnershipResult> {
  const app = await db
    .prepare(`SELECT id, name, repo_owner, repo_name FROM apps WHERE id = ? AND status = 'active'`)
    .bind(appId)
    .first<{ id: string; name: string; repo_owner: string; repo_name: string }>();
  if (!app) return { status: 'err', response: htmlErrorPage('App not found', `${appId} is not registered`) };

  const owned = await db
    .prepare(
      `SELECT 1 FROM app_owners WHERE app_id = ? AND github_login = ? COLLATE NOCASE LIMIT 1`,
    )
    .bind(appId, githubLogin)
    .first();
  if (!owned) {
    return {
      status: 'err',
      response: htmlErrorPage(
        'Forbidden',
        `@${githubLogin} is not in ${appId}'s owners[]. Add them to the manifest.json and open a PR.`,
        403,
      ),
    };
  }
  return { status: 'ok', app };
}

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_VAR_PREFIXES = ['CF_', 'CLOUDFLARE_', 'CONSTRUCT_'];

function validateVarName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: 'Name is required' };
  if (!VAR_NAME_RE.test(name)) {
    return { ok: false, reason: 'Name must match /^[A-Z][A-Z0-9_]{0,63}$/' };
  }
  for (const prefix of RESERVED_VAR_PREFIXES) {
    if (name.startsWith(prefix)) {
      return { ok: false, reason: `Prefix ${prefix}* is reserved` };
    }
  }
  return { ok: true };
}

// ── Responses / redirects ──────────────────────────────────────────────────

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function appRedirect(appId: string, flash: { ok?: string; error?: string }): Response {
  const qs = new URLSearchParams();
  if (flash.ok) qs.set('ok', flash.ok);
  if (flash.error) qs.set('error', flash.error);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return redirect(`/dev/apps/${appId}${suffix}`);
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function isSameOrigin(request: Request): boolean {
  // Defense-in-depth on top of SameSite=Lax.
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin form POSTs omit Origin in some browsers
  try {
    const reqUrl = new URL(request.url);
    return new URL(origin).host === reqUrl.host;
  } catch {
    return false;
  }
}

// ── HTML ───────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}



function renderLogin(): string {
  return layout(
    'Sign in',
    `
<div class="login-card">
  <h1>Developer dashboard</h1>
  <p>Sign in with GitHub to manage env vars for apps you own on the Construct registry.</p>
  <a class="btn btn-gh" href="/dev/login">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38V14.3C3.73 14.77 3.26 13.43 3.26 13.43c-.36-.93-.88-1.17-.88-1.17-.72-.49.05-.48.05-.48.8.06 1.22.82 1.22.82.71 1.21 1.87.86 2.33.66.07-.51.28-.86.5-1.06-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    Continue with GitHub
  </a>
</div>
`,
    { activePage: 'dev' }
  );
}

function renderDashboard(session: DevSession, apps: OwnedApp[]): string {
  const appCards = apps.length
    ? apps
        .map(
          (a) => `
<a href="/dev/apps/${escapeHtml(a.id)}" class="app-card" style="display:flex; flex-direction:column; padding:24px; background:var(--surface); border:1px solid var(--border); transition:all 0.3s; gap:0;">
  <div class="app-card-header">
    <img class="app-icon" src="${escapeHtml(a.icon_url || '')}" alt="" onerror="this.style.display='none'">
    <div class="app-card-title">
      <h3>${escapeHtml(a.name)}</h3>
      <div class="repo">${escapeHtml(a.repo_owner)}/${escapeHtml(a.repo_name)}</div>
    </div>
  </div>
  <div class="app-card-meta">
    <span class="badge badge-accent">${a.var_count} env var${a.var_count !== 1 ? 's' : ''}</span>
  </div>
  <div class="app-card-footer">
    <span class="btn btn-sm btn-outline" style="width:100%;">Manage app</span>
  </div>
</a>`,
        )
        .join('')
    : '';

  const content = apps.length
    ? `<div class="apps-grid">${appCards}</div>`
    : `<div class="empty">
         <div class="empty-icon">📦</div>
         <h3>No apps found</h3>
         <p>You don't own any apps on the Construct registry yet.</p>
         <a href="/publish" class="btn">Learn how to publish an app</a>
       </div>`;

  return layout(
    'Dashboard',
    `
<div class="container">
<h1>Developer Dashboard</h1>
<p class="lede">Manage environment variables for your Construct apps.</p>
${content}
</div>
`,
    { activePage: 'dev', session }
  );
}

function renderAppPage(
  session: DevSession,
  app: { id: string; name: string; repo_owner: string; repo_name: string },
  vars: Array<{ name: string; updated_at: number; updated_by: string }>,
): string {
  // Flash banner is injected later by injectFlashFromQuery based on ?ok=/?error=
  const flashPlaceholder = '<!--FLASH-->';

  const envList = vars.length
    ? vars
        .map(
          (v) => `
<div class="env-item">
  <span class="env-key">${escapeHtml(v.name)}</span>
  <span class="env-meta">${new Date(v.updated_at).toISOString().slice(0, 10)} by @${escapeHtml(v.updated_by)}</span>
  <div class="env-actions">
    <form method="post" action="/dev/apps/${escapeHtml(app.id)}/env/delete" onsubmit="return confirm('Delete ${escapeHtml(v.name)}?')">
      <input type="hidden" name="name" value="${escapeHtml(v.name)}">
      <button class="btn btn-sm" style="background:transparent;border:1px solid rgba(239,68,68,0.3);color:var(--danger)">Delete</button>
    </form>
  </div>
</div>`,
        )
        .join('')
    : `<div class="empty" style="padding:32px 24px"><p>No environment variables configured.</p></div>`;
  
  return layout(
    app.name,
    `
<div class="container">
${flashPlaceholder}
<div class="app-layout">
  <main class="main-content">
    <h1>${escapeHtml(app.name)}</h1>
    <p class="lede">${escapeHtml(app.repo_owner)}/${escapeHtml(app.repo_name)}</p>
    
    <h2>Environment Variables</h2>
    <div class="env-list">
      ${envList}
    </div>
  </main>
  
  <aside class="sidebar">
    <div class="sidebar-section">
      <h3>Add Environment Variable</h3>
      <form method="post" action="/dev/apps/${escapeHtml(app.id)}/env">
        <div class="form-group">
          <label for="name">Variable name</label>
          <input type="text" id="name" name="name" placeholder="API_KEY" required pattern="[A-Z][A-Z0-9_]*" title="Must start with uppercase letter, contain only A-Z, 0-9, and underscores">
        </div>
        <div class="form-group">
          <label for="value">Value</label>
          <input type="password" id="value" name="value" placeholder="secret-value" required>
        </div>
        <button type="submit" class="btn" style="width:100%">Add Variable</button>
      </form>
    </div>
    
    <div class="sidebar-section">
      <h3>About</h3>
      <p style="font-size:13px;color:var(--text-secondary);line-height:1.6">
        Environment variables are encrypted and only available to your app at runtime. 
        Values are never displayed after creation.
      </p>
    </div>
  </aside>
</div>
</div>`,
    { activePage: 'dev', session }
  );
}

function htmlErrorPage(title: string, detail: string, status = 400): Response {
  return new Response(
    layout(
      title,
      `<div class="login-card">
         <h1>${escapeHtml(title)}</h1>
         <p>${escapeHtml(detail)}</p>
         <a class="btn" href="/dev/dashboard">Back to dashboard</a>
       </div>`,
      { activePage: 'dev' }
    ),
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

// ── Page-level flash rendering ─────────────────────────────────────────────
// The app page uses a placeholder that the dispatcher replaces with a flash
// banner if the URL has ?ok=... or ?error=... — keeps the per-app render
// function simple while still surfacing form feedback.

export function injectFlashFromQuery(html: string, url: URL): string {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('error');
  if (!ok && !err) return html.replace('<!--FLASH-->', '');
  const flash = err
    ? `<div class="flash flash-error">${escapeHtml(err)}</div>`
    : `<div class="flash flash-ok">${escapeHtml(ok || '')}</div>`;
  return html.replace('<!--FLASH-->', flash);
}

// Convenience re-export for index.ts
export { renderLogin as _renderLoginPage };
