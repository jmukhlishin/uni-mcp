import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolDefinition, formatToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Safely executes a binary command without spawning a shell to prevent command injection.
 */
async function runCommandSafe(
  command: string,
  args: string[],
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      stdout: typeof err?.stdout === "string" ? err.stdout.trim() : "",
      stderr: typeof err?.stderr === "string" ? err.stderr.trim() : "",
      exitCode: typeof err?.code === "number" ? err.code : 1,
      error: err?.message || String(err),
    };
  }
}

/**
 * Validates a Docker container name or ID to strictly prevent flag/argument injection.
 */
function sanitizeContainerIdentifier(input: unknown): string {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("Parameter 'container' (container name or ID) is required.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(
      `Invalid container identifier '${value}'. Only alphanumeric characters, underscores, dots, and hyphens are allowed.`
    );
  }
  return value;
}

/**
 * Computes instantaneous CPU usage percentage across all cores over a short sample interval.
 */
async function sampleCpuUsagePercent(intervalMs = 250): Promise<number> {
  const takeSnapshot = () => {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    return { idle, total };
  };

  const start = takeSnapshot();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const end = takeSnapshot();

  const idleDiff = end.idle - start.idle;
  const totalDiff = end.total - start.total;
  if (totalDiff <= 0) return 0;

  return Number((((totalDiff - idleDiff) / totalDiff) * 100).toFixed(2));
}

/**
 * Parses `free -m` output into structured memory & swap metrics (in MB).
 */
function parseFreeOutput(raw: string): Record<string, any> | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result: Record<string, any> = {};

  for (const line of lines) {
    if (/^Mem:/i.test(line)) {
      const parts = line.split(/\s+/);
      result.mem = {
        total_mb: Number(parts[1]) || 0,
        used_mb: Number(parts[2]) || 0,
        free_mb: Number(parts[3]) || 0,
        shared_mb: Number(parts[4]) || 0,
        buff_cache_mb: Number(parts[5]) || 0,
        available_mb: Number(parts[6]) || 0,
      };
    } else if (/^Swap:/i.test(line)) {
      const parts = line.split(/\s+/);
      result.swap = {
        total_mb: Number(parts[1]) || 0,
        used_mb: Number(parts[2]) || 0,
        free_mb: Number(parts[3]) || 0,
      };
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parses `df -h` output into an array of mounted filesystem entries.
 */
function parseDfOutput(raw: string): Array<Record<string, string>> {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];

  const entries: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length >= 6) {
      entries.push({
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        use_percent: parts[4],
        mounted_on: parts.slice(5).join(" "),
      });
    }
  }
  return entries;
}

/**
 * Parses newline-delimited JSON output from `docker --format '{{json .}}'`.
 */
function parseDockerJsonLines(raw: string): any[] {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: any[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      items.push({ raw: line });
    }
  }
  return items;
}

/**
 * 1. Host / Server System Metrics Tool (CPU usage/load, RAM `free -m`, Disk `df -h`)
 */
