import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";

const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6333";
const client = new QdrantClient({ url: qdrantUrl });

const server = new McpServer({
  name: "qdrant-mcp",
  version: "1.0.0",
});

server.registerTool(
  "qdrant_health",
  {
    title: "Qdrant health",
    description: "Check whether Qdrant is reachable",
    inputSchema: {},
  },
  async () => {
    const response = await fetch(qdrantUrl);
    const json = await response.json();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(json, null, 2),
        },
      ],
      structuredContent: json,
    };
  },
);

server.registerTool(
  "qdrant_list_collections",
  {
    title: "List Qdrant collections",
    description: "Return all collections from Qdrant",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.getCollections();
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "qdrant_create_collection",
  {
    title: "Create Qdrant collection",
    description: "Create a vector collection in Qdrant",
    inputSchema: {
      name: z.string(),
      size: z.number().int().positive(),
      distance: z.enum(["Cosine", "Euclid", "Dot"]).optional(),
    },
  },
  async ({ name, size, distance }) => {
    const result = await client.createCollection(name, {
      vectors: {
        size,
        distance: distance ?? "Cosine",
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: {
        ok: true,
        name,
        size,
        distance: distance ?? "Cosine",
      },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
