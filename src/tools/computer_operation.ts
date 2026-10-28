import axios from "axios";
import { ToolDefinition, formatToolResult } from "../types.js";

/**
 * Dual Target IP Routing Configuration for Remote Windows PC Agents
 * - Office PC : http://192.168.0.91:8181 (overridable via COMPUTER_OFFICE_URL / PC_OFFICE_URL)
 * - Home PC   : http://100.107.229.43:8181 (overridable via COMPUTER_HOME_URL / PC_HOME_URL)
 */
const DEFAULT_OFFICE_URL = "http://192.168.0.91:8181";
const DEFAULT_HOME_URL = "http://100.107.229.43:8181";

export type TargetLocation = "office" | "home";

export function resolveTargetBaseUrl(targetInput?: unknown): {
  target: string;
  baseUrl: string;
} {
  const officeUrl = (
    process.env.COMPUTER_OFFICE_URL ||
    process.env.PC_OFFICE_URL ||
    DEFAULT_OFFICE_URL
  ).replace(/\/+$/, "");

  const homeUrl = (
    process.env.COMPUTER_HOME_URL ||
    process.env.PC_HOME_URL ||
    DEFAULT_HOME_URL
  ).replace(/\/+$/, "");

  const defaultTarget = (
    process.env.COMPUTER_DEFAULT_TARGET ||
    process.env.PC_DEFAULT_TARGET ||
    "office"
  )
    .trim()
    .toLowerCase();

  const raw = String(targetInput || defaultTarget || "office")
    .trim()
    .toLowerCase();

  if (raw === "office" || raw === "kantor" || raw === "work") {
    return { target: "office", baseUrl: officeUrl };
  }
  if (raw === "home" || raw === "rumah") {
    return { target: "home", baseUrl: homeUrl };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { target: "custom", baseUrl: raw.replace(/\/+$/, "") };
  }

  throw new Error(
    `Invalid target '${raw}'. Supported values: 'office' (${officeUrl}), 'home' (${homeUrl}), or a full http(s)://IP:PORT URL.`
  );
}

function getWorkerHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.COMPUTER_API_KEY || process.env.PC_API_KEY;
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

async function callWorkerEndpoint(
  targetInput: unknown,
  endpoint: string,
  method: "GET" | "POST" = "POST",
  payload?: Record<string, any>,
  timeoutMs = 30000
): Promise<any> {
  const { target, baseUrl } = resolveTargetBaseUrl(targetInput);
  const url = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const response = await axios.request({
    url,
    method,
    headers: getWorkerHeaders(),
    data: method === "POST" ? payload || {} : undefined,
    params: method === "GET" ? payload : undefined,
    timeout: timeoutMs,
  });

  return {
    target,
    worker_url: baseUrl,
    endpoint,
    ...(typeof response.data === "object" && response.data !== null
      ? response.data
      : { result: response.data }),
  };
}

const targetPropertySchema = {
  type: "string",
  enum: ["office", "home"],
  description:
    "Target Windows PC location to route the command to: 'office' (http://192.168.0.91:8181) or 'home' (http://100.107.229.43:8181). Defaults to 'office'.",
  default: "office",
};

/**
 * 1. Check Worker Status & Screen Info
 */
export const computerStatusTool: ToolDefinition = {
  name: "computer_status",
  description:
    "Check connectivity, health, screen resolution, and current mouse cursor position on the target Windows PC ('office' at 192.168.0.91:8181 or 'home' at 100.107.229.43:8181).",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
    },
    required: [],
  },
  handler: async (args) => {
    const data = await callWorkerEndpoint(args.target, "/status", "GET", undefined, 10000);
    return formatToolResult(data);
  },
};

/**
 * 2. Mouse Click (Left, Right, Middle, Double Click)
 */
