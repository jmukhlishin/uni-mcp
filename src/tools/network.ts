import os from "node:os";
import fs from "node:fs/promises";
import net from "node:net";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolDefinition, formatToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OFFICE_SUBNET = "192.168.0.0/24";
const DEFAULT_HOST_IP = "192.168.0.3";
const DEFAULT_MIKROTIK_GATEWAY = "192.168.0.254";
const DEFAULT_SCAN_PORTS = [
  21,   // FTP
  22,   // SSH
  23,   // Telnet
  53,   // DNS
  80,   // HTTP
  443,  // HTTPS
  445,  // SMB
  3301, // uni-mcp
  3389, // RDP
  5678, // n8n
  8080, // HTTP Alt
  8291, // Mikrotik Winbox
  8728, // Mikrotik API
];

const PORT_SERVICE_NAMES: Record<number, string> = {
  21: "FTP",
  22: "SSH",
  23: "Telnet",
  53: "DNS",
  80: "HTTP",
  443: "HTTPS",
  445: "SMB",
  3301: "uni-mcp",
  3306: "MySQL",
  3389: "RDP",
  5432: "PostgreSQL",
  5678: "n8n",
  6379: "Redis",
  8080: "HTTP-Alt",
  8291: "Mikrotik-Winbox",
  8443: "HTTPS-Alt",
  8728: "Mikrotik-API",
  8729: "Mikrotik-API-SSL",
};

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

/**
 * Checks whether a directory or file exists.
 */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the preferred `/proc/net` base directory:
 * Prioritizes `/host/proc/net` if mounted, falls back to `/proc/net`.
 */
async function resolveProcNetBase(): Promise<string> {
  if (await pathExists("/host/proc/net/dev")) {
    return "/host/proc/net";
  }
  return "/proc/net";
}

/**
 * Resolves the preferred `/sys/class/net` base directory:
 * Prioritizes `/host/sys/class/net` if mounted, falls back to `/sys/class/net`.
 */
async function resolveSysNetBase(): Promise<string> {
  if (await pathExists("/host/sys/class/net")) {
    return "/host/sys/class/net";
  }
  return "/sys/class/net";
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
 * 1. Traffic & Bandwidth: Reads and parses `/host/proc/net/dev` (or fallback `/proc/net/dev`)
 * for RX/TX bytes, packets, errors, and drops per interface.
 */
async function getTrafficAndBandwidth(filterInterface?: string): Promise<{
  source: string;
  interfaces: InterfaceTrafficMetrics[];
  error?: string;
}> {
  const procNetBase = await resolveProcNetBase();
  const devFile = `${procNetBase}/dev`;

  try {
    const raw = await fs.readFile(devFile, "utf8");
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
      source: devFile,
      interfaces: metrics,
    };
  } catch (err: any) {
    return {
      source: devFile,
      interfaces: [],
      error: err?.message || String(err),
    };
  }
}

export interface InterfaceTrafficRateAndStorm {
  interface: string;
  sample_interval_ms: number;
  rx_rate: {
    bytes_per_sec: number;
    mbps: number;
    packets_per_sec: number;
    errors_delta: number;
    dropped_delta: number;
    multicast_delta: number;
    avg_packet_size_bytes: number;
  };
  tx_rate: {
    bytes_per_sec: number;
    mbps: number;
    packets_per_sec: number;
    errors_delta: number;
    dropped_delta: number;
    avg_packet_size_bytes: number;
  };
  anomaly_detection: {
    flag: "NORMAL" | "POTENTIAL_LOOPING_OR_STORM";
    reasons: string[];
  };
}

/**
 * Samples `/host/proc/net/dev` (or `/proc/net/dev`) twice over `sampleIntervalMs`
 * to compute real-time transfer rate (B/s, Mbps, PPS) and detect Broadcast Storm / Network Looping.
 */
