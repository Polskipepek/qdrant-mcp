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
const SEARCH_TOP_K = parseInt(process.env.SEARCH_TOP_K ?? "5", 10);
const qdrant = new QdrantClient({ url: QDRANT_URL });
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Call Ollama /api/embeddings and return the embedding vector. */
async function embed(text) {
    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
    });
    if (!response.ok) {
        throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json());
    return json.embedding;
}
/** Call Ollama /api/generate with a context string and user question. */
async function generate(context, question) {
    const prompt = [
        "You are a helpful assistant. Use only the context below to answer the question.",
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
        throw new Error(`Ollama generate failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json());
    return json.response;
}
function toolError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
}
// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: "qdrant-mcp",
    version: "1.0.0",
});
// ── Health ──────────────────────────────────────────────────────────────────
server.registerTool("qdrant_health", {
    title: "Qdrant health",
    description: "Check whether Qdrant is reachable and return server info",
    inputSchema: {},
}, async () => {
    try {
        const collections = await qdrant.getCollections();
        return {
            content: [{ type: "text", text: JSON.stringify(collections, null, 2) }],
            structuredContent: collections,
        };
    }
    catch (err) {
        return toolError(err);
    }
});
server.registerTool("ollama_health", {
    title: "Ollama health",
    description: "Check whether Ollama is reachable and return its version",
    inputSchema: {},
}, async () => {
    try {
        const response = await fetch(`${OLLAMA_URL}`);
        const text = await response.text();
        return {
            content: [{ type: "text", text }],
        };
    }
    catch (err) {
        return toolError(err);
    }
});
// ── Collections ─────────────────────────────────────────────────────────────
server.registerTool("qdrant_list_collections", {
    title: "List Qdrant collections",
    description: "Return all collections stored in Qdrant",
    inputSchema: {},
}, async () => {
    try {
        const result = await qdrant.getCollections();
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
        };
    }
    catch (err) {
        return toolError(err);
    }
});
server.registerTool("qdrant_create_collection", {
    title: "Create Qdrant collection",
    description: "Create a named vector collection. The 'size' must match the embedding model output dimension (nomic-embed-text = 768, llama3.2 = 3072).",
    inputSchema: {
        name: z.string().min(1),
        size: z.number().int().positive(),
        distance: z.enum(["Cosine", "Euclid", "Dot"]).optional(),
    },
}, async ({ name, size, distance }) => {
    try {
        const result = await qdrant.createCollection(name, {
            vectors: { size, distance: distance ?? "Cosine" },
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ ok: result, name, size, distance: distance ?? "Cosine" }, null, 2),
                },
            ],
            structuredContent: {
                ok: result,
                name,
                size,
                distance: distance ?? "Cosine",
            },
        };
    }
    catch (err) {
        return toolError(err);
    }
});
server.registerTool("qdrant_delete_collection", {
    title: "Delete Qdrant collection",
    description: "Permanently delete a collection and all its vectors",
    inputSchema: {
        name: z.string().min(1),
    },
}, async ({ name }) => {
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
    }
    catch (err) {
        return toolError(err);
    }
});
// ── RAG — Ingest ─────────────────────────────────────────────────────────────
server.registerTool("rag_ingest", {
    title: "Ingest text into RAG",
    description: "Split text into chunks, embed each chunk with Ollama, and upsert into a Qdrant collection. " +
        "The collection must already exist with a vector size matching the embedding model.",
    inputSchema: {
        collection: z.string().min(1),
        text: z.string().min(1),
        chunkSize: z.number().int().positive().optional(),
        metadata: z.record(z.string(), z.any()).optional(),
    },
}, async ({ collection, text, chunkSize = 500, metadata = {} }) => {
    try {
        // Split text into overlapping chunks
        const chunks = [];
        const overlap = Math.floor(chunkSize * 0.1);
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
            const chunk = text.slice(i, i + chunkSize).trim();
            if (chunk.length > 0)
                chunks.push(chunk);
        }
        const points = await Promise.all(chunks.map(async (chunk, index) => {
            const vector = await embed(chunk);
            return {
                id: Date.now() * 1000 + index,
                vector,
                payload: { text: chunk, ...metadata },
            };
        }));
        await qdrant.upsert(collection, { wait: true, points });
        return {
            content: [
                {
                    type: "text",
                    text: `Ingested ${points.length} chunks into collection '${collection}'.`,
                },
            ],
            structuredContent: { ingested: points.length, collection },
        };
    }
    catch (err) {
        return toolError(err);
    }
});
// ── RAG — Search ─────────────────────────────────────────────────────────────
server.registerTool("rag_search", {
    title: "Semantic search",
    description: "Embed a query with Ollama and return the top-K most similar chunks from a Qdrant collection.",
    inputSchema: {
        collection: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().positive().optional(),
    },
}, async ({ collection, query, topK = SEARCH_TOP_K }) => {
    try {
        const vector = await embed(query);
        const results = await qdrant.search(collection, {
            vector,
            limit: topK,
            with_payload: true,
        });
        const formatted = results
            .map((r, i) => `[${i + 1}] score=${r.score.toFixed(4)}\n${r.payload?.["text"] ?? ""}`)
            .join("\n\n");
        return {
            content: [{ type: "text", text: formatted || "No results found." }],
            structuredContent: { results },
        };
    }
    catch (err) {
        return toolError(err);
    }
});
// ── RAG — Ask ────────────────────────────────────────────────────────────────
server.registerTool("rag_ask", {
    title: "Ask a question using RAG",
    description: "Embed the question, retrieve relevant chunks from Qdrant, then generate an answer using the local Ollama Llama model.",
    inputSchema: {
        collection: z.string().min(1),
        question: z.string().min(1),
        topK: z.number().int().positive().optional(),
    },
}, async ({ collection, question, topK = SEARCH_TOP_K }) => {
    try {
        const vector = await embed(question);
        const results = await qdrant.search(collection, {
            vector,
            limit: topK,
            with_payload: true,
        });
        const context = results
            .map((r, i) => `[${i + 1}] ${r.payload?.["text"] ?? ""}`)
            .join("\n\n");
        if (!context) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No relevant context found in the collection.",
                    },
                ],
            };
        }
        const answer = await generate(context, question);
        return {
            content: [{ type: "text", text: answer }],
            structuredContent: { answer, sources: results },
        };
    }
    catch (err) {
        return toolError(err);
    }
});
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
