# qdrant-mcp

A local RAG (Retrieval-Augmented Generation) stack that exposes Qdrant vector search and Ollama LLM tools directly to **GitHub Copilot Chat** in VS Code via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

---

## User Stories & Acceptance Criteria

### US-1 — Local infrastructure runs reliably
**As a** developer,  
**I want** Qdrant and Ollama to start automatically with Docker Compose,  
**so that** I don't have to manage them manually.

**Acceptance Criteria:**
- [ ] `docker compose up -d` starts both `qdrant` (v1.17.0) and `ollama` containers
- [ ] Qdrant is reachable at `http://localhost:6333`
- [ ] Ollama is reachable at `http://localhost:11434`
- [ ] Qdrant data persists in `qdrant_storage/` across container restarts
- [ ] Ollama models persist in the `ollama_data` named volume across restarts
- [ ] Both containers restart automatically unless explicitly stopped

### US-2 — VS Code Copilot can interact with Qdrant
**As a** developer,  
**I want** Copilot Chat to manage Qdrant collections via MCP tools,  
**so that** I can control the vector DB from chat without leaving VS Code.

**Acceptance Criteria:**
- [ ] `qdrant_health` returns Qdrant server version and status
- [ ] `qdrant_list_collections` returns the list of existing collections
- [ ] `qdrant_create_collection` creates a named collection with configurable vector size and distance metric
- [ ] `qdrant_delete_collection` permanently removes a collection
- [ ] All tools return a structured error message (not a crash) when Qdrant is unreachable

### US-3 — VS Code Copilot can check Ollama health
**As a** developer,  
**I want** to verify that the Ollama runtime is healthy from chat,  
**so that** I can diagnose issues before running RAG queries.

**Acceptance Criteria:**
- [ ] `ollama_health` returns a successful response when Ollama is running
- [ ] `ollama_health` returns an error message (not a crash) when Ollama is unreachable

### US-4 — Documents can be ingested into the vector DB
**As a** developer,  
**I want** to ingest text documents into Qdrant via Copilot Chat,  
**so that** I can build a searchable knowledge base from my project docs.

**Acceptance Criteria:**
- [ ] `rag_ingest` accepts `collection`, `text`, optional `chunkSize`, and optional `metadata`
- [ ] Text is split into overlapping chunks (10% overlap) of the specified `chunkSize` (default 500 chars)
- [ ] Each chunk is embedded using the configured Ollama embedding model (`nomic-embed-text` by default)
- [ ] Chunks are upserted into the specified Qdrant collection with `wait: true`
- [ ] The tool reports how many chunks were ingested
- [ ] Returns a structured error if Ollama or Qdrant is unreachable

### US-5 — Semantic search works from Copilot Chat
**As a** developer,  
**I want** to search the knowledge base by natural language query,  
**so that** I can quickly find relevant context without exact keyword matching.

**Acceptance Criteria:**
- [ ] `rag_search` accepts `collection`, `query`, and optional `topK` (default from env `SEARCH_TOP_K`)
- [ ] The query is embedded with the same Ollama embedding model used at ingest time
- [ ] Results are returned as ranked chunks with similarity scores
- [ ] Returns "No results found." if the collection is empty
- [ ] Returns a structured error if Ollama or Qdrant is unreachable

### US-6 — Copilot can answer questions using local Llama
**As a** developer,  
**I want** Copilot to answer questions grounded in my own documents,  
**so that** I get answers based on my codebase/docs rather than generic knowledge.

**Acceptance Criteria:**
- [ ] `rag_ask` accepts `collection`, `question`, and optional `topK`
- [ ] Retrieves top-K relevant chunks from Qdrant
- [ ] Passes retrieved context + question to the configured Ollama chat model (`llama3.2` by default)
- [ ] Returns the generated answer plus source chunks as structured content
- [ ] Returns "No relevant context found" when the collection is empty
- [ ] Returns a structured error if Ollama or Qdrant is unreachable

---

## Prerequisites

- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) with WSL 2 backend
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (for RTX GPU passthrough to Ollama)
- [Node.js](https://nodejs.org/) v22+
- VS Code with [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension

---

## Setup

### 1. Clone and configure

```powershell
git clone https://github.com/Polskipepek/qdrant-mcp.git
cd qdrant-mcp
copy .env.example .env
```

Edit `.env` if you want to change models or ports.

### 2. Start infrastructure

```powershell
docker compose up -d
```

Verify both services:

```powershell
Invoke-RestMethod http://localhost:6333   # Qdrant
Invoke-RestMethod http://localhost:11434  # Ollama
```

### 3. Pull Ollama models

```powershell
docker exec -it ollama ollama pull nomic-embed-text
docker exec -it ollama ollama pull llama3.2
```

`nomic-embed-text` is the embedding model (768-dim). `llama3.2` is the smallest Llama 3 chat model and runs well on a consumer RTX GPU.

### 4. Build the MCP server

```powershell
cd mcp-server
npm install
npm run build
```

### 5. Configure VS Code

Press `Ctrl+Shift+P` → **MCP: Open User Configuration** and add:

```json
{
  "servers": {
    "qdrantGlobal": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\qdrant-mcp\\mcp-server\\dist\\server.js"
      ],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBEDDING_MODEL": "nomic-embed-text",
        "CHAT_MODEL": "llama3.2",
        "SEARCH_TOP_K": "5"
      }
    }
  }
}
```

Then press `Ctrl+Shift+P` → **MCP: List Servers** → Start `qdrantGlobal`.

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `qdrant_health` | Check Qdrant is reachable |
| `ollama_health` | Check Ollama is reachable |
| `qdrant_list_collections` | List all collections |
| `qdrant_create_collection` | Create a collection with vector size + distance metric |
| `qdrant_delete_collection` | Delete a collection permanently |
| `rag_ingest` | Chunk + embed + upsert text into Qdrant |
| `rag_search` | Semantic search returning ranked chunks |
| `rag_ask` | Full RAG: retrieve context → generate answer with Llama |

---

## Development

For hot-reload during development:

```powershell
cd mcp-server
npm run dev
```

---

## Architecture

```
VS Code Copilot Chat
        │  MCP (stdio)
        ▼
   MCP Server (Node.js / TypeScript)
    ├── embed(text)  ──►  Ollama :11434  (nomic-embed-text)
    ├── generate()   ──►  Ollama :11434  (llama3.2)
    └── qdrant.*     ──►  Qdrant :6333
                               │
                         qdrant_storage/
```
