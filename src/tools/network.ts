import os from "node:os";
import fs from "node:fs/promises";
import net from "node:net";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolDefinition, formatToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Safely executes a binary command without spawning a shell.
 */
async function runCommandSafe(
  command: string,
  args: string[],
  timeoutMs = 10000
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

export interface InterfaceTrafficMetrics {
  interface: string;
  rx: {
    bytes: number;
    megabytes: number;
    packets: number;
    errors: number;
    dropped: number;
    fifo: number;
    frame: number;
    compressed: number;
    multicast: number;
  };
  tx: {
    bytes: number;
    megabytes: number;
    packets: number;
    errors: number;
    dropped: number;
    fifo: number;
    colls: number;
    carrier: number;
    compressed: number;
  };
}

/**
 * 1. Traffic & Bandwidth: Reads and parses `/proc/net/dev` for RX/TX bytes, packets, errors, and drops per interface.
 */
async function getTrafficAndBandwidth(filterInterface?: string): Promise<{
  source: string;
  interfaces: InterfaceTrafficMetrics[];
  error?: string;
}> {
  try {
    const raw = await fs.readFile("/proc/net/dev", "utf8");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const metrics: InterfaceTrafficMetrics[] = [];

    // Skip the 2 header lines in /proc/net/dev
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const iface = line.slice(0, colonIdx).trim();
      if (filterInterface && iface !== filterInterface) continue;

      const fields = line
        .slice(colonIdx + 1)
        .trim()
        .split(/\s+/)
        .map((v) => Number(v) || 0);

      if (fields.length >= 16) {
        const rxBytes = fields[0];
        const txBytes = fields[8];
        metrics.push({
          interface: iface,
          rx: {
            bytes: rxBytes,
            megabytes: Number((rxBytes / (1024 * 1024)).toFixed(2)),
            packets: fields[1],
            errors: fields[2],
            dropped: fields[3],
            fifo: fields[4],
            frame: fields[5],
            compressed: fields[6],
            multicast: fields[7],
          },
          tx: {
            bytes: txBytes,
            megabytes: Number((txBytes / (1024 * 1024)).toFixed(2)),
            packets: fields[9],
            errors: fields[10],
            dropped: fields[11],
            fifo: fields[12],
            colls: fields[13],
            carrier: fields[14],
            compressed: fields[15],
          },
        });
      }
    }

    return {
      source: "/proc/net/dev",
      interfaces: metrics,
    };
  } catch (err: any) {
    return {
      source: "/proc/net/dev",
      interfaces: [],
      error: err?.message || String(err),
    };
  }
}

export interface NetworkInterfaceStatus {
  interface: string;
  status: "UP" | "DOWN" | "UNKNOWN";
  operstate: string;
  mac: string;
  internal: boolean;
  mtu?: number;
  ipv4: Array<{ address: string; netmask: string; cidr: string | null }>;
  ipv6: Array<{ address: string; netmask: string; cidr: string | null; scopeid?: number }>;
}

/**
 * 2. Interface Status: Combines `os.networkInterfaces()` and `/sys/class/net/<iface>/` for UP/DOWN status, MAC, IPv4, and IPv6.
 */
