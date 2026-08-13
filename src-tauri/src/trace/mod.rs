//! Traceroute.
//!
//! The same ICMP echo the ping engine uses, with the TTL walked up from 1. Each
//! router that decrements the TTL to zero answers with "TTL expired in transit",
//! and `ICMP_ECHO_REPLY.Address` is that router — which is the whole reason the
//! FFI was hand-rolled rather than taken from a crate.
//!
//! Hops are reported as they are discovered rather than returned in a batch. A
//! trace across a filtered path can take minutes, and a UI that shows nothing
//! until it finishes is indistinguishable from one that has hung.

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::icmp::{PingBackend, PingStatus};

pub const DEFAULT_MAX_HOPS: u8 = 30;
pub const DEFAULT_PROBES: u8 = 3;
pub const DEFAULT_TIMEOUT_MS: u64 = 1500;

/// Consecutive hops with no reply at all before the path is called filtered.
///
/// `tracert` walks all 30 regardless, which behind a corporate firewall that
/// drops TTL-expired ICMP means two minutes of nothing after the first hop. Five
/// is the compromise: long enough to cross the handful of deliberately silent
/// routers that appear in real paths, short enough that a fully blocked trace
/// gives up while the user is still watching.
pub const SILENT_HOP_LIMIT: u8 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub ttl: u8,
    /// Whatever replied — the intermediate router, or the target on the last
    /// hop. `None` when nothing answered.
    pub addr: Option<String>,
    /// One entry per probe, in order. `None` where that probe timed out, so a
    /// hop that answers intermittently is visible rather than averaged away.
    pub rtts_us: Vec<Option<u32>>,
    pub status: PingStatus,
    /// This hop *is* the target, so the trace is complete.
    pub reached: bool,
}

impl Hop {
    /// Whether every probe to this hop went unanswered.
    pub fn is_silent(&self) -> bool {
        self.addr.is_none() && self.rtts_us.iter().all(Option::is_none)
    }
}

/// Why a trace stopped. Every one of these is a normal ending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The target answered.
    Reached,
    /// Ran out of hops without arriving.
    MaxHops,
    /// [`SILENT_HOP_LIMIT`] consecutive hops answered nothing.
    Filtered,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceConfig {
    pub max_hops: u8,
    pub probes: u8,
    pub timeout_ms: u64,
}

