#!/usr/bin/env tsx
/**
 * File watcher daemon — watches multiple repo directories and auto-ingests
 * changed files into the shared Qdrant collection.
 *
 * Configure watched repos in watcher-config.json at project root.
 *
 * Usage:
 *   tsx scripts/watcher.ts
 *   npm run watch
 */
import chokidar from "chokidar";
import { readFileSync, existsSync } from "fs";
import { resolve, extname, join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const COLLECTION_NAME = process.env.COLLECTION_NAME ?? "codebase";
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE ?? "768", 10);
const DEBOUNCE_MS = parseInt(process.env.WATCH_DEBOUNCE_MS ?? "1500", 10);
const CHUNK_SIZE = 500;
const OVERLAP = Math.floor(CHUNK_SIZE * 0.1);

interface RepoConfig {
  /** Human-readable name stored in payload — used as filter key */
  repo: string;
  /** Absolute path to the repo root */
  dir: string;
  /** Extensions to watch. Defaults to DEFAULT_EXTENSIONS if omitted. */
  extensions?: string[];
  /** Glob patterns to ignore inside this repo */
  ignore?: string[];
}

const DEFAULT_EXTENSIONS = [
  ".cs", ".ts", ".tsx", ".js", ".jsx",
  ".md", ".txt", ".json", ".yaml", ".yml",
  ".sql", ".csproj",
];

const DEFAULT_IGNORE = [
  "**/node_modules/**", "**/dist/**", "**/bin/**", "**/obj/**",
  "**/.git/**", "**/.next/**", "**/.expo/**", "**/coverage/**",
  "**/__pycache__/**",
];

// Load watcher-config.json from repo root
const configPath = resolve(new URL("../watcher-config.json", import.meta.url).pathname);
if (!existsSync(configPath)) {
  console.error(`ERROR: watcher-config.json not found at ${configPath}`);
  console.error("Copy watcher-config.example.json to watcher-config.json and configure your repos.");
  process.exit(1);
}

const watchedRepos: RepoConfig[] = JSON.parse(readFileSync(configPath, "utf8"));
if (!Array.isArray(watchedRepos) || watchedRepos.length === 0) {
  console.error("ERROR: watcher-config.json must be a non-empty array of repo configs.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status}`);
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}

async function ensureCollection(): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
  if (res.status === 200) return;
  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: "Cosine" } }),
  });
  for (const field of ["repo", "source", "language"]) {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }
  console.log(`[watcher] Created collection '${COLLECTION_NAME}'.`);
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - OVERLAP) {
    const c = text.slice(i, i + CHUNK_SIZE).trim();
    if (c) chunks.push(c);
  }
  return chunks;
}

function getBranch(dir: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function ingestFile(filePath: string, repo: string): Promise<void> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  if (!content.trim()) return;

  const chunks = chunkText(content);
  const language = extname(filePath).slice(1);
  const branch = getBranch(resolve(filePath, ".."));

  // Delete stale vectors for this file before re-inserting
  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wait: true,
      filter: { must: [{ key: "source", match: { value: filePath } }] },
    }),
  });

  const points = await Promise.all(
    chunks.map(async (chunk, index) => {
      const vector = await embed(chunk);
      return {
        id: Date.now() * 1000 + index,
        vector,
        payload: { text: chunk, repo, source: filePath, language, branch },
      };
    }),
  );

  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wait: true, points }),
  });

  console.log(`[watcher] ${repo} | ${filePath} → ${points.length} chunks`);
}

async function deleteFile(filePath: string): Promise<void> {
  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/points/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wait: true,
      filter: { must: [{ key: "source", match: { value: filePath } }] },
    }),
  });
  console.log(`[watcher] Removed vectors for deleted file: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Debounce queue — batch rapid save events
// ---------------------------------------------------------------------------
const pending = new Map<string, { repo: string; timer: ReturnType<typeof setTimeout> }>();

function scheduleIngest(filePath: string, repo: string): void {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(async () => {
    pending.delete(filePath);
    try {
      await ingestFile(filePath, repo);
    } catch (err) {
      console.error(`[watcher] Error ingesting ${filePath}:`, err);
    }
  }, DEBOUNCE_MS);
  pending.set(filePath, { repo, timer });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
await ensureCollection();

for (const repoConfig of watchedRepos) {
  const exts = repoConfig.extensions ?? DEFAULT_EXTENSIONS;
  const ignore = [...DEFAULT_IGNORE, ...(repoConfig.ignore ?? [])];

  const watcher = chokidar.watch(repoConfig.dir, {
    ignored: ignore,
    persistent: true,
    ignoreInitial: true, // Don't re-ingest everything on startup
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher
    .on("add", (p) => { if (exts.includes(extname(p))) scheduleIngest(p, repoConfig.repo); })
    .on("change", (p) => { if (exts.includes(extname(p))) scheduleIngest(p, repoConfig.repo); })
    .on("unlink", (p) => { if (exts.includes(extname(p))) deleteFile(p).catch(console.error); });

  console.log(`[watcher] Watching '${repoConfig.repo}' at ${repoConfig.dir}`);
}

console.log(`[watcher] Ready. Debounce: ${DEBOUNCE_MS}ms | Collection: ${COLLECTION_NAME}`);