export const computerMouseClickTool: ToolDefinition = {
  name: "computer_mouse_click",
  description:
    "Perform mouse click operations on the target Windows PC: left click, right click, middle click, or double click at optional (x, y) screen coordinates.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      x: {
        type: "number",
        description:
          "Optional X coordinate on screen. If omitted, clicks at the current cursor position.",
      },
      y: {
        type: "number",
        description:
          "Optional Y coordinate on screen. If omitted, clicks at the current cursor position.",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button to click ('left', 'right', 'middle'). Default: 'left'.",
        default: "left",
      },
      click_type: {
        type: "string",
        enum: ["single", "double", "triple"],
        description:
          "Click type: 'single' (1 click), 'double' (double click), or 'triple'. Default: 'single'.",
        default: "single",
      },
      clicks: {
        type: "number",
        description:
          "Optional explicit number of clicks (overrides click_type if specified, e.g. 2 for double click).",
      },
      interval: {
        type: "number",
        description: "Interval in seconds between clicks. Default: 0.1.",
        default: 0.1,
      },
      duration: {
        type: "number",
        description: "Duration in seconds to move cursor to (x, y) before clicking. Default: 0.1.",
        default: 0.1,
      },
    },
    required: [],
  },
  handler: async (args) => {
    const clickType = String(args.click_type || "single").toLowerCase();
    let clicks = args.clicks !== undefined ? Number(args.clicks) : 1;
    if (args.clicks === undefined) {
      if (clickType === "double") clicks = 2;
      else if (clickType === "triple") clicks = 3;
    }

    const payload: Record<string, any> = {
      x: args.x !== undefined ? Number(args.x) : null,
      y: args.y !== undefined ? Number(args.y) : null,
      button: args.button ? String(args.button).toLowerCase() : "left",
      clicks,
      interval: args.interval !== undefined ? Number(args.interval) : 0.1,
      duration: args.duration !== undefined ? Number(args.duration) : 0.1,
    };

    const data = await callWorkerEndpoint(args.target, "/mouse/click", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 3. Mouse Move
 */
export const computerMouseMoveTool: ToolDefinition = {
  name: "computer_mouse_move",
  description:
    "Move the mouse cursor on the target Windows PC to absolute (x, y) coordinates or by a relative offset.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      x: {
        type: "number",
        description: "Target X coordinate (or horizontal offset if relative=true).",
      },
      y: {
        type: "number",
        description: "Target Y coordinate (or vertical offset if relative=true).",
      },
      duration: {
        type: "number",
        description: "Duration of mouse movement in seconds. Default: 0.2.",
        default: 0.2,
      },
      relative: {
        type: "boolean",
        description:
          "If true, moves cursor relative to its current position instead of absolute screen coordinates. Default: false.",
        default: false,
      },
    },
    required: ["x", "y"],
  },
  handler: async (args) => {
    const payload = {
      x: Number(args.x),
      y: Number(args.y),
      duration: args.duration !== undefined ? Number(args.duration) : 0.2,
      relative: Boolean(args.relative),
    };
    const data = await callWorkerEndpoint(args.target, "/mouse/move", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 4. Mouse Drag
 */
export const computerMouseDragTool: ToolDefinition = {
  name: "computer_mouse_drag",
  description:
    "Drag the mouse on the target Windows PC from optional start (start_x, start_y) to destination (x, y) while holding down a mouse button.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      x: {
        type: "number",
        description: "Destination X coordinate (or horizontal offset if relative=true).",
      },
      y: {
        type: "number",
        description: "Destination Y coordinate (or vertical offset if relative=true).",
      },
      start_x: {
        type: "number",
        description: "Optional starting X coordinate before dragging.",
      },
      start_y: {
        type: "number",
        description: "Optional starting Y coordinate before dragging.",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button to hold during drag. Default: 'left'.",
        default: "left",
      },
      duration: {
        type: "number",
        description: "Time in seconds the drag movement should take. Default: 0.5.",
        default: 0.5,
      },
      relative: {
        type: "boolean",
        description:
          "If true, drags relative to current/start cursor position. Default: false.",
        default: false,
      },
    },
    required: ["x", "y"],
  },
  handler: async (args) => {
    const payload = {
      x: Number(args.x),
      y: Number(args.y),
      start_x: args.start_x !== undefined ? Number(args.start_x) : null,
      start_y: args.start_y !== undefined ? Number(args.start_y) : null,
      button: args.button ? String(args.button).toLowerCase() : "left",
      duration: args.duration !== undefined ? Number(args.duration) : 0.5,
      relative: Boolean(args.relative),
    };
    const data = await callWorkerEndpoint(args.target, "/mouse/drag", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 5. Mouse Scroll
 */
export const computerMouseScrollTool: ToolDefinition = {
  name: "computer_mouse_scroll",
  description:
    "Scroll the mouse wheel vertically or horizontally on the target Windows PC.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      clicks: {
        type: "number",
        description:
          "Scroll amount/clicks. Positive values scroll UP (or RIGHT), negative values scroll DOWN (or LEFT). E.g., -500 to scroll down, 500 to scroll up.",
      },
      direction: {
        type: "string",
        enum: ["vertical", "horizontal"],
        description: "Scroll axis: 'vertical' or 'horizontal'. Default: 'vertical'.",
        default: "vertical",
      },
      x: {
        type: "number",
        description: "Optional X coordinate to place cursor before scrolling.",
      },
      y: {
        type: "number",
        description: "Optional Y coordinate to place cursor before scrolling.",
      },
    },
    required: ["clicks"],
  },
  handler: async (args) => {
    const payload = {
      clicks: Number(args.clicks),
      direction: args.direction ? String(args.direction).toLowerCase() : "vertical",
      x: args.x !== undefined ? Number(args.x) : null,
      y: args.y !== undefined ? Number(args.y) : null,
    };
    const data = await callWorkerEndpoint(args.target, "/mouse/scroll", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 6. Screen Capture / Screenshot
 */
export const computerScreenshotTool: ToolDefinition = {
  name: "computer_screenshot",
  description:
    "Take a live screenshot of the target Windows PC screen using MSS. Returns image metadata, saved file path on the PC, and base64 image content.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      monitor: {
        type: "number",
        description:
          "Monitor index (1 for primary monitor, 0 for all monitors combined). Default: 1.",
        default: 1,
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Image output format ('png' or 'jpeg'). Default: 'png'.",
        default: "png",
      },
      quality: {
        type: "number",
        description: "JPEG quality (1-100) when format is 'jpeg'. Default: 85.",
        default: 85,
      },
      return_image_content: {
        type: "boolean",
        description:
          "If true, attaches native MCP ImageContent (base64) alongside JSON metadata. Default: true.",
        default: true,
      },
    },
    required: [],
  },
  handler: async (args) => {
    const payload = {
      monitor: args.monitor !== undefined ? Number(args.monitor) : 1,
      format: args.format ? String(args.format).toLowerCase() : "png",
      quality: args.quality !== undefined ? Number(args.quality) : 85,
    };

    const data = await callWorkerEndpoint(
      args.target,
      "/screen/screenshot",
      "POST",
      payload,
      30000
    );

    const includeImageContent =
      args.return_image_content !== undefined ? Boolean(args.return_image_content) : true;

    if (includeImageContent && data?.base64_image) {
      const mimeType =
        data.mime_type || (payload.format === "jpeg" ? "image/jpeg" : "image/png");
      const { base64_image, ...metadata } = data;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
          {
            type: "image",
            data: base64_image,
            mimeType,
          },
        ],
      };
    }

    return formatToolResult(data);
  },
};