async function analyzeTrafficRateAndStorm(
  filterInterface?: string,
  sampleIntervalMs = 1000
): Promise<{
  source: string;
  sample_interval_ms: number;
  has_storm_warning: boolean;
  warnings: string[];
  interfaces: InterfaceTrafficRateAndStorm[];
}> {
  const clampedInterval = Math.min(Math.max(sampleIntervalMs, 250), 5000);
  const startTime = performance.now();
  const snap1 = await getTrafficAndBandwidth(filterInterface);

  await new Promise((r) => setTimeout(r, clampedInterval));

  const snap2 = await getTrafficAndBandwidth(filterInterface);
  const elapsedMs = Math.max(performance.now() - startTime, 1);
  const elapsedSec = elapsedMs / 1000;

  const snap1Map = new Map<string, InterfaceTrafficMetrics>();
  for (const item of snap1.interfaces) {
    snap1Map.set(item.interface, item);
  }

  const results: InterfaceTrafficRateAndStorm[] = [];
  const globalWarnings: string[] = [];

  for (const cur of snap2.interfaces) {
    const prev = snap1Map.get(cur.interface);
    if (!prev) continue;

    const rxBytesDelta = Math.max(0, cur.rx.bytes - prev.rx.bytes);
    const txBytesDelta = Math.max(0, cur.tx.bytes - prev.tx.bytes);
    const rxPacketsDelta = Math.max(0, cur.rx.packets - prev.rx.packets);
    const txPacketsDelta = Math.max(0, cur.tx.packets - prev.tx.packets);
    const rxErrorsDelta = Math.max(0, cur.rx.errors - prev.rx.errors);
    const txErrorsDelta = Math.max(0, cur.tx.errors - prev.tx.errors);
    const rxDroppedDelta = Math.max(0, cur.rx.dropped - prev.rx.dropped);
    const txDroppedDelta = Math.max(0, cur.tx.dropped - prev.tx.dropped);
    const rxMulticastDelta = Math.max(0, cur.rx.multicast - prev.rx.multicast);

    const rxBps = Number((rxBytesDelta / elapsedSec).toFixed(2));
    const txBps = Number((txBytesDelta / elapsedSec).toFixed(2));
    const rxMbps = Number(((rxBps * 8) / (1000 * 1000)).toFixed(3));
    const txMbps = Number(((txBps * 8) / (1000 * 1000)).toFixed(3));
    const rxPps = Number((rxPacketsDelta / elapsedSec).toFixed(2));
    const txPps = Number((txPacketsDelta / elapsedSec).toFixed(2));

    const rxAvgPkt = rxPacketsDelta > 0 ? Number((rxBytesDelta / rxPacketsDelta).toFixed(1)) : 0;
    const txAvgPkt = txPacketsDelta > 0 ? Number((txBytesDelta / txPacketsDelta).toFixed(1)) : 0;

    const reasons: string[] = [];

    // 1. High PPS with small average packet size (classic Layer-2 Broadcast Storm / ARP storm / Switching Loop)
    if (rxPps > 2500 && rxAvgPkt > 0 && rxAvgPkt < 140) {
      reasons.push(
        `High RX packet rate (${rxPps} pkt/s) with small avg packet size (${rxAvgPkt} B) indicating potential broadcast/ARP storm or switching loop`
      );
    }
    if (txPps > 2500 && txAvgPkt > 0 && txAvgPkt < 140) {
      reasons.push(
        `High TX packet rate (${txPps} pkt/s) with small avg packet size (${txAvgPkt} B) indicating potential packet flood/loop`
      );
    }

    // 2. Extreme packet rate surge
    if (rxPps > 15000 || txPps > 15000) {
      reasons.push(`Extreme packet rate detected (RX: ${rxPps} pkt/s, TX: ${txPps} pkt/s)`);
    }

    // 3. Multicast / Broadcast surge
    const multicastPps = rxMulticastDelta / elapsedSec;
    if (multicastPps > 1000) {
      reasons.push(`High multicast/broadcast frame rate (${multicastPps.toFixed(1)} pkt/s)`);
    }

    // 4. High dropped / error packet delta or ratio during sampling window
    const totalDropsErrorsDelta = rxErrorsDelta + txErrorsDelta + rxDroppedDelta + txDroppedDelta;
    const totalPacketsDelta = rxPacketsDelta + txPacketsDelta;
    if (
      totalDropsErrorsDelta >= 20 ||
      (totalPacketsDelta >= 50 && totalDropsErrorsDelta / totalPacketsDelta > 0.05)
    ) {
      reasons.push(
        `Elevated packet drops/errors during sample window (RX drops: +${rxDroppedDelta}, RX err: +${rxErrorsDelta}, TX drops: +${txDroppedDelta}, TX err: +${txErrorsDelta})`
      );
    }

    // 5. Historical cumulative drop/error ratio warning (> 2% on active physical interface)
    const cumulativeTotalPkts = cur.rx.packets + cur.tx.packets;
    const cumulativeTotalDropsErrs =
      cur.rx.dropped + cur.rx.errors + cur.tx.dropped + cur.tx.errors;
    if (
      cur.interface !== "lo" &&
      cumulativeTotalPkts > 10000 &&
      cumulativeTotalDropsErrs / cumulativeTotalPkts > 0.02
    ) {
      const pct = ((cumulativeTotalDropsErrs / cumulativeTotalPkts) * 100).toFixed(2);
      reasons.push(
        `High cumulative drop/error ratio (${pct}% of total packets on ${cur.interface})`
      );
    }

    const flag = reasons.length > 0 ? "POTENTIAL_LOOPING_OR_STORM" : "NORMAL";
    if (flag === "POTENTIAL_LOOPING_OR_STORM") {
      globalWarnings.push(`[${cur.interface}] POTENTIAL_LOOPING_OR_STORM: ${reasons.join("; ")}`);
    }

    results.push({
      interface: cur.interface,
      sample_interval_ms: Math.round(elapsedMs),
      rx_rate: {
        bytes_per_sec: rxBps,
        mbps: rxMbps,
        packets_per_sec: rxPps,
        errors_delta: rxErrorsDelta,
        dropped_delta: rxDroppedDelta,
        multicast_delta: rxMulticastDelta,
        avg_packet_size_bytes: rxAvgPkt,
      },
      tx_rate: {
        bytes_per_sec: txBps,
        mbps: txMbps,
        packets_per_sec: txPps,
        errors_delta: txErrorsDelta,
        dropped_delta: txDroppedDelta,
        avg_packet_size_bytes: txAvgPkt,
      },
      anomaly_detection: {
        flag,
        reasons,
      },
    });
  }

  return {
    source: snap2.source,
    sample_interval_ms: Math.round(elapsedMs),
    has_storm_warning: globalWarnings.length > 0,
    warnings: globalWarnings,
    interfaces: results,
  };
}