impl Default for TraceConfig {
    fn default() -> Self {
        Self {
            max_hops: DEFAULT_MAX_HOPS,
            probes: DEFAULT_PROBES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl TraceConfig {
    /// Clamps whatever came in from the frontend to something sane.
    fn sanitised(&self) -> (u8, u8, Duration) {
        (
            self.max_hops.clamp(1, 64),
            self.probes.clamp(1, 10),
            Duration::from_millis(self.timeout_ms.clamp(100, 10_000)),
        )
    }
}

/// Walks the path to `target`, calling `on_hop` once per TTL.
///
/// Blocks, so callers run it off the async runtime. `cancelled` is checked
/// between probes, which bounds how long a stop takes to one timeout.
pub fn run<F>(
    backend: &dyn PingBackend,
    target: Ipv4Addr,
    cfg: &TraceConfig,
    cancelled: &AtomicBool,
    mut on_hop: F,
) -> Outcome
where
    F: FnMut(&Hop),
{
    let (max_hops, probes, timeout) = cfg.sanitised();
    let mut silent = 0u8;

    for ttl in 1..=max_hops {
        let mut rtts_us = Vec::with_capacity(probes as usize);
        let mut addr: Option<String> = None;
        // Nothing answering is a timeout; the first real answer replaces it.
        let mut status = PingStatus::TimedOut;
        let mut reached = false;

        for _ in 0..probes {
            if cancelled.load(Ordering::Relaxed) {
                return Outcome::Cancelled;
            }

            let out = backend.echo(target, ttl, timeout);
            rtts_us.push(out.rtt_us);

            if addr.is_none() {
                if let Some(a) = out.from {
                    addr = Some(a.to_string());
                }
            }
            if out.status != PingStatus::TimedOut {
                status = out.status;
            }
            if out.status.is_success() {
                reached = true;
            }
        }

        let hop = Hop {
            ttl,
            addr,
            rtts_us,
            status,
            reached,
        };

        silent = if hop.is_silent() { silent + 1 } else { 0 };
        let quit_early = silent >= SILENT_HOP_LIMIT;

        on_hop(&hop);

        if hop.reached {
            return Outcome::Reached;
        }
        if quit_early {
            return Outcome::Filtered;
        }
    }

    Outcome::MaxHops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icmp::{EchoOutcome, IP_REQ_TIMED_OUT, IP_SUCCESS, IP_TTL_EXPIRED_TRANSIT};
    use std::net::IpAddr;
    use std::sync::Mutex;

    /// A scripted network path: `hops[i]` is what answers at TTL `i + 1`.
    /// `None` means that router stays silent.
    struct Path {
        hops: Vec<Option<Ipv4Addr>>,
        target: Ipv4Addr,
        calls: Mutex<usize>,
    }

    impl Path {
        fn new(hops: Vec<Option<Ipv4Addr>>, target: Ipv4Addr) -> Self {
            Self {
                hops,
                target,
                calls: Mutex::new(0),
            }
        }
    }

    impl PingBackend for Path {
        fn echo(&self, _target: Ipv4Addr, ttl: u8, _timeout: Duration) -> EchoOutcome {
            *self.calls.lock().unwrap() += 1;

            match self.hops.get(ttl as usize - 1) {
                Some(Some(addr)) if *addr == self.target => EchoOutcome {
                    status: PingStatus::Success,
                    rtt_us: Some(1000 * u32::from(ttl)),
                    from: Some(IpAddr::V4(*addr)),
                    raw_status: IP_SUCCESS,
                },
                Some(Some(addr)) => EchoOutcome {
                    status: PingStatus::TtlExpired,
                    rtt_us: Some(1000 * u32::from(ttl)),
                    from: Some(IpAddr::V4(*addr)),
                    raw_status: IP_TTL_EXPIRED_TRANSIT,
                },
                _ => EchoOutcome {
                    status: PingStatus::TimedOut,
                    rtt_us: None,
                    from: None,
                    raw_status: IP_REQ_TIMED_OUT,
                },
            }
        }
    }

    fn ip(last: u8) -> Ipv4Addr {
        Ipv4Addr::new(10, 0, 0, last)
    }

    fn cfg(probes: u8) -> TraceConfig {
        TraceConfig {
            max_hops: 30,
            probes,
            timeout_ms: 100,
        }
    }

    fn collect(backend: &dyn PingBackend, cfg: &TraceConfig) -> (Vec<Hop>, Outcome) {
        let mut hops = Vec::new();
        let flag = AtomicBool::new(false);
        let outcome = run(backend, ip(99), cfg, &flag, |h| hops.push(h.clone()));
        (hops, outcome)
    }

    #[test]
    fn walks_the_path_and_stops_at_the_target() {
        let target = ip(99);
        let path = Path::new(vec![Some(ip(1)), Some(ip(2)), Some(target)], target);

        let (hops, outcome) = collect(&path, &cfg(1));

        assert_eq!(outcome, Outcome::Reached);
        assert_eq!(hops.len(), 3, "must stop as soon as the target answers");
        assert_eq!(hops[0].ttl, 1);
        assert_eq!(hops[0].addr.as_deref(), Some("10.0.0.1"));
        assert_eq!(hops[0].status, PingStatus::TtlExpired);
        assert!(!hops[0].reached);
        assert!(hops[2].reached);
        assert_eq!(hops[2].status, PingStatus::Success);
    }

    #[test]
    fn records_every_probe_separately() {
        let target = ip(99);
        let path = Path::new(vec![Some(target)], target);

        let (hops, _) = collect(&path, &cfg(3));
        assert_eq!(hops[0].rtts_us.len(), 3, "one entry per probe");
        assert!(hops[0].rtts_us.iter().all(Option::is_some));
    }

    #[test]
    fn a_silent_router_mid_path_does_not_end_the_trace() {
        let target = ip(99);
        // Hop 2 stays quiet, which is extremely common and not a failure.
        let path = Path::new(vec![Some(ip(1)), None, Some(ip(3)), Some(target)], target);

        let (hops, outcome) = collect(&path, &cfg(1));

        assert_eq!(outcome, Outcome::Reached);
        assert_eq!(hops.len(), 4);
        assert!(hops[1].is_silent());
        assert_eq!(hops[1].addr, None);
        assert_eq!(hops[1].status, PingStatus::TimedOut);
        assert_eq!(hops[2].addr.as_deref(), Some("10.0.0.3"));
    }

    #[test]
    fn gives_up_after_a_run_of_silent_hops() {
        // The firewall case: one gateway answers, then nothing ever does.
        let target = ip(99);
        let path = Path::new(vec![Some(ip(1))], target);

        let (hops, outcome) = collect(&path, &cfg(1));

        assert_eq!(outcome, Outcome::Filtered);
        assert_eq!(
            hops.len(),
            1 + SILENT_HOP_LIMIT as usize,
            "the hop that trips the limit is still reported"
        );
        assert!(hops.last().unwrap().is_silent());
    }

    #[test]
    fn the_silent_run_resets_when_a_hop_answers() {
        let target = ip(99);
        // Four quiet hops, then an answer — must not be called filtered.
        let path = Path::new(
            vec![
                Some(ip(1)),
                None,
                None,
                None,
                None,
                Some(ip(6)),
                Some(target),
            ],
            target,
        );

        let (hops, outcome) = collect(&path, &cfg(1));
        assert_eq!(outcome, Outcome::Reached);
        assert_eq!(hops.len(), 7);
    }

    #[test]
    fn runs_out_of_hops_when_the_target_never_answers() {
        let target = ip(99);
        // Every hop answers, but none of them is the target.
        let path = Path::new(vec![Some(ip(1)); 10], target);
        let mut c = cfg(1);
        c.max_hops = 4;

        let (hops, outcome) = collect(&path, &c);
        assert_eq!(outcome, Outcome::MaxHops);
        assert_eq!(hops.len(), 4);
    }

    #[test]
    fn cancelling_stops_between_probes() {
        let target = ip(99);
        let path = Path::new(vec![Some(ip(1)); 30], target);

        let mut hops = Vec::new();
        let flag = AtomicBool::new(true); // already cancelled
        let outcome = run(&path, target, &cfg(3), &flag, |h| hops.push(h.clone()));

        assert_eq!(outcome, Outcome::Cancelled);
        assert!(hops.is_empty());
        assert_eq!(
            *path.calls.lock().unwrap(),
            0,
            "a cancelled trace must not send anything"
        );
    }

    #[test]
    fn config_is_clamped_to_a_usable_range() {
        let (hops, probes, timeout) = TraceConfig {
            max_hops: 0,
            probes: 0,
            timeout_ms: 1,
        }
        .sanitised();
        assert_eq!((hops, probes), (1, 1));
        assert_eq!(timeout, Duration::from_millis(100));

        let (hops, probes, timeout) = TraceConfig {
            max_hops: 250,
            probes: 200,
            timeout_ms: 600_000,
        }
        .sanitised();
        assert_eq!((hops, probes), (64, 10));
        assert_eq!(timeout, Duration::from_millis(10_000));
    }

    #[test]
    fn defaults_match_the_documented_constants() {
        let d = TraceConfig::default();
        assert_eq!(d.max_hops, DEFAULT_MAX_HOPS);
        assert_eq!(d.probes, DEFAULT_PROBES);
        assert_eq!(d.timeout_ms, DEFAULT_TIMEOUT_MS);
    }
}
