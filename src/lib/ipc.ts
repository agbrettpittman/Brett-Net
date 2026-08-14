import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CounterSample } from './traffic';
import type { AwakeMode } from './keepAwake';
import type { Connection } from './connections';

/** Mirrors `icmp::PingStatus`. */
export type PingStatus =
  | 'success'
  | 'timedOut'
  | 'destHostUnreachable'
  | 'destNetUnreachable'
  | 'ttlExpired'
  | 'dnsFailure'
  /** TCP probe only: nothing listening on the port, but the host answered. */
  | 'refused'
  | 'other';

/**
 * How a host is probed. Mirrors `monitor::ProbeMode`, internally tagged so a
 * TCP mode without a port cannot be expressed.
 */
export type ProbeMode = { mode: 'icmp' } | { mode: 'tcp'; port: number };

export const ICMP: ProbeMode = { mode: 'icmp' };

export interface HostSpec {
  id: string;
  label: string;
  /** Hostname or IPv4 literal. */
  target: string;
  /** Absent means ICMP — the default, and what every host saved before TCP
   *  probe mode existed will be. */
  probe?: ProbeMode;
  /** Optional colour override. UI-only; never sent to the backend. */
  color?: string;
}

export interface PingResult {
  hostId: string;
  /** Microseconds. Null when nothing replied. */
  rttUs: number | null;
  status: PingStatus;
  from: string | null;
}

/** One batch of results, emitted once per interval rather than once per ping. */
export interface PingTick {
  seq: number;
  /** Unix epoch milliseconds. */
  t: number;
  results: PingResult[];
}

export interface HostInfo {
  appVersion: string;
  hostname: string;
  os: string;
}

export const PING_TICK_EVENT = 'ping://tick';

export function hostInfo(): Promise<HostInfo> {
  return invoke<HostInfo>('host_info');
}

export function startMonitor(
  hosts: HostSpec[],
  intervalMs: number,
  timeoutMs: number,
  retentionDays: number,
): Promise<void> {
  // Strip UI-only fields so the wire payload matches the Rust struct exactly.
  const wire = hosts.map(({ id, label, target, probe }) => ({
    id,
    label,
    target,
    probe: probe ?? ICMP,
  }));
  return invoke('start_monitor', {
    args: { hosts: wire, intervalMs, timeoutMs, retentionDays },
  });
}

export function stopMonitor(): Promise<void> {
  return invoke('stop_monitor');
}

/** Persisted UI state. The backend stores this opaquely. */
export interface Settings {
  hosts: HostSpec[];
  probeMs: number;
  bucketSec: number;
  spanSec: number;
  /** Days of ping history kept on disk. */
  retentionDays: number;
}

/** One stored sample, as read back from the history database. */
export interface HistorySample {
  /** Unix epoch milliseconds. */
  t: number;
  hostId: string;
  rttUs: number | null;
  status: PingStatus;
}

export interface HistoryStats {
  samples: number;
  bytes: number;
  oldestMs: number | null;
  newestMs: number | null;
  path: string;
  /** A background write or prune failed; history may be incomplete. */
  error: string | null;
}

export interface ExportResult {
  path: string;
  rows: number;
}

/**
 * Samples from earlier sessions, oldest first.
 *
 * @param spanSec how far back to read; 0 means the whole retention window
 * @param perHost cap on samples returned per host
 */
export function historySince(
  hostIds: string[],
  spanSec: number,
  perHost: number,
): Promise<HistorySample[]> {
  return invoke<HistorySample[]>('history_since', {
    query: { hostIds, spanSec, perHost },
  });
}

export function historyStats(): Promise<HistoryStats> {
  return invoke<HistoryStats>('history_stats');
}

/** Writes a CSV to the Downloads folder. `spanSec` of 0 exports everything. */
export function exportHistory(spanSec: number): Promise<ExportResult> {
  return invoke<ExportResult>('export_history', { spanSec });
}

export function loadSettings(): Promise<Settings | null> {
  return invoke<Settings | null>('load_settings');
}

export function saveSettings(value: Settings): Promise<void> {
  return invoke('save_settings', { value });
}

export function onPingTick(handler: (tick: PingTick) => void): Promise<UnlistenFn> {
  return listen<PingTick>(PING_TICK_EVENT, (event) => handler(event.payload));
}

/** Mirrors `trace::Hop`. */
export interface TraceHop {
  /** Time-to-live used for this hop, i.e. its position in the path. */
  ttl: number;
  /** Whatever replied — a router in between, or the target on the last hop. */
  addr: string | null;
  /** One entry per probe, in order; null where that probe timed out. */
  rttsUs: (number | null)[];
  status: PingStatus;
  /** This hop is the target, so the path is complete. */
  reached: boolean;
}

/** Mirrors `trace::Outcome`. Every one of these is a normal ending. */
export type TraceOutcome = 'reached' | 'maxHops' | 'filtered' | 'cancelled';

export type TraceEvent =
  | { kind: 'resolved'; target: string; addr: string }
  | ({ kind: 'hop' } & TraceHop)
  | { kind: 'done'; outcome: TraceOutcome };

export interface TraceConfig {
  maxHops: number;
  probes: number;
  timeoutMs: number;
  /** Consecutive silent hops before giving up. 0 walks the full `maxHops`. */
  silentLimit: number;
}