export interface NetworkInterfaceStatus {
  interface: string;
  status: "UP" | "DOWN" | "UNKNOWN";
  operstate: string;
  mac: string;
  internal: boolean;
  mtu?: number;
  speed_mbps?: number;
  ipv4: Array<{ address: string; netmask: string; cidr: string | null }>;
  ipv6: Array<{ address: string; netmask: string; cidr: string | null; scopeid?: number }>;
}

/**
 * 2. Interface Status: Combines `os.networkInterfaces()`, `/host/sys/class/net` (or `/sys/class/net`),
 * and `/host/proc/net/fib_trie` so host physical interfaces (e.g. 192.168.0.3) are visible even inside a bridge container.
 */
async function getNetworkInterfacesStatus(
  filterInterface?: string
): Promise<{
  sys_net_source: string;
  interfaces: NetworkInterfaceStatus[];
}> {
  const sysNetBase = await resolveSysNetBase();
  const procNetBase = await resolveProcNetBase();
  const osInterfaces = os.networkInterfaces();
  const ifaceNames = new Set<string>(Object.keys(osInterfaces));

  try {
    const sysNetEntries = await fs.readdir(sysNetBase);
    for (const name of sysNetEntries) {
      ifaceNames.add(name);
    }
  } catch {
    // Ignore if sysfs is unavailable
  }

  // Also include interfaces seen in /host/proc/net/dev
  try {
    const devRaw = await fs.readFile(`${procNetBase}/dev`, "utf8");
    const lines = devRaw.split(/\r?\n/).slice(2);
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const name = line.slice(0, idx).trim();
        if (name) ifaceNames.add(name);
      }
    }
  } catch {
    // Ignore
  }

  const results: NetworkInterfaceStatus[] = [];

  for (const iface of Array.from(ifaceNames).sort()) {
    if (filterInterface && iface !== filterInterface) continue;

    const addrs = osInterfaces[iface] || [];
    let operstate = "unknown";
    let sysMac = "";
    let mtu: number | undefined;
    let speedMbps: number | undefined;
    let flags = 0;

    try {
      operstate = (await fs.readFile(`${sysNetBase}/${iface}/operstate`, "utf8")).trim();
    } catch {
      // Fallback
    }

    try {
      sysMac = (await fs.readFile(`${sysNetBase}/${iface}/address`, "utf8")).trim();
    } catch {
      // Fallback
    }

    try {
      const mtuStr = (await fs.readFile(`${sysNetBase}/${iface}/mtu`, "utf8")).trim();
      const parsedMtu = Number(mtuStr);
      if (Number.isFinite(parsedMtu)) mtu = parsedMtu;
    } catch {
      // Fallback
    }

    try {
      const speedStr = (await fs.readFile(`${sysNetBase}/${iface}/speed`, "utf8")).trim();
      const parsedSpeed = Number(speedStr);
      if (Number.isFinite(parsedSpeed) && parsedSpeed > 0) speedMbps = parsedSpeed;
    } catch {
      // Fallback (virtual interfaces often return EINVAL on speed)
    }

    try {
      const flagsStr = (await fs.readFile(`${sysNetBase}/${iface}/flags`, "utf8")).trim();
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

    const mac =
      addrs.find((a) => a.mac && a.mac !== "00:00:00:00:00:00")?.mac ||
      sysMac ||
      "00:00:00:00:00:00";
    const internal = addrs.some((a) => a.internal) || iface === "lo";

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
      ...(speedMbps !== undefined ? { speed_mbps: speedMbps } : {}),
      ipv4,
      ipv6,
    });
  }

  return {
    sys_net_source: sysNetBase,
    interfaces: results,
  };
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
 * Parses `/host/proc/net/{tcp,tcp6,udp,udp6}` (or fallback `/proc/net/...`)
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
 * 3. Listening Ports & Active Connections: Prioritizes `/host/proc/net/{tcp,tcp6,udp,udp6}` and falls back to `/proc/net`.
 */
async function getListeningPortsAndConnections(): Promise<{
  proc_net_source: string;
  listening_ports: SocketEntry[];
  active_connections_summary: Record<string, number>;
  active_established_sample: SocketEntry[];
  command_output?: { command: string; raw: string };
}> {
  const procNetBase = await resolveProcNetBase();

  const [tcp, tcp6, udp, udp6] = await Promise.all([
    parseProcNetFile(`${procNetBase}/tcp`, "tcp", false),
    parseProcNetFile(`${procNetBase}/tcp6`, "tcp6", true),
    parseProcNetFile(`${procNetBase}/udp`, "udp", false),
    parseProcNetFile(`${procNetBase}/udp6`, "udp6", true),
  ]);

  const allSockets = [...tcp, ...tcp6, ...udp, ...udp6];

  const listeningPorts = allSockets.filter(
    (s) =>
      (s.protocol.startsWith("tcp") && s.state === "LISTEN") ||
      (s.protocol.startsWith("udp") && s.state === "UNCONN" && s.local_port > 0)
  );

  listeningPorts.sort(
    (a, b) => a.local_port - b.local_port || a.protocol.localeCompare(b.protocol)
  );

  const stateSummary: Record<string, number> = {};
  for (const s of allSockets) {
    const key = `${s.protocol.toUpperCase()}_${s.state}`;
    stateSummary[key] = (stateSummary[key] || 0) + 1;
  }

  const establishedSample = allSockets
    .filter((s) => s.state === "ESTABLISHED")
    .slice(0, 50);

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
    proc_net_source: procNetBase,
    listening_ports: listeningPorts,
    active_connections_summary: stateSummary,
    active_established_sample: establishedSample,
    ...(commandOutput ? { command_output: commandOutput } : {}),
  };
}