/**
 * 7. Screen Record
 */
export const computerScreenRecordTool: ToolDefinition = {
  name: "computer_screen_record",
  description:
    "Record the screen of the target Windows PC for a specified duration (in seconds) and save as MP4/AVI video (optionally returning base64 video data).",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      duration: {
        type: "number",
        description: "Recording duration in seconds (1 to 60). Default: 5.",
        default: 5,
      },
      fps: {
        type: "number",
        description: "Frames per second (1 to 30). Default: 10.",
        default: 10,
      },
      monitor: {
        type: "number",
        description: "Monitor index to record (default: 1).",
        default: 1,
      },
      return_base64: {
        type: "boolean",
        description:
          "If true, includes the base64-encoded video file in the response. Default: false.",
        default: false,
      },
    },
    required: [],
  },
  handler: async (args) => {
    const duration = args.duration !== undefined ? Math.min(Math.max(Number(args.duration), 1), 60) : 5;
    const payload = {
      duration,
      fps: args.fps !== undefined ? Number(args.fps) : 10,
      monitor: args.monitor !== undefined ? Number(args.monitor) : 1,
      return_base64: Boolean(args.return_base64),
    };

    const timeoutMs = (duration + 25) * 1000;
    const data = await callWorkerEndpoint(
      args.target,
      "/screen/record",
      "POST",
      payload,
      timeoutMs
    );
    return formatToolResult(data);
  },
};

