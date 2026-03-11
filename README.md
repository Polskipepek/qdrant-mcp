# qdrant-mcp

A local RAG (Retrieval-Augmented Generation) stack that exposes Qdrant vector search and Ollama LLM tools directly to **GitHub Copilot Chat** in VS Code via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

All repositories share **one Qdrant collection** (`codebase` by default). Each chunk carries `repo`, `source`, `language`, and `branch` payload fields. Every search and answer tool can be scoped to a single repo or run across all repos at once.

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
                    shared collection 'codebase'
                    payload fields: repo, source, language, branch
                    payload indexes: repo ✓  source ✓  language ✓

Auto-ingest paths:
  git post-commit hook  ──►  scripts/ingest.ts  (per changed file)
  scripts/watcher.ts   ──►  chokidar multi-dir watcher (on save)
```

---

## User Stories & Acceptance Criteria

### US-1 — Local infrastructure runs reliably
**As a** developer, **I want** Qdrant and Ollama to start automatically with Docker Compose, **so that** I don't have to manage them manually.

- [x] `docker compose up -d` starts `qdrant` (v1.17.0) and `ollama` containers
- [x] Qdrant reachable at `http://localhost:6333`
- [x] Ollama reachable at `http://localhost:11434`
- [x] Data persists across container restarts
- [x] Both containers restart unless explicitly stopped
- [x] GPU passthrough for RTX cards via NVIDIA Container Toolkit

### US-2 — VS Code Copilot can manage Qdrant
- [x] `qdrant_health` returns version and status
- [x] `ollama_health` returns Ollama status
- [x] `qdrant_list_collections` lists collections
- [x] `qdrant_create_collection` / `qdrant_delete_collection` manage collections
- [x] All tools return structured errors on failure

### US-3 — Shared collection with per-repo filtering
**As a** developer working on multiple repos, **I want** all repos to share one Qdrant collection but be able to scope searches to a single repo, **so that** I have one DB to maintain but focused answers when needed.

- [x] Single collection (`codebase`) stores chunks from all repos
- [x] Each chunk has `repo`, `source`, `language`, `branch` payload fields
- [x] Payload indexes on `repo`, `source`, `language` for fast filtered search
- [x] `rag_search` and `rag_ask` accept optional `repo` parameter
- [x] When `repo` is omitted, search spans all repos
- [x] `rag_list_repos` returns distinct repo names in the collection
- [x] `rag_delete_repo` removes all vectors for a given repo

### US-4 — Documents ingested from Copilot Chat
- [x] `rag_ingest` accepts `text`, `repo`, `source`, optional `language`, `branch`, `chunkSize`
- [x] Text split into overlapping 500-char chunks (10% overlap)
- [x] Each chunk embedded with `nomic-embed-text`
- [x] Chunks upserted with `wait: true`
- [x] Reports chunk count on completion

### US-5 — Semantic search from Copilot Chat
- [x] `rag_search` accepts `query`, optional `repo`, optional `topK`
- [x] Results show score, repo name, and source file path
- [x] Returns "No results found" on empty collection

### US-6 — Copilot answers questions using local Llama
- [x] `rag_ask` accepts `question`, optional `repo`, optional `topK`
- [x] Retrieves top-K chunks, passes to `llama3.2` for generation
- [x] Returns answer + sources as structured content

### US-7 — Automatic ingestion on git commit (all repos)
**As a** developer, **I want** changed files to be ingested automatically on every commit, **so that** the RAG DB always reflects my latest code without manual steps.

- [x] `scripts/install-hooks.ps1` installs a global git `post-commit` hook on Windows
- [x] `scripts/install-hooks.sh` installs the hook on Linux/macOS/WSL
- [x] Hook reads changed files from `git diff-tree`, filters by extension, calls `scripts/ingest.ts --file`
- [x] Ingestion runs in background (`&`) so commit is not blocked
- [x] Works for every repo on the machine after `git init` is re-run

### US-8 — Live file-save ingestion via watcher (multi-repo)
**As a** developer, **I want** the RAG DB to update as I save files, **so that** Copilot always has the latest context even before I commit.

- [x] `scripts/watcher.ts` watches multiple directories defined in `watcher-config.json`
- [x] Debounces rapid saves (default 1500ms)
- [x] Deletes stale vectors for a file before re-ingesting on change
- [x] Removes vectors when a file is deleted
- [x] Reads current git branch for each changed file
- [x] `npm run watch` starts the daemon from `mcp-server/`

---

## Prerequisites

- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) with WSL 2 backend
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (RTX GPU passthrough)
- [Node.js](https://nodejs.org/) v22+
- VS Code with [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension

---

## Setup

### 1. Clone and configure

```powershell
git clone https://github.com/Polskipepek/qdrant-mcp.git
cd qdrant-mcp
copy .env.example .env
# Edit .env if needed
```

### 2. Start infrastructure

```powershell
docker compose up -d
docker exec -it ollama ollama pull nomic-embed-text
docker exec -it ollama ollama pull llama3.2
```

### 3. Build MCP server

```powershell
cd mcp-server
npm install
npm run build
```

### 4. Configure VS Code

`Ctrl+Shift+P` → **MCP: Open User Configuration**:

```json
{
  "servers": {
    "qdrantGlobal": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Dev\\VS\\qdrant-mcp\\mcp-server\\dist\\server.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBEDDING_MODEL": "nomic-embed-text",
        "CHAT_MODEL": "llama3.2",
        "COLLECTION_NAME": "codebase",
        "VECTOR_SIZE": "768",
        "SEARCH_TOP_K": "5"
      }
    }
  }
}
```

---

## Auto-ingest setup

### Option A — Git hook (ingest on commit)

```powershell
# Run once from qdrant-mcp root
.\scripts\install-hooks.ps1

# Then in each existing repo:
cd C:\Dev\VS\BB.Pay
git init   # copies hook from template
```

From now on, every `git commit` in any repo will automatically ingest changed files in the background.

### Option B — File watcher (ingest on save)

```powershell
# 1. Copy and edit the config
copy watcher-config.example.json watcher-config.json
# Edit watcher-config.json with your repo paths

# 2. Start the watcher
cd mcp-server
npm run watch
```

Run the watcher as a background process or Windows Service for always-on ingestion.

### First-time bulk ingest

```powershell
cd mcp-server
npm run ingest -- --dir C:\Dev\VS\BB.Pay --repo bb-pay
npm run ingest -- --dir C:\Dev\VS\qdrant-mcp --repo qdrant-mcp
```

---

## Available MCP Tools

| Tool | Description | Key params |
|---|---|---|
| `qdrant_health` | Check Qdrant | — |
| `ollama_health` | Check Ollama | — |
| `qdrant_list_collections` | List collections | — |
| `qdrant_create_collection` | Create collection | `name`, `size`, `distance` |
| `qdrant_delete_collection` | Delete collection | `name` |
| `rag_list_repos` | List ingested repos | — |
| `rag_ingest` | Ingest text | `text`, `repo`, `source` |
| `rag_delete_repo` | Remove all vectors for a repo | `repo` |
| `rag_search` | Semantic search | `query`, `repo?`, `topK?` |
| `rag_ask` | RAG answer with Llama | `question`, `repo?`, `topK?` |

---

## Development

```powershell
cd mcp-server
npm run dev   # hot-reload MCP server via tsx
npm run watch # start file watcher daemon
```