/**
 * Reads `/host/proc/net/arp` (or `/proc/net/arp`) for known LAN IP -> MAC mappings on the host.
 */
export interface ArpNeighborEntry {
  ip: string;
  hw_type: string;
  flags: string;
  reachable_in_arp: boolean;
  mac: string;
  interface: string;
}

async function getHostArpTable(): Promise<{
  source: string;
  entries: ArpNeighborEntry[];
}> {
  const procNetBase = await resolveProcNetBase();
  const arpFile = `${procNetBase}/arp`;
  try {
    const raw = await fs.readFile(arpFile, "utf8");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries: ArpNeighborEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/);
      if (parts.length < 6) continue;
      const ip = parts[0];
      const hwType = parts[1];
      const flags = parts[2];
      const mac = parts[3];
      const iface = parts[5];
      entries.push({
        ip,
        hw_type: hwType,
        flags,
        reachable_in_arp: flags !== "0x0" && mac !== "00:00:00:00:00:00",
        mac,
        interface: iface,
      });
    }

    return { source: arpFile, entries };
  } catch {
    return { source: arpFile, entries: [] };
  }
}

export interface LatencyProbeResult {
  target: string;
  port: number;
  method: "tcp_socket" | "icmp_ping";
  reachable: boolean;
  latency_ms: number | null;
  status?: "OPEN" | "CLOSED_HOST_ALIVE" | "TIMEOUT_OR_UNREACHABLE";
  error?: string;
}

/**
 * Measures TCP probe RTT (in ms) to target host:port.
 * Note: For LAN hosts, `ECONNREFUSED` (TCP RST) proves the host IP is online and reachable!
 */
function measureTcpProbe(
  host: string,
  port: number,
  timeoutMs = 1500,
  treatResetAsAlive = false
): Promise<LatencyProbeResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (
      reachable: boolean,
      status: "OPEN" | "CLOSED_HOST_ALIVE" | "TIMEOUT_OR_UNREACHABLE",
      error?: string
    ) => {
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
        status,
        ...(error ? { error } : {}),
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "OPEN"));
    socket.once("timeout", () =>
      finish(false, "TIMEOUT_OR_UNREACHABLE", `Timed out after ${timeoutMs}ms`)
    );
    socket.once("error", (err: any) => {
      if (treatResetAsAlive && err?.code === "ECONNREFUSED") {
        finish(true, "CLOSED_HOST_ALIVE");
      } else {
        finish(false, "TIMEOUT_OR_UNREACHABLE", err?.message || String(err));
      }
    });

    socket.connect(port, host);
  });
}

/**
 * Attempts ICMP ping (`ping -c 1 -W 1 <host>`) with fallback to multi-port TCP probe.
 */
async function probeHostAliveAndLatency(
  host: string,
  probePorts = [80, 443, 22, 8291, 53, 445],
  timeoutMs = 800
): Promise<{
  ip: string;
  online: boolean;
  latency_ms: number | null;
  detection_method: string;
  open_probe_port?: number;
}> {
  // Fast parallel TCP probes across common ports; ECONNREFUSED also confirms host is alive on LAN
  const tcpChecks = await Promise.all(
    probePorts.map((port) => measureTcpProbe(host, port, timeoutMs, true))
  );

  const aliveProbes = tcpChecks.filter((p) => p.reachable && p.latency_ms !== null);
  if (aliveProbes.length > 0) {
    // Prefer OPEN port first, otherwise lowest latency ECONNREFUSED
    const openProbe = aliveProbes.find((p) => p.status === "OPEN");
    const best =
      openProbe ||
      aliveProbes.reduce((prev, cur) =>
        (cur.latency_ms ?? 9999) < (prev.latency_ms ?? 9999) ? cur : prev
      );
    return {
      ip: host,
      online: true,
      latency_ms: best.latency_ms,
      detection_method:
        best.status === "OPEN"
          ? `tcp_connect:${best.port}`
          : `tcp_rst_alive:${best.port}`,
      ...(best.status === "OPEN" ? { open_probe_port: best.port } : {}),
    };
  }

  // Fallback to ICMP ping if permitted inside container
  const pingRes = await runCommandSafe("ping", ["-c", "1", "-W", "1", host], 1500);
  if (pingRes.exitCode === 0 && pingRes.stdout) {
    const match = pingRes.stdout.match(/time[=<]([\d.]+)\s*ms/i);
    const rtt = match ? Number(match[1]) : null;
    return {
      ip: host,
      online: true,
      latency_ms: rtt,
      detection_method: "icmp_ping",
    };
  }

  return {
    ip: host,
    online: false,
    latency_ms: null,
    detection_method: "none",
  };
}

/**
 * 4. Connectivity, Gateway Watchdog & Speed/Throughput Latency Test:
 * Tests Mikrotik Gateway (192.168.0.254), Host Ubuntu Server (192.168.0.3), and Internet targets (1.1.1.1, 8.8.8.8),
 * plus optional HTTP download throughput test to Cloudflare speed endpoint.
 */
