//! ICMP echo, abstracted over a platform backend.
//!
//! The Windows backend calls `IcmpSendEcho2` from `iphlpapi.dll`, which works
//! without administrator rights — unlike raw sockets, which Windows restricts
//! to the Administrators group.

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use serde::Serialize;

#[cfg(windows)]
pub mod windows;

pub mod mock;

/// Outcome categories, mapped from Win32 `IP_STATUS` codes.
///
/// These are surfaced distinctly in the UI: a timeout and a "destination
/// unreachable" look identical on a latency graph but mean very different
/// things when you're troubleshooting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PingStatus {
    Success,
    TimedOut,
    DestHostUnreachable,
    DestNetUnreachable,
    /// TTL hit zero in transit. Expected during a traceroute; a fault otherwise.
    TtlExpired,
    /// Name resolution failed, so no echo was ever sent.
    DnsFailure,
    /// Some other `IP_STATUS`; the raw code is kept on [`EchoOutcome::raw_status`].
    Other,
}

impl PingStatus {
    pub fn is_success(self) -> bool {
        matches!(self, PingStatus::Success)
    }
}

#[derive(Debug, Clone)]
pub struct EchoOutcome {
    pub status: PingStatus,
    /// Measured round-trip time in microseconds, wall-clocked around the call.
    /// Present whenever *something* replied — including a TTL-expired router,
    /// which is what gives the traceroute view its per-hop timings. `None` only
    /// when nothing came back at all.
    pub rtt_us: Option<u32>,
    /// Address that actually replied. For a TTL-expired reply this is the
    /// intermediate router, which is what makes traceroute possible.
    pub from: Option<IpAddr>,
    /// The underlying `IP_STATUS` code, retained for diagnostics.
    pub raw_status: u32,
}

impl EchoOutcome {
    pub fn dns_failure() -> Self {
        Self {
            status: PingStatus::DnsFailure,
            rtt_us: None,
            from: None,
            raw_status: 0,
        }
    }
}

/// A synchronous echo. Callers run this on a blocking thread pool — the Win32
/// call blocks, and wrapping it in `spawn_blocking` is far simpler than driving
/// the event/APC completion machinery for no measurable benefit at our rates.
pub trait PingBackend: Send + Sync + 'static {
    fn echo(&self, target: Ipv4Addr, ttl: u8, timeout: Duration) -> EchoOutcome;
}

// IP_STATUS codes. See:
// https://learn.microsoft.com/en-us/windows/win32/api/ipexport/ns-ipexport-icmp_echo_reply
pub const IP_SUCCESS: u32 = 0;
pub const IP_BUF_TOO_SMALL: u32 = 11001;
pub const IP_DEST_NET_UNREACHABLE: u32 = 11002;
pub const IP_DEST_HOST_UNREACHABLE: u32 = 11003;
pub const IP_DEST_PROT_UNREACHABLE: u32 = 11004;
pub const IP_DEST_PORT_UNREACHABLE: u32 = 11005;
pub const IP_REQ_TIMED_OUT: u32 = 11010;
pub const IP_TTL_EXPIRED_TRANSIT: u32 = 11013;
pub const IP_TTL_EXPIRED_REASSEM: u32 = 11014;

pub fn classify(raw: u32) -> PingStatus {
    match raw {
        IP_SUCCESS => PingStatus::Success,
        IP_REQ_TIMED_OUT => PingStatus::TimedOut,
        IP_DEST_HOST_UNREACHABLE | IP_DEST_PROT_UNREACHABLE | IP_DEST_PORT_UNREACHABLE => {
            PingStatus::DestHostUnreachable
        }
        IP_DEST_NET_UNREACHABLE => PingStatus::DestNetUnreachable,
        IP_TTL_EXPIRED_TRANSIT | IP_TTL_EXPIRED_REASSEM => PingStatus::TtlExpired,
        _ => PingStatus::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_status_codes() {
        assert_eq!(classify(IP_SUCCESS), PingStatus::Success);
        assert_eq!(classify(IP_REQ_TIMED_OUT), PingStatus::TimedOut);
        assert_eq!(
            classify(IP_DEST_NET_UNREACHABLE),
            PingStatus::DestNetUnreachable
        );
        assert_eq!(classify(IP_TTL_EXPIRED_TRANSIT), PingStatus::TtlExpired);
    }

    #[test]
    fn groups_unreachable_variants_together() {
        for code in [
            IP_DEST_HOST_UNREACHABLE,
            IP_DEST_PROT_UNREACHABLE,
            IP_DEST_PORT_UNREACHABLE,
        ] {
            assert_eq!(classify(code), PingStatus::DestHostUnreachable);
        }
    }

    #[test]
    fn unknown_codes_fall_through_to_other() {
        assert_eq!(classify(IP_BUF_TOO_SMALL), PingStatus::Other);
        assert_eq!(classify(49152), PingStatus::Other);
    }

    #[test]
    fn only_success_counts_as_success() {
        assert!(PingStatus::Success.is_success());
        assert!(!PingStatus::TimedOut.is_success());
        assert!(!PingStatus::TtlExpired.is_success());
    }
}
