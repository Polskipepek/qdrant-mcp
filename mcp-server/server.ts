import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const CHAT_MODEL = process.env.CHAT_MODEL ?? "llama3.2";
const COLLECTION_NAME = process.env.COLLECTION_NAME ?? "codebase";
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE ?? "768", 10);
const SEARCH_TOP_K = parseInt(process.env.SEARCH_TOP_K ?? "5", 10);

const qdrant = new QdrantClient({ url: QDRANT_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama embed failed: ${response.status} ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { embedding: number[] };
  return json.embedding;
}

async function generate(context: string, question: string): Promise<string> {
  const prompt = [
    "You are a helpful assistant. Answer based only on the context below.",
    "",
    "CONTEXT:",
    context,
    "",
    `QUESTION: ${question}`,
  ].join("\n");

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, prompt, stream: false }),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama generate failed: ${response.status} ${await response.text()}`,
    );
  }
  const json = (await response.json()) as { response: string };
  return json.response;
}

/**
 * Ensure the shared collection exists with the correct vector config
 * and payload indexes on 'repo' and 'source' for fast filtered queries.
 */
async function ensureCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(
    (c) => c.name === COLLECTION_NAME,
  );

  if (!exists) {
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });

    // Index the fields we filter on — critical for performance at scale.
    // Without these indexes Qdrant does a full scan on every filtered query.
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "repo",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "source",
      field_schema: "keyword",
    });
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "language",
      field_schema: "keyword",
    });
  }
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Build a Qdrant filter that optionally scopes results to a single repo.
 * When repo is undefined the filter is omitted so all repos are searched.
 */
function repoFilter(repo: string | undefined) {
  if (!repo) return undefined;
  return {
    must: [
      {
        key: "repo",
        match: { value: repo },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "qdrant-mcp",
  version: "2.0.0",
});

// ── Health ──────────────────────────────────────────────────────────────────

server.registerTool(
  "qdrant_health",
  {
    title: "Qdrant health",
    description: "Check whether Qdrant is reachable and return server info",
    inputSchema: {},
  },
  async () => {
    try {
      const collections = await qdrant.getCollections();
      return {
        content: [{ type: "text", text: JSON.stringify(collections, null, 2) }],
        structuredContent: collections,
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "ollama_health",
  {
    title: "Ollama health",
    description: "Check whether Ollama is reachable and return its version",
    inputSchema: {},
  },
  async () => {
    try {
      const response = await fetch(OLLAMA_URL);
      const text = await response.text();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Collection management ────────────────────────────────────────────────────

server.registerTool(
  "qdrant_list_collections",
  {
    title: "List Qdrant collections",
    description: "Return all collections stored in Qdrant",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await qdrant.getCollections();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "qdrant_create_collection",
  {
    title: "Create Qdrant collection",
    description:
      "Create a named vector collection. 'size' must match embedding model output (nomic-embed-text = 768).",
    inputSchema: {
      name: z.string().min(1),
      size: z.number().int().positive(),
      distance: z.enum(["Cosine", "Euclid", "Dot"]).optional(),
    },
  },
  async ({ name, size, distance }) => {
    try {
      const result = await qdrant.createCollection(name, {
        vectors: { size, distance: distance ?? "Cosine" },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: result, name, size }, null, 2),
          },
        ],
        structuredContent: { ok: result, name, size },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "qdrant_delete_collection",
  {
    title: "Delete Qdrant collection",
    description: "Permanently delete a collection and all its vectors",
    inputSchema: { name: z.string().min(1) },
  },
  async ({ name }) => {
    try {
      const result = await qdrant.deleteCollection(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: result, deleted: name }, null, 2),
          },
        ],
        structuredContent: { ok: result, deleted: name },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── Repo listing ─────────────────────────────────────────────────────────────

server.registerTool(
  "rag_list_repos",
  {
    title: "List ingested repos",
    description:
      "Return distinct repo names that have been ingested into the shared collection. " +
      "Use the returned names as the 'repo' filter in rag_search and rag_ask.",
    inputSchema: {},
  },
  async () => {
    try {
      await ensureCollection();
      // Scroll through all points requesting only the 'repo' payload field
      const seen = new Set<string>();
      let offset: string | number | null = null;

      do {
        const page = await qdrant.scroll(COLLECTION_NAME, {
          limit: 250,
          offset: offset ?? undefined,
          with_payload: ["repo"],
          with_vector: false,
        });

        for (const point of page.points) {
          const r = (point.payload as Record<string, unknown>)["repo"];
          if (typeof r === "string") seen.add(r);
        }
        offset = page.next_page_offset ?? null;
      } while (offset !== null);

      const repos = Array.from(seen).sort();
      return {
        content: [
          {
            type: "text",
            text: repos.length ? repos.join("\n") : "No repos ingested yet.",
          },
        ],
        structuredContent: { repos },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── RAG — Ingest ─────────────────────────────────────────────────────────────

server.registerTool(
  "rag_ingest",
  {
    title: "Ingest text into the shared RAG collection",
    description:
      "Chunk text, embed with Ollama, and upsert into the shared Qdrant collection. " +
      "Always supply 'repo' (e.g. 'my-api') and 'source' (file path or URL) so results can be filtered later.",
    inputSchema: {
      text: z.string().min(1),
      repo: z
        .string()
        .min(1)
        .describe("Repository or project name, e.g. 'bb-pay'"),
      source: z.string().min(1).describe("File path or URL the text came from"),
      language: z
        .string()
        .optional()
        .describe(
          "Programming language or doc type, e.g. 'csharp', 'markdown'",
        ),
      branch: z.string().optional().describe("Git branch name"),
      chunkSize: z.number().int().positive().optional(),
    },
  },
  async ({ text, repo, source, language, branch, chunkSize = 500 }) => {
    try {
      await ensureCollection();

      const overlap = Math.floor(chunkSize * 0.1);
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += chunkSize - overlap) {
        const chunk = text.slice(i, i + chunkSize).trim();
        if (chunk.length > 0) chunks.push(chunk);
      }

      const points = await Promise.all(
        chunks.map(async (chunk, index) => {
          const vector = await embed(chunk);
          return {
            id: Date.now() * 1000 + index,
            vector,
            payload: {
              text: chunk,
              repo,
              source,
              ...(language ? { language } : {}),
              ...(branch ? { branch } : {}),
            },
          };
        }),
      );

      await qdrant.upsert(COLLECTION_NAME, { wait: true, points });

      return {
        content: [
          {
            type: "text",
            text: `Ingested ${points.length} chunks from '${source}' (repo: ${repo}).`,
          },
        ],
        structuredContent: { ingested: points.length, repo, source },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── RAG — Delete repo ────────────────────────────────────────────────────────

server.registerTool(
  "rag_delete_repo",
  {
    title: "Delete all vectors for a repo",
    description:
      "Remove all ingested chunks for a specific repo from the shared collection.",
    inputSchema: {
      repo: z.string().min(1),
    },
  },
  async ({ repo }) => {
    try {
      await ensureCollection();
      await qdrant.delete(COLLECTION_NAME, {
        wait: true,
        filter: {
          must: [{ key: "repo", match: { value: repo } }],
        },
      });
      return {
        content: [
          { type: "text", text: `Deleted all vectors for repo '${repo}'.` },
        ],
        structuredContent: { deleted: true, repo },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── RAG — Search ─────────────────────────────────────────────────────────────

server.registerTool(
  "rag_search",
  {
    title: "Semantic search",
    description:
      "Embed a query and return the top-K most similar chunks from the shared collection. " +
      "Optionally filter to a single repo. Leave 'repo' empty to search across all repos.",
    inputSchema: {
      query: z.string().min(1),
      repo: z
        .string()
        .optional()
        .describe("Scope search to this repo only. Omit to search all repos."),
      topK: z.number().int().positive().optional(),
    },
  },
  async ({ query, repo, topK = SEARCH_TOP_K }) => {
    try {
      const vector = await embed(query);
      const results = await qdrant.search(COLLECTION_NAME, {
        vector,
        limit: topK,
        with_payload: true,
        filter: repoFilter(repo),
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const formatted = results
        .map((r, i) => {
          const p = r.payload as Record<string, unknown>;
          return `[${i + 1}] score=${r.score.toFixed(4)} | repo=${p["repo"]} | ${p["source"]}\n${p["text"]}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text: formatted }],
        structuredContent: results,
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ── RAG — Ask ────────────────────────────────────────────────────────────────

server.registerTool(
  "rag_ask",
  {
    title: "Ask a question using local RAG",
    description:
      "Retrieve relevant chunks from the shared collection, then generate an answer with the local Llama model. " +
      "Optionally scope retrieval to a single repo.",
    inputSchema: {
      question: z.string().min(1),
      repo: z
        .string()
        .optional()
        .describe(
          "Scope context retrieval to this repo. Omit to search all repos.",
        ),
      topK: z.number().int().positive().optional(),
    },
  },
  async ({ question, repo, topK = SEARCH_TOP_K }) => {
    try {
      const vector = await embed(question);
      const results = await qdrant.search(COLLECTION_NAME, {
        vector,
        limit: topK,
        with_payload: true,
        filter: repoFilter(repo),
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No relevant context found in the collection.",
            },
          ],
        };
      }

      const context = results
        .map((r, i) => {
          const p = r.payload as Record<string, unknown>;
          return `[${i + 1}] (${p["repo"]} / ${p["source"]})\n${p["text"]}`;
        })
        .join("\n\n");

      const answer = await generate(context, question);

      return {
        content: [{ type: "text", text: answer }],
        structuredContent: { answer, sources: results },
      };
    } catch (err) {
      return toolError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