async function checkConnectivityGatewayAndThroughput(
  gatewayIp = DEFAULT_MIKROTIK_GATEWAY,
  customTargets?: string[],
  includeThroughputTest = false
): Promise<{
  gateway_watchdog: {
    gateway_ip: string;
    role: string;
    online: boolean;
    latency_ms: number | null;
    jitter_ms: number | null;
    detection_method: string;
    open_services: number[];
    status: "HEALTHY" | "HIGH_LATENCY" | "UNREACHABLE";
  };
  internet_connected: boolean;
  average_internet_latency_ms: number | null;
  probes: LatencyProbeResult[];
  dns_resolution_test: {
    hostname: string;
    resolved: boolean;
    latency_ms: number | null;
    addresses?: string[];
    error?: string;
  };
  throughput_benchmark?: {
    tested: boolean;
    target_url: string;
    bytes_transferred: number;
    duration_ms: number;
    download_speed_mbps: number | null;
    error?: string;
  };
}> {
  // A. Gateway Watchdog (Mikrotik 192.168.0.254) - run 3 samples to measure latency & jitter
  const gwPorts = [8291, 80, 53, 22, 443, 8728];
  const gwPortChecks = await Promise.all(
    gwPorts.map((port) => measureTcpProbe(gatewayIp, port, 1200, true))
  );
  const gwOpenServices = gwPortChecks
    .filter((p) => p.status === "OPEN")
    .map((p) => p.port);

  const gwBestPort = gwOpenServices[0] || 80;
  const gwSamples: number[] = [];
  let gwMethod = "none";

  for (let i = 0; i < 3; i++) {
    const sample = await measureTcpProbe(gatewayIp, gwBestPort, 1000, true);
    if (sample.reachable && sample.latency_ms !== null) {
      gwSamples.push(sample.latency_ms);
      gwMethod =
        sample.status === "OPEN"
          ? `tcp_connect:${gwBestPort}`
          : `tcp_rst_alive:${gwBestPort}`;
    }
  }

  if (gwSamples.length === 0) {
    const fallbackGw = await probeHostAliveAndLatency(gatewayIp, gwPorts, 1000);
    if (fallbackGw.online && fallbackGw.latency_ms !== null) {
      gwSamples.push(fallbackGw.latency_ms);
      gwMethod = fallbackGw.detection_method;
    }
  }

  const gwOnline = gwSamples.length > 0;
  const gwAvgLatency = gwOnline
    ? Number((gwSamples.reduce((a, b) => a + b, 0) / gwSamples.length).toFixed(2))
    : null;
  const gwJitter =
    gwSamples.length > 1
      ? Number((Math.max(...gwSamples) - Math.min(...gwSamples)).toFixed(2))
      : 0;

  let gwStatus: "HEALTHY" | "HIGH_LATENCY" | "UNREACHABLE" = "UNREACHABLE";
  if (gwOnline) {
    gwStatus = (gwAvgLatency ?? 0) > 50 ? "HIGH_LATENCY" : "HEALTHY";
  }

  // B. Public DNS & Custom Internet Targets
  const defaultTargets = ["1.1.1.1", "8.8.8.8"];
  const targets = Array.from(new Set([...defaultTargets, ...(customTargets || [])]));

  const probes = await Promise.all(
    targets.map(async (target) => {
      const tcp53 = await measureTcpProbe(target, 53, 2500, false);
      if (tcp53.reachable) return tcp53;
      const tcp443 = await measureTcpProbe(target, 443, 2500, false);
      if (tcp443.reachable) return tcp443;
      return tcp53;
    })
  );

  // C. DNS Resolution Test
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
  const avgInternetLatency =
    reachableProbes.length > 0
      ? Number(
          (
            reachableProbes.reduce((acc, cur) => acc + (cur.latency_ms || 0), 0) /
            reachableProbes.length
          ).toFixed(2)
        )
      : null;

  // D. Optional Lightweight HTTP Download Speed / Throughput Benchmark (1 MB payload from Cloudflare)
  let throughputBenchmark:
    | {
        tested: boolean;
        target_url: string;
        bytes_transferred: number;
        duration_ms: number;
        download_speed_mbps: number | null;
        error?: string;
      }
    | undefined;

  if (includeThroughputTest) {
    const testUrl = "https://speed.cloudflare.com/__down?bytes=1000000";
    const dlStart = performance.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(testUrl, { signal: controller.signal });
      const buf = await response.arrayBuffer();
      clearTimeout(timeoutId);

      const durationMs = Math.max(performance.now() - dlStart, 1);
      const bytes = buf.byteLength;
      const mbps = Number(((bytes * 8) / (durationMs / 1000) / (1000 * 1000)).toFixed(2));

      throughputBenchmark = {
        tested: true,
        target_url: testUrl,
        bytes_transferred: bytes,
        duration_ms: Math.round(durationMs),
        download_speed_mbps: mbps,
      };
    } catch (err: any) {
      throughputBenchmark = {
        tested: true,
        target_url: testUrl,
        bytes_transferred: 0,
        duration_ms: Math.round(performance.now() - dlStart),
        download_speed_mbps: null,
        error: err?.message || String(err),
      };
    }
  }

  return {
    gateway_watchdog: {
      gateway_ip: gatewayIp,
      role: "Mikrotik Office Gateway",
      online: gwOnline,
      latency_ms: gwAvgLatency,
      jitter_ms: gwOnline ? gwJitter : null,
      detection_method: gwMethod,
      open_services: gwOpenServices,
      status: gwStatus,
    },
    internet_connected: reachableProbes.length > 0 || dnsTest.resolved,
    average_internet_latency_ms: avgInternetLatency,
    probes,
    dns_resolution_test: dnsTest,
    ...(throughputBenchmark ? { throughput_benchmark: throughputBenchmark } : {}),
  };
}