export const TRACE_DEFAULTS: TraceConfig = {
  maxHops: 30,
  probes: 3,
  timeoutMs: 1500,
  silentLimit: 5,
};

/** Mirrors `asn::AsnInfo`. */
export interface AsnInfo {
  ip: string;
  /** Null for an address not announced in BGP. */
  asn: number | null;
  /** Network operator, e.g. `CLOUDFLARENET - Cloudflare, Inc.` */
  name: string | null;
  prefix: string | null;
  country: string | null;
}

/**
 * Names the networks behind a set of hop addresses.
 *
 * Private, loopback and carrier-grade-NAT addresses are dropped in Rust before
 * anything leaves the machine. Addresses that could not be looked up are simply
 * absent from the result rather than being an error.
 */
export function lookupAsn(ips: string[]): Promise<AsnInfo[]> {
  return invoke<AsnInfo[]>('lookup_asn', { ips });
}

/**
 * Walks the path to `target`, calling `onEvent` as each hop is discovered.
 *
 * Resolves once the trace has finished. Only one trace runs at a time — a
 * second call cancels the first.
 */
export function runTrace(
  target: string,
  config: TraceConfig,
  onEvent: (event: TraceEvent) => void,
): Promise<void> {
  const channel = new Channel<TraceEvent>();
  channel.onmessage = onEvent;
  return invoke('run_trace', { target, config, onEvent: channel });
}

export function stopTrace(): Promise<void> {
  return invoke('stop_trace');
}

/** Mirrors `probe::DnsResult`. */
export interface DnsResult {
  host: string;
  /** Every address the resolver returned, in the order a client would try. */
  addresses: string[];
  ms: number;
}

/** Mirrors `probe::PortState`. */
export type PortState = 'open' | 'refused' | 'filtered';

export interface PortResult {
  port: number;
  state: PortState;
  /** Null for a timeout, which measures the timeout rather than the network. */
  ms: number | null;
}

export interface ScanSummary {
  checked: number;
  open: number;
  refused: number;
  filtered: number;
}

export type ScanEvent =
  | { kind: 'resolved'; target: string; addr: string; total: number }
  | ({ kind: 'port' } & PortResult)
  | { kind: 'progress'; done: number; total: number }
  /** `openOnly` means closed ports were counted but not listed. */
  | { kind: 'done'; summary: ScanSummary; openOnly: boolean };

/** Ports offered as a starting point, matching `probe::COMMON_PORTS`. */
export const COMMON_PORTS = '21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3389, 8080';

export function dnsLookup(host: string): Promise<DnsResult> {
  return invoke<DnsResult>('dns_lookup', { host });
}

/** Checks TCP ports, calling `onEvent` as each one finishes. */
export function scanPorts(
  host: string,
  ports: number[],
  timeoutMs: number,
  onEvent: (event: ScanEvent) => void,
): Promise<void> {
  const channel = new Channel<ScanEvent>();
  channel.onmessage = onEvent;
  return invoke('scan_ports', { host, config: { ports, timeoutMs }, onEvent: channel });
}

/** Mirrors `adapters::Adapter`. */
export interface Adapter {
  /** Stable key, matching `InterfaceCounters.luid`, for joining live counters. */
  luid: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  mac: string | null;
  /** Null where the driver does not report one, e.g. loopback. */
  mtu: number | null;
  speedBps: number | null;
  /** Unicast addresses in CIDR form, e.g. `192.168.1.5/24`. */
  addresses: string[];
  gateways: string[];
  dns: string[];
  dhcpServer: string | null;
  /** Up *and* configured — i.e. one this machine is actually using. */
  active: boolean;
}

export function listAdapters(): Promise<Adapter[]> {
  return invoke<Adapter[]>('list_adapters');
}

export const KEEP_AWAKE_EXPIRED_EVENT = 'keep-awake://expired';

/**
 * Applies a keep-awake mode, optionally for a limited time.
 *
 * Not persisted anywhere: it lasts until switched off, until the timer runs
 * out, or until the app closes.
 *
 * @param seconds how long before it releases itself; 0 means no limit
 */
export function setKeepAwake(mode: AwakeMode, seconds: number): Promise<void> {
  return invoke('set_keep_awake', { mode, seconds });
}

/** Fires when a timed request runs out, so the UI can drop back to Off. */
export function onKeepAwakeExpired(handler: () => void): Promise<UnlistenFn> {
  return listen(KEEP_AWAKE_EXPIRED_EVENT, () => handler());
}

/** Every open TCP connection, with the process that owns it. */
export function listConnections(): Promise<Connection[]> {
  return invoke<Connection[]>('list_connections');
}

/** One read of every interface's cumulative byte counters. */
export function interfaceCounters(): Promise<CounterSample> {
  return invoke<CounterSample>('interface_counters');
}

/** Human-readable label for a status, used in the UI and tooltips. */
export const STATUS_LABEL: Record<PingStatus, string> = {
  success: 'OK',
  timedOut: 'Timed out',
  destHostUnreachable: 'Host unreachable',
  destNetUnreachable: 'Network unreachable',
  ttlExpired: 'TTL expired',
  dnsFailure: 'DNS failed',
  refused: 'Refused — host is up',
  other: 'Error',
};