async function getNetworkInterfacesStatus(
  filterInterface?: string
): Promise<NetworkInterfaceStatus[]> {
  const osInterfaces = os.networkInterfaces();
  const ifaceNames = new Set<string>(Object.keys(osInterfaces));

  // Also discover interfaces from /sys/class/net (including DOWN interfaces not always returned by os.networkInterfaces)
  try {
    const sysNetEntries = await fs.readdir("/sys/class/net");
    for (const name of sysNetEntries) {
      ifaceNames.add(name);
    }
  } catch {
    // Ignore if /sys/class/net is unavailable
  }

  const results: NetworkInterfaceStatus[] = [];

  for (const iface of Array.from(ifaceNames).sort()) {
    if (filterInterface && iface !== filterInterface) continue;

    const addrs = osInterfaces[iface] || [];
    let operstate = "unknown";
    let sysMac = "";
    let mtu: number | undefined;
    let flags = 0;

    try {
      operstate = (await fs.readFile(`/sys/class/net/${iface}/operstate`, "utf8")).trim();
    } catch {
      // Fallback
    }

    try {
      sysMac = (await fs.readFile(`/sys/class/net/${iface}/address`, "utf8")).trim();
    } catch {
      // Fallback
    }

    try {
      const mtuStr = (await fs.readFile(`/sys/class/net/${iface}/mtu`, "utf8")).trim();
      const parsedMtu = Number(mtuStr);
      if (Number.isFinite(parsedMtu)) mtu = parsedMtu;
    } catch {
      // Fallback
    }

    try {
      const flagsStr = (await fs.readFile(`/sys/class/net/${iface}/flags`, "utf8")).trim();
      flags = Number.parseInt(flagsStr, 16) || 0;
    } catch {
      // Fallback
    }

    const ipv4 = addrs
      .filter((a) => a.family === "IPv4")
      .map((a) => ({
        address: a.address,
        netmask: a.netmask,
        cidr: a.cidr,
      }));

    const ipv6 = addrs
      .filter((a) => a.family === "IPv6")
      .map((a) => ({
        address: a.address,
        netmask: a.netmask,
        cidr: a.cidr,
        scopeid: a.scopeid,
      }));

    const mac = addrs.find((a) => a.mac && a.mac !== "00:00:00:00:00:00")?.mac || sysMac || "00:00:00:00:00:00";
    const internal = addrs.some((a) => a.internal) || iface === "lo";

    // Determine UP/DOWN status from operstate, interface flags (IFF_UP = 0x1), or assigned addresses
    let status: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
    if (operstate === "up" || (operstate === "unknown" && (flags & 0x1 || addrs.length > 0))) {
      status = "UP";
    } else if (operstate === "down") {
      status = "DOWN";
    } else if (addrs.length > 0) {
      status = "UP";
    }

    results.push({
      interface: iface,
      status,
      operstate,
      mac,
      internal,
      ...(mtu !== undefined ? { mtu } : {}),
      ipv4,
      ipv6,
    });
  }

  return results;
}

/**
 * Decodes 8-char hex IPv4 little-endian string from `/proc/net/tcp` into dotted quad IPv4 string.
 */
function decodeProcIpv4(hexIp: string): string {
  if (hexIp.length !== 8) return hexIp;
  const b1 = Number.parseInt(hexIp.slice(6, 8), 16);
  const b2 = Number.parseInt(hexIp.slice(4, 6), 16);
  const b3 = Number.parseInt(hexIp.slice(2, 4), 16);
  const b4 = Number.parseInt(hexIp.slice(0, 2), 16);
  return `${b1}.${b2}.${b3}.${b4}`;
}

/**
 * Decodes 32-char hex IPv6 string from `/proc/net/tcp6` into standard IPv6 notation.
 */
function decodeProcIpv6(hexIp6: string): string {
  if (hexIp6.length !== 32) return hexIp6;
  const words: string[] = [];
  for (let wordIdx = 0; wordIdx < 4; wordIdx++) {
    const wordHex = hexIp6.slice(wordIdx * 8, (wordIdx + 1) * 8);
    // Each 32-bit word in /proc/net/tcp6 is stored in host byte order (little-endian on x86_64/arm64)
    const b0 = wordHex.slice(6, 8);
    const b1 = wordHex.slice(4, 6);
    const b2 = wordHex.slice(2, 4);
    const b3 = wordHex.slice(0, 2);
    words.push(`${b0}${b1}`, `${b2}${b3}`);
  }
  const rawIpv6 = words.map((w) => w.replace(/^0+/, "") || "0").join(":");
  if (rawIpv6 === "0:0:0:0:0:0:0:0") return "::";
  if (rawIpv6 === "0:0:0:0:0:0:0:1") return "::1";
  return rawIpv6;
}

const TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

export interface SocketEntry {
  protocol: "tcp" | "tcp6" | "udp" | "udp6";
  local_address: string;
  local_port: number;
  remote_address: string;
  remote_port: number;
  state: string;
  uid: number;
  inode: string;
}

/**
 * Parses `/proc/net/{tcp,tcp6,udp,udp6}` for listening sockets and active connections summary.
 */
