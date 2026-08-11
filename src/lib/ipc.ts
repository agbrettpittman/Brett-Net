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
): Promise<void> {
  return invoke('start_monitor', { args: { hosts, intervalMs, timeoutMs } });
}

export function stopMonitor(): Promise<void> {
  return invoke('stop_monitor');
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
