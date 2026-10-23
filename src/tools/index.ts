import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ToolDefinition } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Type guard to check if an object conforms to ToolDefinition.
 */
function isToolDefinition(obj: any): obj is ToolDefinition {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.name === "string" &&
    typeof obj.description === "string" &&
    obj.inputSchema &&
    typeof obj.inputSchema === "object" &&
    typeof obj.handler === "function"
  );
}

/**
 * Extract all ToolDefinition objects from an imported ES module.
 * Supports:
 * - `export default toolDefinition`
 * - `export default [tool1, tool2]`
 * - `export const tools = [tool1, tool2]`
 * - `export const myTool = toolDefinition`
 */
function extractToolsFromModule(mod: Record<string, any>): ToolDefinition[] {
  const discovered: ToolDefinition[] = [];
  const seenNames = new Set<string>();

  const addIfValid = (candidate: any) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        addIfValid(item);
      }
    } else if (isToolDefinition(candidate) && !seenNames.has(candidate.name)) {
      seenNames.add(candidate.name);
      discovered.push(candidate);
    }
  };

  if (mod.default) {
    addIfValid(mod.default);
  }
  if (mod.tools) {
    addIfValid(mod.tools);
  }
  if (mod.tool) {
    addIfValid(mod.tool);
  }

  for (const key of Object.keys(mod)) {
    if (key !== "default" && key !== "tools" && key !== "tool") {
      addIfValid(mod[key]);
    }
  }

  return discovered;
}

/**
 * Dynamically loads all tool plugin files inside `src/tools/` (or `dist/tools/`).
 * To add a new tool, simply create a new `.ts` file in `src/tools/` exporting
 * a `ToolDefinition` or `ToolDefinition[]`. No changes to `server.ts` needed!
 */
export async function loadToolsRegistry(): Promise<Map<string, ToolDefinition>> {
  const registry = new Map<string, ToolDefinition>();
  const entries = fs.readdirSync(__dirname, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fileName = entry.name;
    // Skip index files, declaration files, source maps, and hidden files
    if (
      fileName.startsWith(".") ||
      fileName.startsWith("index.") ||
      fileName.endsWith(".d.ts") ||
      fileName.endsWith(".map") ||
      (!fileName.endsWith(".ts") && !fileName.endsWith(".js"))
    ) {
      continue;
    }

    const fullPath = path.join(__dirname, fileName);
    try {
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl);
      const tools = extractToolsFromModule(mod);

      for (const tool of tools) {
        if (registry.has(tool.name)) {
          console.warn(
            `[ToolRegistry] Warning: Duplicate tool name '${tool.name}' in ${fileName} overwrote previous definition.`
          );
        }
        registry.set(tool.name, tool);
        console.log(`[ToolRegistry] Loaded tool: ${tool.name} (from ${fileName})`);
      }
    } catch (err: any) {
      console.error(
        `[ToolRegistry] Failed to load tool module '${fileName}':`,
        err?.message || err
      );
    }
  }

  return registry;
}
