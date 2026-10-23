import axios from "axios";
import { ToolDefinition, formatToolResult } from "../types.js";

const SERPER_BASE_URL = "https://google.serper.dev";

function getSerperApiKey(): string {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SERPER_API_KEY environment variable is not configured. Please set SERPER_API_KEY in your .env file."
    );
  }
  return apiKey;
}

export const serperGoogleSearchTool: ToolDefinition = {
  name: "serper_google_search",
  description:
    "Perform a Google Web Search via Serper API (https://google.serper.dev/search). Returns organic search results, knowledge graph, answer box, and related questions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string (e.g., 'cuaca Jakarta hari ini').",
      },
      gl: {
        type: "string",
        description:
          "Country code for Google search results (2-letter ISO code, e.g., 'id' for Indonesia, 'us' for United States). Default: 'id'.",
        default: "id",
      },
      hl: {
        type: "string",
        description:
          "Language code for Google search interface/results (e.g., 'id' for Indonesian, 'en' for English). Default: 'id'.",
        default: "id",
      },
      num: {
        type: "number",
        description: "Number of results to return (1 to 100). Default: 10.",
        default: 10,
      },
      location: {
        type: "string",
        description:
          "Optional specific location for localized search (e.g., 'Jakarta, Indonesia').",
      },
      tbs: {
        type: "string",
        description:
          "Optional time filter: 'qdr:h' (past hour), 'qdr:d' (past 24 hours), 'qdr:w' (past week), 'qdr:m' (past month), 'qdr:y' (past year).",
      },
      autocorrect: {
        type: "boolean",
        description: "Whether to enable spelling autocorrect. Default: true.",
        default: true,
      },
      page: {
        type: "number",
        description: "Result page number. Default: 1.",
        default: 1,
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const apiKey = getSerperApiKey();
    const q = String(args.query || args.q || "").trim();
    if (!q) {
      throw new Error("Parameter 'query' is required.");
    }

    const payload: Record<string, any> = {
      q,
      gl: args.gl ? String(args.gl) : "id",
      hl: args.hl ? String(args.hl) : "id",
      num: args.num ? Number(args.num) : 10,
      autocorrect: args.autocorrect !== undefined ? Boolean(args.autocorrect) : true,
      page: args.page ? Number(args.page) : 1,
    };

    if (args.location) payload.location = String(args.location);
    if (args.tbs) payload.tbs = String(args.tbs);

    const response = await axios.post(`${SERPER_BASE_URL}/search`, payload, {
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    return formatToolResult(response.data);
  },
};

export const serperNewsSearchTool: ToolDefinition = {
  name: "serper_news_search",
  description:
    "Search latest news articles on Google News via Serper API (https://google.serper.dev/news). Returns news headlines, snippets, sources, publication dates, and links.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The news search query string (e.g., 'berita teknologi AI terbaru').",
      },
      gl: {
        type: "string",
        description:
          "Country code for news results (e.g., 'id' for Indonesia, 'us' for United States). Default: 'id'.",
        default: "id",
      },
      hl: {
        type: "string",
        description:
          "Language code for news results (e.g., 'id' for Indonesian, 'en' for English). Default: 'id'.",
        default: "id",
      },
      num: {
        type: "number",
        description: "Number of news articles to return (1 to 100). Default: 10.",
        default: 10,
      },
      location: {
        type: "string",
        description: "Optional specific location for localized news.",
      },
      tbs: {
        type: "string",
        description:
          "Optional time filter: 'qdr:h' (past hour), 'qdr:d' (past day), 'qdr:w' (past week), 'qdr:m' (past month), 'qdr:y' (past year).",
      },
      autocorrect: {
        type: "boolean",
        description: "Whether to enable spelling autocorrect. Default: true.",
        default: true,
      },
      page: {
        type: "number",
        description: "Result page number. Default: 1.",
        default: 1,
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const apiKey = getSerperApiKey();
    const q = String(args.query || args.q || "").trim();
    if (!q) {
      throw new Error("Parameter 'query' is required.");
    }

    const payload: Record<string, any> = {
      q,
      gl: args.gl ? String(args.gl) : "id",
      hl: args.hl ? String(args.hl) : "id",
      num: args.num ? Number(args.num) : 10,
      autocorrect: args.autocorrect !== undefined ? Boolean(args.autocorrect) : true,
      page: args.page ? Number(args.page) : 1,
    };

    if (args.location) payload.location = String(args.location);
    if (args.tbs) payload.tbs = String(args.tbs);

    const response = await axios.post(`${SERPER_BASE_URL}/news`, payload, {
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    return formatToolResult(response.data);
  },
};

export default [serperGoogleSearchTool, serperNewsSearchTool];