async function parseProcNetFile(
  filePath: string,
  protocol: "tcp" | "tcp6" | "udp" | "udp6",
  isIpv6: boolean
): Promise<SocketEntry[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries: SocketEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/);
      if (parts.length < 10) continue;

      const [localHexIp, localHexPort] = parts[1].split(":");
      const [remoteHexIp, remoteHexPort] = parts[2].split(":");
      const stateHex = parts[3].toUpperCase();
      const uid = Number(parts[7]) || 0;
      const inode = parts[9];

      const localAddress = isIpv6 ? decodeProcIpv6(localHexIp) : decodeProcIpv4(localHexIp);
      const remoteAddress = isIpv6 ? decodeProcIpv6(remoteHexIp) : decodeProcIpv4(remoteHexIp);
      const localPort = Number.parseInt(localHexPort, 16) || 0;
      const remotePort = Number.parseInt(remoteHexPort, 16) || 0;

      let state = TCP_STATES[stateHex] || stateHex;
      if (protocol.startsWith("udp")) {
        // For UDP sockets in /proc/net/udp, 07 (CLOSE/UNCONN) with local port bound is listening/unconnected, 01 is ESTABLISHED
        state = stateHex === "07" ? "UNCONN" : stateHex === "01" ? "ESTABLISHED" : state;
      }

      entries.push({
        protocol,
        local_address: localAddress,
        local_port: localPort,
        remote_address: remoteAddress,
        remote_port: remotePort,
        state,
        uid,
        inode,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * 3. Listening Ports & Active Connections: Reads `/proc/net/{tcp,tcp6,udp,udp6}` and also attempts `ss -tuln` or `netstat -tuln`.
 */
async function getListeningPortsAndConnections(): Promise<{
  listening_ports: SocketEntry[];
  active_connections_summary: Record<string, number>;
  active_established_sample: SocketEntry[];
  command_output?: { command: string; raw: string };
}> {
  const [tcp, tcp6, udp, udp6] = await Promise.all([
    parseProcNetFile("/proc/net/tcp", "tcp", false),
    parseProcNetFile("/proc/net/tcp6", "tcp6", true),
    parseProcNetFile("/proc/net/udp", "udp", false),
    parseProcNetFile("/proc/net/udp6", "udp6", true),
  ]);

  const allSockets = [...tcp, ...tcp6, ...udp, ...udp6];

  const listeningPorts = allSockets.filter(
    (s) =>
      (s.protocol.startsWith("tcp") && s.state === "LISTEN") ||
      (s.protocol.startsWith("udp") && s.state === "UNCONN" && s.local_port > 0)
  );

  // Deduplicate and sort listening ports by protocol & port
  listeningPorts.sort((a, b) => a.local_port - b.local_port || a.protocol.localeCompare(b.protocol));

  const stateSummary: Record<string, number> = {};
  for (const s of allSockets) {
    const key = `${s.protocol.toUpperCase()}_${s.state}`;
    stateSummary[key] = (stateSummary[key] || 0) + 1;
  }

  const establishedSample = allSockets
    .filter((s) => s.state === "ESTABLISHED")
    .slice(0, 50);

  // Try optional `ss -tuln` or `netstat -tuln` if installed on the system
  let commandOutput: { command: string; raw: string } | undefined;
  const ssCmd = await runCommandSafe("ss", ["-tuln"], 5000);
  if (ssCmd.exitCode === 0 && ssCmd.stdout) {
    commandOutput = { command: "ss -tuln", raw: ssCmd.stdout };
  } else {
    const netstatCmd = await runCommandSafe("netstat", ["-tuln"], 5000);
    if (netstatCmd.exitCode === 0 && netstatCmd.stdout) {
      commandOutput = { command: "netstat -tuln", raw: netstatCmd.stdout };
    }
  }

  return {
    listening_ports: listeningPorts,
    active_connections_summary: stateSummary,
    active_established_sample: establishedSample,
    ...(commandOutput ? { command_output: commandOutput } : {}),
  };
}

export interface LatencyProbeResult {
  target: string;
  port: number;
  method: "tcp_socket" | "dns_lookup_fallback";
  reachable: boolean;
  latency_ms: number | null;
  error?: string;
}

/**
 * Measures TCP handshake RTT (in ms) to target host:port with safe fallback.
 */
function measureTcpLatency(host: string, port = 53, timeoutMs = 3000): Promise<LatencyProbeResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      const elapsed = Number((performance.now() - start).toFixed(2));
      socket.destroy();
      resolve({
        target: host,
        port,
        method: "tcp_socket",
        reachable,
        latency_ms: reachable ? elapsed : null,
        ...(error ? { error } : {}),
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `Connection timed out after ${timeoutMs}ms`));
    socket.once("error", (err) => finish(false, err.message));

    socket.connect(port, host);
  });
}

/**
 * 4. Connectivity & Latency Test: Tests RTT (ms) to 1.1.1.1 and 8.8.8.8 (plus optional custom target) and DNS resolution.
 */