/**
 * Expands a `/24` CIDR or IP range (e.g. `192.168.0.0/24` or `192.168.0.1-192.168.0.254`) into a list of host IPs.
 */
function parseSubnetTargets(subnetInput: string): string[] {
  const input = subnetInput.trim();

  // Format: A.B.C.0/24 or A.B.C.X/24
  const cidr24Match = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (cidr24Match) {
    const o1 = Number(cidr24Match[1]);
    const o2 = Number(cidr24Match[2]);
    const o3 = Number(cidr24Match[3]);
    const o4 = Number(cidr24Match[4]);
    const prefix = Number(cidr24Match[5]);

    if (
      [o1, o2, o3, o4].some((n) => n < 0 || n > 255) ||
      prefix < 24 ||
      prefix > 32
    ) {
      throw new Error(
        `Invalid or unsupported CIDR '${input}'. Supported prefix length is /24 to /32 (e.g., 192.168.0.0/24).`
      );
    }

    if (prefix === 32) {
      return [`${o1}.${o2}.${o3}.${o4}`];
    }

    const hostBits = 32 - prefix;
    const count = 1 << hostBits;
    const baseHost = o4 & (~(count - 1) & 0xff);
    const startHost = Math.max(1, baseHost + 1);
    const endHost = Math.min(254, baseHost + count - 2);

    const ips: string[] = [];
    for (let h = startHost; h <= endHost; h++) {
      ips.push(`${o1}.${o2}.${o3}.${h}`);
    }
    return ips;
  }

  // Format: A.B.C.start-end (e.g. 192.168.0.1-50)
  const shortRangeMatch = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})-(\d{1,3})$/);
  if (shortRangeMatch) {
    const o1 = Number(shortRangeMatch[1]);
    const o2 = Number(shortRangeMatch[2]);
    const o3 = Number(shortRangeMatch[3]);
    const start = Number(shortRangeMatch[4]);
    const end = Number(shortRangeMatch[5]);
    if (
      [o1, o2, o3, start, end].some((n) => n < 0 || n > 255) ||
      start > end
    ) {
      throw new Error(`Invalid IP range '${input}'.`);
    }
    const ips: string[] = [];
    for (let h = start; h <= end; h++) {
      ips.push(`${o1}.${o2}.${o3}.${h}`);
    }
    return ips;
  }

  // Single IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) {
    return [input];
  }

  throw new Error(
    `Unsupported subnet format '${input}'. Use '192.168.0.0/24', '192.168.0.1-50', or single IPv4.`
  );
}

export interface DiscoveredLanHost {
  ip: string;
  role?: string;
  online: boolean;
  latency_ms: number | null;
  detection_method: string;
  mac?: string;
  arp_interface?: string;
  open_probe_port?: number;
}

/**
 * Ping Sweep Scanner for local office subnet (`192.168.0.0/24`) with concurrency control
 * and host ARP cache correlation (`/host/proc/net/arp`).
 */
async function runSubnetPingSweep(
  subnet = DEFAULT_OFFICE_SUBNET,
  concurrency = 64,
  timeoutMs = 500
): Promise<{
  subnet: string;
  total_ips_scanned: number;
  online_count: number;
  scan_duration_ms: number;
  known_infrastructure: {
    ubuntu_host_ip: string;
    mikrotik_gateway_ip: string;
  };
  online_hosts: DiscoveredLanHost[];
}> {
  const start = performance.now();
  const targetIps = parseSubnetTargets(subnet);
  const arpData = await getHostArpTable();
  const arpMap = new Map<string, ArpNeighborEntry>();
  for (const entry of arpData.entries) {
    arpMap.set(entry.ip, entry);
  }

  const onlineHosts: DiscoveredLanHost[] = [];
  const batchSize = Math.min(Math.max(concurrency, 8), 128);

  for (let i = 0; i < targetIps.length; i += batchSize) {
    const batch = targetIps.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (ip) => {
        const probe = await probeHostAliveAndLatency(
          ip,
          [80, 443, 22, 8291, 445, 3389, 53],
          timeoutMs
        );
        const arpEntry = arpMap.get(ip);

        // If TCP/ICMP probe succeeded OR host ARP cache has a valid complete MAC entry
        const isOnline = probe.online || Boolean(arpEntry?.reachable_in_arp);
        if (!isOnline) return null;

        let role: string | undefined;
        if (ip === DEFAULT_HOST_IP) role = "Ubuntu Server Host";
        else if (ip === DEFAULT_MIKROTIK_GATEWAY) role = "Mikrotik Gateway";

        return {
          ip,
          ...(role ? { role } : {}),
          online: true,
          latency_ms: probe.latency_ms,
          detection_method: probe.online
            ? probe.detection_method
            : "host_arp_cache",
          ...(arpEntry && arpEntry.mac !== "00:00:00:00:00:00"
            ? { mac: arpEntry.mac, arp_interface: arpEntry.interface }
            : {}),
          ...(probe.open_probe_port ? { open_probe_port: probe.open_probe_port } : {}),
        } as DiscoveredLanHost;
      })
    );

    for (const item of batchResults) {
      if (item) onlineHosts.push(item);
    }
  }

  return {
    subnet,
    total_ips_scanned: targetIps.length,
    online_count: onlineHosts.length,
    scan_duration_ms: Math.round(performance.now() - start),
    known_infrastructure: {
      ubuntu_host_ip: DEFAULT_HOST_IP,
      mikrotik_gateway_ip: DEFAULT_MIKROTIK_GATEWAY,
    },
    online_hosts: onlineHosts,
  };
}