export const monitorSystemMetricsTool: ToolDefinition = {
  name: "monitor_system_metrics",
  description:
    "Monitor Ubuntu host server system metrics including CPU usage percentage, load average (1m, 5m, 15m), RAM & Swap usage ('free -m'), Disk usage ('df -h'), and system uptime.",
  inputSchema: {
    type: "object",
    properties: {
      disk_path: {
        type: "string",
        description:
          "Optional specific filesystem path to check disk usage for (e.g., '/'). If omitted, checks all mounted filesystems via 'df -h'.",
      },
    },
    required: [],
  },
  handler: async (args) => {
    const diskPath = args.disk_path ? String(args.disk_path).trim() : "";
    if (diskPath && !/^[a-zA-Z0-9/_.-]+$/.test(diskPath)) {
      throw new Error("Invalid 'disk_path' format.");
    }

    const dfArgs = diskPath ? ["-h", diskPath] : ["-h"];

    const [cpuUsagePercent, freeCmd, dfCmd, uptimeCmd] = await Promise.all([
      sampleCpuUsagePercent(250),
      runCommandSafe("free", ["-m"]),
      runCommandSafe("df", dfArgs),
      runCommandSafe("uptime", []),
    ]);

    const cpus = os.cpus();
    const [load1m, load5m, load15m] = os.loadavg();
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;

    return formatToolResult({
      timestamp: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime_seconds: Math.floor(os.uptime()),
        uptime_raw: uptimeCmd.stdout || undefined,
      },
      cpu: {
        model: cpus[0]?.model || "unknown",
        cores: cpus.length,
        usage_percent: cpuUsagePercent,
        load_average: {
          "1m": Number(load1m.toFixed(2)),
          "5m": Number(load5m.toFixed(2)),
          "15m": Number(load15m.toFixed(2)),
        },
      },
      memory: {
        os_summary_mb: {
          total_mb: Number((totalMemBytes / (1024 * 1024)).toFixed(2)),
          used_mb: Number((usedMemBytes / (1024 * 1024)).toFixed(2)),
          free_mb: Number((freeMemBytes / (1024 * 1024)).toFixed(2)),
          usage_percent: Number(((usedMemBytes / totalMemBytes) * 100).toFixed(2)),
        },
        free_m_parsed: parseFreeOutput(freeCmd.stdout),
        free_m_raw: freeCmd.stdout || freeCmd.stderr || freeCmd.error,
      },
      disk: {
        df_h_parsed: parseDfOutput(dfCmd.stdout),
        df_h_raw: dfCmd.stdout || dfCmd.stderr || dfCmd.error,
      },
    });
  },
};

/**
 * 2. Docker Containers Status Tool (`docker ps`)
 */
export const monitorDockerContainersTool: ToolDefinition = {
  name: "monitor_docker_containers",
  description:
    "List Docker containers and their status ('docker ps'). Can list only running containers or all containers (including exited/stopped) and optionally filter by container name.",
  inputSchema: {
    type: "object",
    properties: {
      all: {
        type: "boolean",
        description:
          "If true, shows all containers including stopped/exited ones ('docker ps -a'). Default: true.",
        default: true,
      },
      filter_name: {
        type: "string",
        description:
          "Optional substring filter to match container name (e.g., 'n8n' or 'uni-mcp').",
      },
    },
    required: [],
  },
  handler: async (args) => {
    const showAll = args.all !== undefined ? Boolean(args.all) : true;
    const filterName = args.filter_name ? sanitizeContainerIdentifier(args.filter_name) : "";

    const jsonArgs = ["ps"];
    const tableArgs = ["ps"];
    if (showAll) {
      jsonArgs.push("-a");
      tableArgs.push("-a");
    }
    if (filterName) {
      jsonArgs.push("--filter", `name=${filterName}`);
      tableArgs.push("--filter", `name=${filterName}`);
    }
    jsonArgs.push("--format", "{{json .}}");

    const [jsonCmd, tableCmd] = await Promise.all([
      runCommandSafe("docker", jsonArgs),
      runCommandSafe("docker", tableArgs),
    ]);

    if (jsonCmd.exitCode !== 0) {
      return formatToolResult(
        {
          error: "Failed to execute 'docker ps'. Ensure Docker CLI is installed and /var/run/docker.sock is accessible.",
          details: jsonCmd.stderr || jsonCmd.error,
        },
        true
      );
    }

    const containers = parseDockerJsonLines(jsonCmd.stdout);

    return formatToolResult({
      timestamp: new Date().toISOString(),
      command: `docker ${tableArgs.join(" ")}`,
      count: containers.length,
      containers,
      raw_table: tableCmd.stdout,
    });
  },
};

/**
 * 3. Docker Container Resource Usage Tool (`docker stats --no-stream`)
 */
