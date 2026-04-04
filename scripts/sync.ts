#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-run

/**
 * Sync script — reads app pointers from apps/*.json, clones each repo
 * at the pinned commit, extracts metadata from manifest.json, and
 * POSTs the full payload to the registry Worker's /v1/sync endpoint.
 */

import { existsSync } from "https://deno.land/std@0.224.0/fs/exists.ts";

const SYNC_URL = Deno.env.get("REGISTRY_SYNC_URL");
const SYNC_SECRET = Deno.env.get("REGISTRY_SYNC_SECRET");

if (!SYNC_URL || !SYNC_SECRET) {
  console.error("Missing REGISTRY_SYNC_URL or REGISTRY_SYNC_SECRET");
  Deno.exit(1);
}

interface AppPointer {
  repo: string;
  versions: Array<{ version: string; commit: string; date: string }>;
}

interface Manifest {
  name: string;
  description: string;
  author?: { name: string; url?: string };
  categories?: string[];
  tags?: string[];
  ui?: unknown;
  tools?: Array<{ name: string; description: string }>;
  permissions?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

const apps: unknown[] = [];
const collections: unknown[] = [];

// Load verified list — org-based auto-verify + manual app IDs
let verifiedOrgs = new Set<string>();
let verifiedAppIds = new Set<string>();
try {
  if (existsSync("verified.json")) {
    const data = JSON.parse(await Deno.readTextFile("verified.json")) as {
      orgs?: string[];
      apps?: string[];
    };
    verifiedOrgs = new Set((data.orgs ?? []).map((o) => o.toLowerCase()));
    verifiedAppIds = new Set((data.apps ?? []).map((a) => a.toLowerCase()));
    console.log(
      `Verified: ${verifiedOrgs.size} orgs, ${verifiedAppIds.size} apps`
    );
  }
} catch (err) {
  console.warn(`Warning: Failed to read verified.json: ${err}`);
}

// Process each app pointer
for await (const entry of Deno.readDir("apps")) {
  if (!entry.name.endsWith(".json")) continue;
  const appId = entry.name.replace(/\.json$/, "");
  console.log(`Processing: ${appId}`);

  const pointer: AppPointer = JSON.parse(
    await Deno.readTextFile(`apps/${entry.name}`)
  );

  const latestVersion = pointer.versions[pointer.versions.length - 1];
  if (!latestVersion || latestVersion.commit === "PENDING") {
    console.log(`  Skipping ${appId} — commit is PENDING`);
    continue;
  }

  // Clone repo at pinned commit
  const tmpdir = await Deno.makeTempDir();
  const clone = new Deno.Command("git", {
    args: ["clone", "--depth=100", `${pointer.repo}.git`, tmpdir],
    stderr: "null",
  });
  const cloneResult = await clone.output();
  if (!cloneResult.success) {
    console.error(`  Failed to clone ${pointer.repo}`);
    await Deno.remove(tmpdir, { recursive: true });
    continue;
  }

  const checkout = new Deno.Command("git", {
    args: ["checkout", latestVersion.commit],
    cwd: tmpdir,
    stderr: "null",
  });
  await checkout.output();

  // Read manifest
  const manifestPath = `${tmpdir}/manifest.json`;
  if (!existsSync(manifestPath)) {
    console.error(`  No manifest.json found in ${appId}`);
    await Deno.remove(tmpdir, { recursive: true });
    continue;
  }

  const manifest: Manifest = JSON.parse(
    await Deno.readTextFile(manifestPath)
  );

  // Detect icon
  let iconPath = "icon.png";
  if (existsSync(`${tmpdir}/icon.svg`)) iconPath = "icon.svg";
  else if (existsSync(`${tmpdir}/icon.jpg`)) iconPath = "icon.jpg";

  // Count screenshots
  let screenshotCount = 0;
  try {
    for await (const f of Deno.readDir(`${tmpdir}/screenshots`)) {
      if (f.name.endsWith(".png")) screenshotCount++;
    }
  } catch {
    // no screenshots dir
  }

  // Extract long description from README
  let longDescription = "";
  const readmePath = `${tmpdir}/README.md`;
  if (existsSync(readmePath)) {
    const readme = await Deno.readTextFile(readmePath);
    const lines = readme.split("\n");
    const paragraphLines: string[] = [];
    let inParagraph = false;
    for (const line of lines) {
      if (!inParagraph && line.match(/^[^#\[<\s]/) && line.trim()) {
        inParagraph = true;
      }
      if (inParagraph) {
        if (line.trim() === "") break;
        paragraphLines.push(line);
      }
    }
    longDescription = paragraphLines.slice(0, 20).join("\n");
  }

  // Parse repo owner/name
  const repoMatch = pointer.repo.match(
    /github\.com\/([^/]+)\/([^/]+)/
  );
  const repoOwner = repoMatch?.[1] ?? "";
  const repoName = repoMatch?.[2] ?? "";

  // Build version array
  const versionArray = pointer.versions.map((v) => ({
    version: v.version,
    commit: v.commit,
    date: v.date,
    changelog: "",
    manifest,
  }));

  apps.push({
    id: appId,
    name: manifest.name,
    description: manifest.description,
    long_description: longDescription,
    author_name: manifest.author?.name ?? "Unknown",
    author_url: manifest.author?.url ?? "",
    repo_owner: repoOwner,
    repo_name: repoName,
    icon_path: iconPath,
    screenshot_count: screenshotCount,
    category: manifest.categories?.[0] ?? "utilities",
    tags: (manifest.tags ?? []).join(","),
    has_ui: !!manifest.ui || existsSync(`${tmpdir}/ui`),
    verified:
      verifiedOrgs.has(repoOwner.toLowerCase()) ||
      verifiedAppIds.has(appId.toLowerCase()),
    tools: (manifest.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    permissions: manifest.permissions ?? {},
    versions: versionArray,
  });

  await Deno.remove(tmpdir, { recursive: true });
  console.log(`  ✓ ${manifest.name} (${pointer.versions.length} versions)`);
}

// Process collections
try {
  for await (const entry of Deno.readDir("collections")) {
    if (!entry.name.endsWith(".json")) continue;
    const col = JSON.parse(
      await Deno.readTextFile(`collections/${entry.name}`)
    );
    collections.push(col);
  }
} catch {
  // no collections dir
}

// Process curated integrations
let curated: unknown[] = [];
try {
  if (existsSync("curated.json")) {
    const data = JSON.parse(await Deno.readTextFile("curated.json")) as {
      apps?: Array<{
        slug: string;
        name: string;
        description: string;
        category: string;
        source?: string;
        icon_url?: string;
        sort_order?: number;
      }>;
    };
    curated = data.apps ?? [];
    console.log(`Found ${curated.length} curated integrations`);
  }
} catch (err) {
  console.warn(`Warning: Failed to read curated.json: ${err}`);
}

const payload = { apps, collections, curated };
console.log(`\nSyncing ${apps.length} apps to registry...`);

const response = await fetch(`${SYNC_URL}/v1/sync`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SYNC_SECRET}`,
  },
  body: JSON.stringify(payload),
});

const result = await response.text();
console.log(`Response: ${response.status} ${result}`);

if (!response.ok) {
  console.error("Sync failed!");
  Deno.exit(1);
}

console.log("Sync complete.");