export interface PortScanItem {
  port: number;
  service: string;
  state: "OPEN" | "CLOSED" | "FILTERED_TIMEOUT";
  latency_ms: number | null;
}

/**
 * Local Port Scanner: Scans TCP ports on a target IP (e.g. `192.168.0.x`) with fast async socket connect.
 */
async function scanHostPorts(
  targetIp: string,
  ports: number[] = DEFAULT_SCAN_PORTS,
  timeoutMs = 800
): Promise<{
  target_ip: string;
  host_alive: boolean;
  total_ports_scanned: number;
  open_ports_count: number;
  open_ports: PortScanItem[];
  closed_or_filtered_summary: {
    closed_count: number;
    filtered_timeout_count: number;
  };
}> {
  const uniquePorts = Array.from(new Set(ports)).filter(
    (p) => Number.isInteger(p) && p >= 1 && p <= 65535
  );

  const scanResults = await Promise.all(
    uniquePorts.map(async (port): Promise<PortScanItem> => {
      const res = await measureTcpProbe(targetIp, port, timeoutMs, true);
      const service = PORT_SERVICE_NAMES[port] || "unknown";

      if (res.status === "OPEN") {
        return {
          port,
          service,
          state: "OPEN",
          latency_ms: res.latency_ms,
        };
      }
      if (res.status === "CLOSED_HOST_ALIVE") {
        return {
          port,
          service,
          state: "CLOSED",
          latency_ms: res.latency_ms,
        };
      }
      return {
        port,
        service,
        state: "FILTERED_TIMEOUT",
        latency_ms: null,
      };
    })
  );

  const openPorts = scanResults.filter((r) => r.state === "OPEN");
  const closedCount = scanResults.filter((r) => r.state === "CLOSED").length;
  const filteredCount = scanResults.filter((r) => r.state === "FILTERED_TIMEOUT").length;

  return {
    target_ip: targetIp,
    host_alive: openPorts.length > 0 || closedCount > 0,
    total_ports_scanned: uniquePorts.length,
    open_ports_count: openPorts.length,
    open_ports: openPorts,
    closed_or_filtered_summary: {
      closed_count: closedCount,
      filtered_timeout_count: filteredCount,
    },
  };
}

/**
 * Validates optional target IP/hostname.
 */
function sanitizeHostTarget(input: unknown): string {
  const value = String(input || "").trim();
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(value)) {
    throw new Error(`Invalid target host '${value}'.`);
  }
  return value;
}

/**
 * MCP Tool 1: `monitor_network`
 * Comprehensive Host Ubuntu (192.168.0.3) & Office Network Monitoring (prioritizing `/host/proc/net` & `/host/sys/class/net`).
 */