async function checkConnectivityAndLatency(customTargets?: string[]): Promise<{
  internet_connected: boolean;
  average_latency_ms: number | null;
  probes: LatencyProbeResult[];
  dns_resolution_test: {
    hostname: string;
    resolved: boolean;
    latency_ms: number | null;
    addresses?: string[];
    error?: string;
  };
}> {
  const defaultTargets = ["1.1.1.1", "8.8.8.8"];
  const targets = Array.from(new Set([...defaultTargets, ...(customTargets || [])]));

  const probes = await Promise.all(
    targets.map(async (target) => {
      const tcp53 = await measureTcpLatency(target, 53, 3000);
      if (tcp53.reachable) return tcp53;
      // Fallback to TCP 443 (DoH endpoint on 1.1.1.1 / 8.8.8.8) if port 53 is blocked by firewall
      const tcp443 = await measureTcpLatency(target, 443, 3000);
      if (tcp443.reachable) return tcp443;
      return tcp53;
    })
  );

  // DNS resolution test
  const dnsStart = performance.now();
  let dnsTest: {
    hostname: string;
    resolved: boolean;
    latency_ms: number | null;
    addresses?: string[];
    error?: string;
  };
  try {
    const records = await dns.resolve4("cloudflare.com");
    dnsTest = {
      hostname: "cloudflare.com",
      resolved: true,
      latency_ms: Number((performance.now() - dnsStart).toFixed(2)),
      addresses: records,
    };
  } catch (err: any) {
    dnsTest = {
      hostname: "cloudflare.com",
      resolved: false,
      latency_ms: null,
      error: err?.message || String(err),
    };
  }

  const reachableProbes = probes.filter((p) => p.reachable && p.latency_ms !== null);
  const avgLatency =
    reachableProbes.length > 0
      ? Number(
          (
            reachableProbes.reduce((acc, cur) => acc + (cur.latency_ms || 0), 0) /
            reachableProbes.length
          ).toFixed(2)
        )
      : null;

  return {
    internet_connected: reachableProbes.length > 0 || dnsTest.resolved,
    average_latency_ms: avgLatency,
    probes,
    dns_resolution_test: dnsTest,
  };
}

/**
 * Validates optional target IP/hostname for latency check.
 */
function sanitizeHostTarget(input: unknown): string {
  const value = String(input || "").trim();
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(value)) {
    throw new Error(`Invalid target host '${value}'.`);
  }
  return value;
}

/**
 * MCP Tool: `monitor_network`
 */
export const monitorNetworkTool: ToolDefinition = {
  name: "monitor_network",
  description:
    "Monitor Ubuntu host network metrics including: (1) Traffic & Bandwidth per interface (RX/TX bytes, packets, drops, errors from /proc/net/dev), (2) Network Interface Status (IPv4, IPv6, MAC address, UP/DOWN state, MTU), (3) Listening TCP/UDP Ports & Active Connections summary (/proc/net/tcp, /proc/net/udp, ss/netstat), and (4) Internet Connectivity & RTT Latency test to public DNS (1.1.1.1 and 8.8.8.8).",
  inputSchema: {
    type: "object",
    properties: {
      interface: {
        type: "string",
        description:
          "Optional specific network interface name to filter traffic and status (e.g., 'eth0', 'ens3', 'docker0'). If omitted, returns all interfaces.",
      },
      extra_ping_targets: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of additional hostnames or IPv4 addresses to test TCP latency against besides 1.1.1.1 and 8.8.8.8.",
      },
    },
    required: [],
  },
  handler: async (args) => {
    const filterInterface = args.interface ? String(args.interface).trim() : undefined;
    if (filterInterface && !/^[a-zA-Z0-9_.:-]{1,32}$/.test(filterInterface)) {
      throw new Error("Invalid 'interface' name format.");
    }

    const extraTargets: string[] = [];
    if (Array.isArray(args.extra_ping_targets)) {
      for (const item of args.extra_ping_targets.slice(0, 5)) {
        extraTargets.push(sanitizeHostTarget(item));
      }
    }

    const [interfacesStatus, traffic, sockets, connectivity] = await Promise.all([
      getNetworkInterfacesStatus(filterInterface),
      getTrafficAndBandwidth(filterInterface),
      getListeningPortsAndConnections(),
      checkConnectivityAndLatency(extraTargets),
    ]);

    return formatToolResult({
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      interfaces_status: interfacesStatus,
      traffic_and_bandwidth: traffic,
      ports_and_connections: sockets,
      connectivity_and_latency: connectivity,
    });
  },
};

export default [monitorNetworkTool];