/**
 * 8. Launch Application
 */
export const computerAppLaunchTool: ToolDefinition = {
  name: "computer_app_launch",
  description:
    "Launch/open an application, executable path, document, or URL on the target Windows PC (e.g., 'notepad.exe', 'calc.exe', 'chrome', 'C:\\\\Program Files\\\\...').",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      app: {
        type: "string",
        description:
          "Application name, executable path, command, or URL to launch (e.g., 'notepad', 'calc', 'mspaint', 'chrome https://google.com').",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of command-line arguments to pass to the application.",
      },
      working_dir: {
        type: "string",
        description: "Optional working directory path.",
      },
    },
    required: ["app"],
  },
  handler: async (args) => {
    const app = String(args.app || "").trim();
    if (!app) {
      throw new Error("Parameter 'app' is required.");
    }
    const payload = {
      app,
      args: Array.isArray(args.args) ? args.args.map(String) : [],
      working_dir: args.working_dir ? String(args.working_dir) : null,
    };
    const data = await callWorkerEndpoint(args.target, "/app/launch", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 9. Kill / Close Application
 */
export const computerAppKillTool: ToolDefinition = {
  name: "computer_app_kill",
  description:
    "Close or terminate (kill) a running application on the target Windows PC by process name (e.g., 'notepad.exe', 'chrome.exe') or PID.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      process_name: {
        type: "string",
        description:
          "Process/executable name to close (e.g., 'notepad.exe' or 'chrome'). Required if 'pid' is not provided.",
      },
      pid: {
        type: "number",
        description: "Specific Process ID (PID) to terminate. Required if 'process_name' is not provided.",
      },
      force: {
        type: "boolean",
        description: "If true, forces termination ('taskkill /F'). Default: true.",
        default: true,
      },
    },
    required: [],
  },
  handler: async (args) => {
    if (!args.process_name && args.pid === undefined) {
      throw new Error("Either 'process_name' or 'pid' must be provided.");
    }
    const payload = {
      process_name: args.process_name ? String(args.process_name).trim() : null,
      pid: args.pid !== undefined ? Number(args.pid) : null,
      force: args.force !== undefined ? Boolean(args.force) : true,
    };
    const data = await callWorkerEndpoint(args.target, "/app/kill", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 10. Keyboard Free Text Typing
 */
export const computerKeyboardTypeTool: ToolDefinition = {
  name: "computer_keyboard_type",
  description:
    "Type free-form text on the target Windows PC keyboard using PyAutoGUI, with optional Enter key press at the end.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      text: {
        type: "string",
        description: "The text string to type on the active window.",
      },
      interval: {
        type: "number",
        description: "Delay in seconds between each keystroke. Default: 0.02.",
        default: 0.02,
      },
      press_enter: {
        type: "boolean",
        description: "If true, presses the Enter key after typing the text. Default: false.",
        default: false,
      },
    },
    required: ["text"],
  },
  handler: async (args) => {
    const text = String(args.text ?? "");
    const payload = {
      text,
      interval: args.interval !== undefined ? Number(args.interval) : 0.02,
      press_enter: Boolean(args.press_enter),
    };
    const data = await callWorkerEndpoint(args.target, "/keyboard/type", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 11. Keyboard Shortcut / Hotkey Combination
 */
export const computerKeyboardHotkeyTool: ToolDefinition = {
  name: "computer_keyboard_hotkey",
  description:
    "Press a single key or a keyboard shortcut/hotkey combination on the target Windows PC (e.g., ['ctrl', 'c'], ['alt', 'tab'], ['win', 'r'], ['ctrl', 'shift', 'esc'], or ['enter']).",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      keys: {
        type: "array",
        items: { type: "string" },
        description:
          "Ordered list of keys to press together as a hotkey combination (e.g., ['ctrl', 'v'], ['win', 'd'], ['alt', 'f4']).",
      },
      interval: {
        type: "number",
        description: "Interval in seconds between key presses. Default: 0.05.",
        default: 0.05,
      },
    },
    required: ["keys"],
  },
  handler: async (args) => {
    let keys: string[] = [];
    if (Array.isArray(args.keys)) {
      keys = args.keys.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    } else if (typeof args.keys === "string") {
      keys = args.keys
        .split("+")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
    }

    if (keys.length === 0) {
      throw new Error("Parameter 'keys' must contain at least one key (e.g., ['ctrl', 'c']).");
    }

    const payload = {
      keys,
      interval: args.interval !== undefined ? Number(args.interval) : 0.05,
    };
    const data = await callWorkerEndpoint(args.target, "/keyboard/hotkey", "POST", payload);
    return formatToolResult(data);
  },
};

