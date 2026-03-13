#!/usr/bin/env tsx
/// <reference types="node" />
/**
 * CLI ingest script — called by git hooks and manually.
 *
 * Usage:
 *   tsx scripts/ingest.ts --dir /path/to/repo --repo my-api
 *   tsx scripts/ingest.ts --dir /path/to/repo --repo my-api --ext .cs,.ts,.md
 *   tsx scripts/ingest.ts --file /path/to/file.ts --repo my-api
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, extname, join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const COLLECTION_NAME = process.env.COLLECTION_NAME ?? "codebase";
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE ?? "768", 10);
const CHUNK_SIZE = 500;
const OVERLAP = Math.floor(CHUNK_SIZE * 0.1);

// Default extensions to ingest — matches common .NET + React project files
const DEFAULT_EXTENSIONS = new Set([
  ".cs",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".sql",
  ".csproj",
  ".sln",
]);

// Directories to always skip
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "bin",
  "obj",
  ".git",
  ".next",
  ".expo",
  "coverage",
  ".vs",
  "__pycache__",
  "android",
  ".gradle",
  "build",
]);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const targetDir = arg("--dir");
const targetFile = arg("--file");
const repoName = arg("--repo");
const extArg = arg("--ext");
const branch = arg("--branch") ?? currentBranch();

function currentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

if (!repoName) {
  console.error("ERROR: --repo is required");
  process.exit(1);
}
if (!targetDir && !targetFile) {
  console.error("ERROR: --dir or --file is required");
  process.exit(1);
}

const allowedExts = extArg
  ? new Set(
      extArg.split(",").map((e) => {
        const t = e.trim().toLowerCase();
        return t.startsWith(".") ? t : `.${t}`;
      }),
    )
  : DEFAULT_EXTENSIONS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embed(text: string): Promise<number[]> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
      const json = (await res.json()) as { embedding: number[] };
      return json.embedding;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const backoff = 500 * Math.pow(2, attempt - 1);
      console.warn(
        `Embedding attempt ${attempt} failed — retrying in ${backoff}ms: ${err}`,
      );
      await sleep(backoff);
    }
  }
  throw new Error("Embedding failed after retries");
}

async function ensureCollection(): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`);
  if (res.status === 200) return;

  await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    }),
  });

  for (const field of ["repo", "source", "language"]) {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }
  console.log(`Created collection '${COLLECTION_NAME}' with payload indexes.`);
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - OVERLAP) {
    const chunk = text.slice(i, i + CHUNK_SIZE).trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

async function ingestFile(filePath: string): Promise<number> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  if (!content.trim()) return 0;

  const chunks = chunkText(content);
  const ext = extname(filePath).slice(1);
  const source = filePath;

  const points = await Promise.all(
    chunks.map(async (chunk, index) => {
      const vector = await embed(chunk);
      return {
        id: Date.now() * 1000 + index,
        vector,
        payload: {
          text: chunk,
          repo: repoName!,
          source,
          language: ext,
          branch,
        },
      };
    }),
  );

  const res = await fetch(
    `${QDRANT_URL}/collections/${COLLECTION_NAME}/points`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wait: true, points }),
    },
  );
  if (!res.ok)
    throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  return points.length;
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (allowedExts.has(extname(full))) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await ensureCollection();

  const files = targetFile
    ? [resolve(targetFile)]
    : collectFiles(resolve(targetDir!));
  console.log(
    `Ingesting ${files.length} files into collection '${COLLECTION_NAME}' as repo='${repoName}'...`,
  );

  let totalChunks = 0;
  for (const file of files) {
    const n = await ingestFile(file);
    if (n > 0) console.log(`  ✓ ${file} → ${n} chunks`);
    totalChunks += n;
  }

  console.log(`Done. Total chunks ingested: ${totalChunks}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
