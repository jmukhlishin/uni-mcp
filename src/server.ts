#!/usr/bin/env node

import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadToolsRegistry } from "./tools/index.js";
import { ToolDefinition, formatToolResult } from "./types.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 3301;
const HOST = process.env.HOST || "0.0.0.0";

/**
 * Creates a lightweight MCP Server instance wired to the dynamically loaded tool registry.
 * Called per stateless Streamable HTTP request so concurrent requests are completely isolated.
 */
function createMcpServerInstance(registry: Map<string, ToolDefinition>): Server {
  const server = new Server(
    {
      name: "uni-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(registry.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = registry.get(name);

    if (!tool) {
      return formatToolResult(
        { error: `Unknown tool '${name}'. Available tools: ${Array.from(registry.keys()).join(", ")}` },
        true
      );
    }

    try {
      const result = await tool.handler((args as Record<string, any>) || {});
      if (result && typeof result === "object" && Array.isArray(result.content)) {
        return result;
      }
      return formatToolResult(result);
    } catch (error: any) {
      const apiError =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        (error?.response?.data ? JSON.stringify(error.response.data) : null) ||
        error?.message ||
        String(error);

      return formatToolResult({ error: apiError }, true);
    }
  });

  return server;
}

async function bootstrap() {
  console.log("Initializing Universal MCP Hub (uni-mcp)...");
  const toolRegistry = await loadToolsRegistry();
  console.log(
    `Loaded ${toolRegistry.size} tool(s): [${Array.from(toolRegistry.keys()).join(", ")}]`
  );

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "4mb" }));

  /**
   * Stateless Streamable HTTP handler for MCP JSON-RPC requests.
   * Supports both POST /mcp and POST /
   */
  const handleStreamableMcpPost = async (req: Request, res: Response) => {
    const server = createMcpServerInstance(toolRegistry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode (no persistent session state required)
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      console.error("[MCP StreamableHTTP Error]:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  // Primary Streamable HTTP endpoints (POST /mcp and POST /)
  app.post("/mcp", handleStreamableMcpPost);
  app.post("/", handleStreamableMcpPost);

  // Per MCP Stateless Streamable HTTP specification, GET and DELETE on /mcp return 405
  const handleMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST /mcp for Stateless Streamable HTTP transport.",
      },
      id: null,
    });
  };

  app.get("/mcp", handleMethodNotAllowed);
  app.delete("/mcp", handleMethodNotAllowed);

  // Health & discovery endpoints
  const handleHealth = (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      service: "uni-mcp",
      version: "1.0.0",
      transport: "streamable-http",
      endpoints: {
        mcp: "/mcp",
        root: "/",
        health: "/health",
      },
      loadedTools: Array.from(toolRegistry.keys()),
    });
  };

  app.get("/health", handleHealth);
  app.get("/", handleHealth);

  app.listen(PORT, HOST, () => {
    console.log(`=========================================================`);
    console.log(`Universal MCP Hub (uni-mcp) running on http://${HOST}:${PORT}`);
    console.log(`- Transport     : Stateless Streamable HTTP (POST)`);
    console.log(`- MCP Endpoint  : http://${HOST}:${PORT}/mcp`);
    console.log(`- Root Endpoint : http://${HOST}:${PORT}/`);
    console.log(`- Health Check  : http://${HOST}:${PORT}/health`);
    console.log(`=========================================================`);
  });
}

bootstrap().catch((err) => {
  console.error("Fatal error starting uni-mcp server:", err);
  process.exit(1);
});
