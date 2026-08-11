//! Deterministic backend for testing the scheduler without touching the network.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use super::{EchoOutcome, PingBackend, PingStatus, IP_REQ_TIMED_OUT, IP_SUCCESS};

/// Replays a scripted sequence of outcomes per target, cycling once exhausted.
pub struct MockBackend {
    scripts: Mutex<HashMap<Ipv4Addr, Vec<EchoOutcome>>>,
    default_rtt_us: u32,
    calls: AtomicUsize,
}

impl MockBackend {
    pub fn new(default_rtt_us: u32) -> Self {
        Self {
            scripts: Mutex::new(HashMap::new()),
            default_rtt_us,
            calls: AtomicUsize::new(0),
        }
    }

    pub fn script(&self, target: Ipv4Addr, outcomes: Vec<EchoOutcome>) {
        self.scripts.lock().unwrap().insert(target, outcomes);
    }

    pub fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub fn success(rtt_us: u32) -> EchoOutcome {
        EchoOutcome {
            status: PingStatus::Success,
            rtt_us: Some(rtt_us),
            from: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            raw_status: IP_SUCCESS,
        }
    }

    pub fn timeout() -> EchoOutcome {
        EchoOutcome {
            status: PingStatus::TimedOut,
            rtt_us: None,
            from: None,
            raw_status: IP_REQ_TIMED_OUT,
        }
    }
}

impl PingBackend for MockBackend {
    fn echo(&self, target: Ipv4Addr, _ttl: u8, _timeout: Duration) -> EchoOutcome {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let scripts = self.scripts.lock().unwrap();
        match scripts.get(&target) {
            Some(seq) if !seq.is_empty() => seq[n % seq.len()].clone(),
            _ => Self::success(self.default_rtt_us),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unscripted_targets_get_the_default() {
        let b = MockBackend::new(1234);
        let out = b.echo(Ipv4Addr::LOCALHOST, 128, Duration::from_secs(1));
        assert_eq!(out.status, PingStatus::Success);
        assert_eq!(out.rtt_us, Some(1234));
    }

    #[test]
    fn scripted_outcomes_cycle_in_order() {
        let target = Ipv4Addr::new(10, 0, 0, 1);
        let b = MockBackend::new(0);
        b.script(
            target,
            vec![MockBackend::success(500), MockBackend::timeout()],
        );

        assert_eq!(
            b.echo(target, 128, Duration::ZERO).status,
            PingStatus::Success
        );
        assert_eq!(
            b.echo(target, 128, Duration::ZERO).status,
            PingStatus::TimedOut
        );
        // wraps around
        assert_eq!(
            b.echo(target, 128, Duration::ZERO).status,
            PingStatus::Success
        );
        assert_eq!(b.call_count(), 3);
    }
}
