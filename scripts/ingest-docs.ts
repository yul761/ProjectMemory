#!/usr/bin/env tsx
/**
 * Ingest a folder of documents into a StateCore scope.
 *
 * Usage:
 *   pnpm ingest:docs --dir <path> --scope <id|name>
 *   pnpm ingest:docs --dir <path> --scope <id|name> --token my-token --url http://localhost:3002
 *   pnpm ingest:docs --dir <path> --scope <id|name> --dry-run
 *
 * Options:
 *   --dir      Folder to read (recursive)
 *   --scope    Scope ID (UUID) or scope name
 *   --token    x-user-id header value (default: local-dev-user)
 *   --url      StateCore API base URL (default: http://localhost:3002)
 *   --ext      Comma-separated file extensions to include (default: .md)
 *   --no-digest  Skip triggering digest after ingestion
 *   --dry-run  Print files that would be ingested without sending
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    dir: get("--dir"),
    scope: get("--scope"),
    token: get("--token") ?? "local-dev-user",
    url: get("--url") ?? "http://localhost:3002",
    ext: (get("--ext") ?? ".md").split(",").map((e) => e.trim()),
    digest: !args.includes("--no-digest"),
    dryRun: args.includes("--dry-run")
  };
}

function walkDir(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full, extensions));
    } else if (extensions.includes(extname(entry).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function pathToKey(filePath: string, baseDir: string): string {
  const rel = relative(baseDir, filePath);
  const parts = rel.replace(/\\/g, "/").split("/");
  const slugged = parts.map((part, i) => {
    const stripped = (i === parts.length - 1 ? part.replace(/\.md$/i, "") : part)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    return stripped || `file-${Buffer.from(part).toString("hex").slice(0, 8)}`;
  });
  return slugged.join("/");
}

async function resolveScopeId(baseUrl: string, token: string, scopeInput: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scopeInput)) {
    return scopeInput;
  }
  const res = await fetch(`${baseUrl}/scopes`, {
    headers: { "x-user-id": token }
  });
  if (!res.ok) throw new Error(`Failed to list scopes: ${res.status}`);
  const data = await res.json() as Array<{ id: string; name: string }>;
  const items = Array.isArray(data) ? data : (data as any).items ?? [];
  const match = items.find((s: { name: string }) => s.name === scopeInput);
  if (!match) throw new Error(`Scope not found: "${scopeInput}". Available: ${items.map((s: { name: string }) => s.name).join(", ")}`);
  return match.id;
}

async function ingestDocument(baseUrl: string, token: string, scopeId: string, key: string, content: string) {
  const res = await fetch(`${baseUrl}/memory/events`, {
    method: "POST",
    headers: {
      "x-user-id": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ scopeId, type: "document", source: "api", key, content })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { id: string };
}

async function triggerDigest(baseUrl: string, token: string, scopeId: string) {
  const res = await fetch(`${baseUrl}/memory/digest`, {
    method: "POST",
    headers: {
      "x-user-id": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ scopeId })
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`  [warn] digest trigger failed (${res.status}): ${text}`);
    return;
  }
  const { jobId } = (await res.json()) as { jobId: string };
  console.log(`  digest job queued: ${jobId}`);
}

async function main() {
  const args = parseArgs();

  if (!args.dir || !args.scope) {
    console.error("Usage: ingest-docs.ts --dir <path> --scope <id|name> [options]");
    process.exit(1);
  }

  const files = walkDir(args.dir, args.ext);
  if (files.length === 0) {
    console.log(`No ${args.ext.join("/")} files found in ${args.dir}`);
    return;
  }

  console.log(`Found ${files.length} file(s) in ${args.dir}`);

  if (args.dryRun) {
    for (const f of files) {
      console.log(`  [dry-run] ${pathToKey(f, args.dir)} (${f})`);
    }
    return;
  }

  const scopeId = await resolveScopeId(args.url, args.token, args.scope);
  console.log(`Scope: ${args.scope} → ${scopeId}`);

  let ok = 0;
  let fail = 0;
  for (const file of files) {
    const key = pathToKey(file, args.dir);
    const content = readFileSync(file, "utf8");
    try {
      const event = await ingestDocument(args.url, args.token, scopeId, key, content);
      console.log(`  [ok] ${key} → event ${event.id}`);
      ok++;
    } catch (err) {
      console.error(`  [fail] ${key}: ${err}`);
      fail++;
    }
  }

  console.log(`\nIngested: ${ok} ok, ${fail} failed`);

  if (args.digest && ok > 0) {
    console.log("Triggering digest...");
    await triggerDigest(args.url, args.token, scopeId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