/**
 * 12. Power Management (Shutdown / Restart / Cancel)
 */
export const computerPowerManagementTool: ToolDefinition = {
  name: "computer_power_management",
  description:
    "Execute power management actions on the target Windows PC: shutdown, restart, or abort a scheduled shutdown/restart.",
  inputSchema: {
    type: "object",
    properties: {
      target: targetPropertySchema,
      action: {
        type: "string",
        enum: ["shutdown", "restart", "cancel"],
        description: "Power action to perform: 'shutdown', 'restart', or 'cancel'.",
      },
      delay_seconds: {
        type: "number",
        description: "Delay in seconds before shutdown/restart is executed. Default: 5.",
        default: 5,
      },
      force: {
        type: "boolean",
        description: "If true, forces running applications to close ('/f'). Default: true.",
        default: true,
      },
    },
    required: ["action"],
  },
  handler: async (args) => {
    const action = String(args.action || "")
      .trim()
      .toLowerCase();
    if (!["shutdown", "restart", "cancel"].includes(action)) {
      throw new Error("Parameter 'action' must be one of: 'shutdown', 'restart', 'cancel'.");
    }

    const payload = {
      action,
      delay_seconds: args.delay_seconds !== undefined ? Number(args.delay_seconds) : 5,
      force: args.force !== undefined ? Boolean(args.force) : true,
    };
    const data = await callWorkerEndpoint(args.target, "/power", "POST", payload);
    return formatToolResult(data);
  },
};

export default [
  computerStatusTool,
  computerMouseClickTool,
  computerMouseMoveTool,
  computerMouseDragTool,
  computerMouseScrollTool,
  computerScreenshotTool,
  computerScreenRecordTool,
  computerAppLaunchTool,
  computerAppKillTool,
  computerKeyboardTypeTool,
  computerKeyboardHotkeyTool,
  computerPowerManagementTool,
];