export const monitorDockerStatsTool: ToolDefinition = {
  name: "monitor_docker_stats",
  description:
    "Get real-time resource usage snapshot (CPU %, Memory usage/limit, Memory %, Network I/O, Block I/O, PIDs) for Docker containers using 'docker stats --no-stream'.",
  inputSchema: {
    type: "object",
    properties: {
      container: {
        type: "string",
        description:
          "Optional specific container name or ID to inspect. If omitted, returns resource stats for all running containers.",
      },
      all: {
        type: "boolean",
        description:
          "If true, includes stopped containers as well ('docker stats --no-stream -a'). Default: false.",
        default: false,
      },
    },
    required: [],
  },
  handler: async (args) => {
    const includeAll = Boolean(args.all);
    const targetContainer = args.container ? sanitizeContainerIdentifier(args.container) : "";

    const jsonArgs = ["stats", "--no-stream"];
    const tableArgs = ["stats", "--no-stream"];

    if (includeAll) {
      jsonArgs.push("-a");
      tableArgs.push("-a");
    }

    jsonArgs.push("--format", "{{json .}}");

    if (targetContainer) {
      jsonArgs.push(targetContainer);
      tableArgs.push(targetContainer);
    }

    const [jsonCmd, tableCmd] = await Promise.all([
      runCommandSafe("docker", jsonArgs, 20000),
      runCommandSafe("docker", tableArgs, 20000),
    ]);

    if (jsonCmd.exitCode !== 0) {
      return formatToolResult(
        {
          error: "Failed to execute 'docker stats --no-stream'. Ensure Docker is running and the container exists.",
          details: jsonCmd.stderr || jsonCmd.error,
        },
        true
      );
    }

    const stats = parseDockerJsonLines(jsonCmd.stdout);

    return formatToolResult({
      timestamp: new Date().toISOString(),
      command: `docker ${tableArgs.join(" ")}`,
      count: stats.length,
      stats,
      raw_table: tableCmd.stdout,
    });
  },
};

/**
 * 4. Docker Container Logs Tool (`docker logs --tail`)
 */
export const monitorDockerLogsTool: ToolDefinition = {
  name: "monitor_docker_logs",
  description:
    "Fetch recent logs from a specific Docker container using 'docker logs --tail <lines>'. Supports optional timestamps and relative time filtering ('--since').",
  inputSchema: {
    type: "object",
    properties: {
      container: {
        type: "string",
        description: "The Docker container name or ID to fetch logs from (e.g., 'uni-mcp' or 'n8n').",
      },
      tail: {
        type: "number",
        description: "Number of recent log lines to retrieve (1 to 1000). Default: 100.",
        default: 100,
      },
      since: {
        type: "string",
        description:
          "Optional relative duration or ISO timestamp to filter logs (e.g., '10m', '1h', '24h', or '2026-10-23T00:00:00Z').",
      },
      timestamps: {
        type: "boolean",
        description: "If true, includes timestamps on each log line ('-t'). Default: false.",
        default: false,
      },
    },
    required: ["container"],
  },
  handler: async (args) => {
    const container = sanitizeContainerIdentifier(args.container);
    const rawTail = args.tail !== undefined ? Number(args.tail) : 100;
    const tail = Number.isFinite(rawTail) ? Math.min(Math.max(Math.floor(rawTail), 1), 1000) : 100;

    const dockerArgs = ["logs", "--tail", String(tail)];

    if (args.timestamps) {
      dockerArgs.push("-t");
    }

    if (args.since) {
      const sinceVal = String(args.since).trim();
      if (!/^[a-zA-Z0-9:._+-]+$/.test(sinceVal)) {
        throw new Error(
          "Invalid 'since' format. Use relative duration like '15m', '2h' or an ISO timestamp."
        );
      }
      dockerArgs.push("--since", sinceVal);
    }

    dockerArgs.push(container);

    const cmd = await runCommandSafe("docker", dockerArgs, 15000);

    if (cmd.exitCode !== 0) {
      return formatToolResult(
        {
          error: `Failed to fetch logs for container '${container}'.`,
          details: cmd.stderr || cmd.error,
        },
        true
      );
    }

    const combinedLogs = [cmd.stdout, cmd.stderr].filter(Boolean).join("\n");

    return formatToolResult({
      timestamp: new Date().toISOString(),
      container,
      command: `docker ${dockerArgs.join(" ")}`,
      tail,
      stdout: cmd.stdout,
      stderr: cmd.stderr,
      logs: combinedLogs,
    });
  },
};

export default [
  monitorSystemMetricsTool,
  monitorDockerContainersTool,
  monitorDockerStatsTool,
  monitorDockerLogsTool,
];
