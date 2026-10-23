import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Standard interface for defining a modular MCP tool plugin.
 * Each file in `src/tools/` can export either a single `ToolDefinition`
 * or an array `ToolDefinition[]` (via `default` export or named `tools` export).
 */
export interface ToolDefinition {
  /** Unique tool name (e.g., "serper_google_search") */
  name: string;
  /** Clear description of what the tool does and when the AI agent should use it */
  description: string;
  /** JSON Schema defining the tool's input arguments */
  inputSchema: Tool["inputSchema"];
  /** Async execution handler receiving parsed arguments */
  handler: (args: Record<string, any>) => Promise<CallToolResult | any>;
}

/**
 * Helper to format any JSON-serializable data into a standard MCP CallToolResult.
 */
export function formatToolResult(data: unknown, isError = false): CallToolResult {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
