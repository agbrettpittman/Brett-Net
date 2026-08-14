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
    /// A TCP probe was actively refused: nothing is listening on that port, but
    /// the host answered, so it is up. Only ever produced by TCP probe mode —
    /// ICMP has no equivalent, and the distinction is the whole reason to reach
    /// for TCP when a network filters ping.
    Refused,
    /// Some other `IP_STATUS`; the raw code is kept on [`EchoOutcome::raw_status`].
    Other,
}

impl PingStatus {
    pub fn is_success(self) -> bool {
        matches!(self, PingStatus::Success)
    }

    /// Compact code for on-disk storage.
    ///
    /// Deliberately not the raw `IP_STATUS`: these are stable, one byte wide,
    /// and unchanged if the Win32 mapping above ever grows a case. Existing
    /// values must never be renumbered — a history database outlives a release.
    pub fn code(self) -> u8 {
        match self {
            PingStatus::Success => 0,
            PingStatus::TimedOut => 1,
            PingStatus::DestHostUnreachable => 2,
            PingStatus::DestNetUnreachable => 3,
            PingStatus::TtlExpired => 4,
            PingStatus::DnsFailure => 5,
            PingStatus::Other => 6,
            PingStatus::Refused => 7,
        }
    }

    /// Inverse of [`PingStatus::code`]. Unrecognised codes — a database written
    /// by a newer build — read back as `Other` rather than failing the query.
    pub fn from_code(code: u8) -> Self {
        match code {
            0 => PingStatus::Success,
            1 => PingStatus::TimedOut,
            2 => PingStatus::DestHostUnreachable,
            3 => PingStatus::DestNetUnreachable,
            4 => PingStatus::TtlExpired,
            5 => PingStatus::DnsFailure,
            7 => PingStatus::Refused,
            _ => PingStatus::Other,
        }
    }

    /// The same name the frontend sees, reused for CSV exports.
    pub fn as_str(self) -> &'static str {
        match self {
            PingStatus::Success => "success",
            PingStatus::TimedOut => "timedOut",
            PingStatus::DestHostUnreachable => "destHostUnreachable",
            PingStatus::DestNetUnreachable => "destNetUnreachable",
            PingStatus::TtlExpired => "ttlExpired",
            PingStatus::DnsFailure => "dnsFailure",
            PingStatus::Refused => "refused",
            PingStatus::Other => "other",
        }
    }

    pub const ALL: [PingStatus; 8] = [
        PingStatus::Success,
        PingStatus::TimedOut,
        PingStatus::DestHostUnreachable,
        PingStatus::DestNetUnreachable,
        PingStatus::TtlExpired,
        PingStatus::DnsFailure,
        PingStatus::Refused,
        PingStatus::Other,
    ];
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
        // A refusal proves the host is up, but the check it was asked to make
        // still failed — nothing is listening on that port.
        assert!(!PingStatus::Refused.is_success());
    }

    #[test]
    fn storage_codes_round_trip_and_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for s in PingStatus::ALL {
            assert_eq!(PingStatus::from_code(s.code()), s);
            assert!(seen.insert(s.code()), "duplicate code for {s:?}");
        }
    }

    #[test]
    fn unknown_storage_codes_degrade_to_other() {
        // A database written by a newer build must still be readable.
        assert_eq!(PingStatus::from_code(200), PingStatus::Other);
    }

    #[test]
    fn status_names_match_the_wire_format() {
        // `as_str` must stay in step with the camelCase serde renaming, since
        // the frontend's PingStatus union and CSV exports both rely on it.
        for s in PingStatus::ALL {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
        }
    }
}