export const monitorNetworkTool: ToolDefinition = {
  name: "monitor_network",
  description:
    "Monitor Ubuntu Host (192.168.0.3) & Office Network metrics: (1) Host Traffic & Bandwidth per interface from /host/proc/net/dev (fallback /proc/net/dev), (2) Real-time Traffic Rate (Mbps, PPS) & Looping / Broadcast Storm Anomaly Detection (POTENTIAL_LOOPING_OR_STORM), (3) Host Network Interface Status (IPv4, IPv6, MAC, UP/DOWN, link speed), (4) Host Listening TCP/UDP Ports & Active Connections (/host/proc/net/tcp & udp), and (5) Mikrotik Gateway Watchdog (192.168.0.254) + Internet Connectivity & RTT Latency test (1.1.1.1, 8.8.8.8).",
  inputSchema: {
    type: "object",
    properties: {
      interface: {
        type: "string",
        description:
          "Optional specific network interface name to filter traffic and status (e.g., 'eth0', 'enp3s0', 'ens18', 'docker0'). If omitted, returns all host interfaces.",
      },
      gateway_ip: {
        type: "string",
        description:
          "Optional office gateway IP for watchdog monitoring (defaults to Mikrotik gateway '192.168.0.254').",
      },
      sample_interval_ms: {
        type: "number",
        description:
          "Sampling interval in milliseconds (250 - 5000) to calculate real-time traffic rate (Mbps/PPS) and detect looping/broadcast storm. Default: 1000.",
      },
      include_throughput_test: {
        type: "boolean",
        description:
          "If true, performs an active HTTP download throughput benchmark (Mbps) against Cloudflare speed endpoint. Default: false.",
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

    const gatewayIp = args.gateway_ip
      ? sanitizeHostTarget(args.gateway_ip)
      : DEFAULT_MIKROTIK_GATEWAY;

    const sampleIntervalMs =
      args.sample_interval_ms !== undefined ? Number(args.sample_interval_ms) : 1000;

    const includeThroughputTest = Boolean(args.include_throughput_test);

    const extraTargets: string[] = [];
    if (Array.isArray(args.extra_ping_targets)) {
      for (const item of args.extra_ping_targets.slice(0, 5)) {
        extraTargets.push(sanitizeHostTarget(item));
      }
    }

    const [interfacesStatus, trafficCounters, trafficRateAndStorm, sockets, connectivity] =
      await Promise.all([
        getNetworkInterfacesStatus(filterInterface),
        getTrafficAndBandwidth(filterInterface),
        analyzeTrafficRateAndStorm(filterInterface, sampleIntervalMs),
        getListeningPortsAndConnections(),
        checkConnectivityGatewayAndThroughput(
          gatewayIp,
          extraTargets,
          includeThroughputTest
        ),
      ]);

    return formatToolResult({
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      office_network_context: {
        office_subnet: DEFAULT_OFFICE_SUBNET,
        ubuntu_host_ip: DEFAULT_HOST_IP,
        mikrotik_gateway_ip: gatewayIp,
      },
      interfaces_status: interfacesStatus,
      traffic_and_bandwidth: trafficCounters,
      traffic_rate_and_storm_detection: trafficRateAndStorm,
      ports_and_connections: sockets,
      connectivity_and_watchdog: connectivity,
    });
  },
};

/**
 * MCP Tool 2: `monitor_local_network`
 * Dedicated Office LAN (192.168.0.0/24) tool for Ping Sweep, Mikrotik Gateway Watchdog, Local Port Scanner,
 * Throughput/Latency Test, and Broadcast Storm / Looping Detection.
 */
export const monitorLocalNetworkTool: ToolDefinition = {
  name: "monitor_local_network",
  description:
    "Monitor and scan the local office network (192.168.0.0/24, Ubuntu Host 192.168.0.3, Mikrotik Gateway 192.168.0.254). Features: (A) Mikrotik Gateway Watchdog & Subnet Ping Sweep to discover active LAN IPs, MAC addresses (/host/proc/net/arp), and response times, (B) Fast Local TCP Port Scanner for target office IPs (FTP 21, SSH 22, Telnet 23, HTTP 80, HTTPS 443, SMB 445, RDP 3389, Mikrotik Winbox 8291, 8080, etc.), (C) Gateway & Internet Latency + Optional Download Throughput Test, and (D) Real-time Traffic Rate & Looping / Broadcast Storm Detection (POTENTIAL_LOOPING_OR_STORM).",
  inputSchema: {
    type: "object",
    properties: {
      subnet: {
        type: "string",
        description:
          "Office subnet or IP range to sweep for active hosts (default: '192.168.0.0/24', or range like '192.168.0.1-50').",
      },
      run_ping_sweep: {
        type: "boolean",
        description:
          "Whether to run the fast subnet ping sweep across the local network. Default: true.",
      },
      gateway_ip: {
        type: "string",
        description:
          "Mikrotik gateway IP address for watchdog & latency monitoring (default: '192.168.0.254').",
      },
      scan_target_ip: {
        type: "string",
        description:
          "Optional target IP address on the local network to run the TCP port scanner against (e.g., '192.168.0.254' or '192.168.0.3').",
      },
      scan_ports: {
        type: "array",
        items: { type: "number" },
        description:
          "Optional list of TCP ports to scan on 'scan_target_ip'. Defaults to common office & Mikrotik ports: [21, 22, 23, 53, 80, 443, 445, 3301, 3389, 5678, 8080, 8291, 8728].",
      },
      include_throughput_test: {
        type: "boolean",
        description:
          "If true, runs an HTTP download speed/throughput test (Mbps) to Cloudflare in addition to latency tests. Default: false.",
      },
      sample_interval_ms: {
        type: "number",
        description:
          "Sampling window in milliseconds (250 - 5000) for traffic rate & looping/broadcast storm detection. Default: 1000.",
      },
    },
    required: [],
  },
  handler: async (args) => {
    const subnet = args.subnet ? String(args.subnet).trim() : DEFAULT_OFFICE_SUBNET;
    const runPingSweep = args.run_ping_sweep !== undefined ? Boolean(args.run_ping_sweep) : true;
    const gatewayIp = args.gateway_ip
      ? sanitizeHostTarget(args.gateway_ip)
      : DEFAULT_MIKROTIK_GATEWAY;
    const scanTargetIp = args.scan_target_ip
      ? sanitizeHostTarget(args.scan_target_ip)
      : undefined;

    const customPorts = Array.isArray(args.scan_ports)
      ? args.scan_ports.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
      : DEFAULT_SCAN_PORTS;

    const includeThroughputTest = Boolean(args.include_throughput_test);
    const sampleIntervalMs =
      args.sample_interval_ms !== undefined ? Number(args.sample_interval_ms) : 1000;

    const [connectivityAndGateway, stormAndRate, arpTable, pingSweepResult, portScanResult] =
      await Promise.all([
        checkConnectivityGatewayAndThroughput(
          gatewayIp,
          [DEFAULT_HOST_IP],
          includeThroughputTest
        ),
        analyzeTrafficRateAndStorm(undefined, sampleIntervalMs),
        getHostArpTable(),
        runPingSweep ? runSubnetPingSweep(subnet, 64, 500) : Promise.resolve(undefined),
        scanTargetIp
          ? scanHostPorts(scanTargetIp, customPorts, 800)
          : Promise.resolve(undefined),
      ]);

    return formatToolResult({
      timestamp: new Date().toISOString(),
      office_network_context: {
        subnet,
        ubuntu_host_ip: DEFAULT_HOST_IP,
        mikrotik_gateway_ip: gatewayIp,
      },
      gateway_and_connectivity: connectivityAndGateway,
      traffic_rate_and_storm_detection: stormAndRate,
      host_arp_neighbors: arpTable,
      ...(pingSweepResult ? { ping_sweep: pingSweepResult } : {}),
      ...(portScanResult ? { port_scanner: portScanResult } : {}),
    });
  },
};

export default [monitorNetworkTool, monitorLocalNetworkTool];
