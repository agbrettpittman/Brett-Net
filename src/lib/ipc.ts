import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Mirrors `icmp::PingStatus`. */
export type PingStatus =
  | 'success'
  | 'timedOut'
  | 'destHostUnreachable'
  | 'destNetUnreachable'
  | 'ttlExpired'
  | 'dnsFailure'
  | 'other';

export interface HostSpec {
  id: string;
  label: string;
  /** Hostname or IPv4 literal. */
  target: string;
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
  const wire = hosts.map(({ id, label, target }) => ({ id, label, target }));
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

/** Human-readable label for a status, used in the UI and tooltips. */
export const STATUS_LABEL: Record<PingStatus, string> = {
  success: 'OK',
  timedOut: 'Timed out',
  destHostUnreachable: 'Host unreachable',
  destNetUnreachable: 'Network unreachable',
  ttlExpired: 'TTL expired',
  dnsFailure: 'DNS failed',
  other: 'Error',
};
