//! Per-interface byte counters, for measuring how much this machine is sending.
//!
//! The counters are cumulative since boot, so a rate is a delta between two
//! reads divided by the time between them. Everything here just reports the raw
//! numbers; the arithmetic lives in the frontend next to the chart that draws
//! it.

use serde::Serialize;

#[cfg(windows)]
pub mod windows;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceCounters {
    /// Stable key for one interface, as lower-case hex.
    ///
    /// **A string, not a number.** A `NET_LUID` packs the interface type into
    /// its top 16 bits, so a tunnel's LUID exceeds 2^53 and would quietly lose
    /// precision as a JSON number — which would make two interfaces look like
    /// one.
    pub luid: String,
    /// What Windows shows in Network Connections, e.g. `Wi-Fi`.
    pub name: String,
    /// Bytes received since boot.
    pub in_octets: u64,
    /// Bytes sent since boot.
    pub out_octets: u64,
}

/// One read of every interface, timestamped at the moment it was taken.
///
/// The timestamp comes from here rather than from the caller because IPC
/// latency and event-loop jitter would otherwise be counted as elapsed time,
/// which shows up as noise on the rate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterSample {
    /// Unix epoch milliseconds.
    pub t: i64,
    pub interfaces: Vec<InterfaceCounters>,
}

/// Formats a `NET_LUID` value as the key the frontend joins on.
pub fn luid_key(value: u64) -> String {
    format!("{value:016x}")
}

/// Reads every interface's counters.
#[cfg(windows)]
pub fn sample() -> Result<CounterSample, String> {
    Ok(CounterSample {
        t: crate::db::now_ms(),
        interfaces: windows::counters()?,
    })
}

/// Non-Windows builds exist only so the crate compiles for tooling.
#[cfg(not(windows))]
pub fn sample() -> Result<CounterSample, String> {
    Err("interface counters are only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luid_keys_are_fixed_width_hex() {
        assert_eq!(luid_key(0), "0000000000000000");
        assert_eq!(luid_key(6), "0000000000000006");
        assert_eq!(luid_key(u64::MAX), "ffffffffffffffff");
    }

    #[test]
    fn a_luid_past_the_safe_integer_range_still_round_trips_as_text() {
        // A tunnel interface (IF_TYPE 131) puts 131 in the top 16 bits, which is
        // 3.7e16 — well past 2^53. As a JSON number it would be rounded, and two
        // interfaces could collide onto one key.
        let tunnel = 131u64 << 48;
        assert!(tunnel > (1u64 << 53));
        assert_eq!(luid_key(tunnel), "0083000000000000");
        assert_eq!(u64::from_str_radix(&luid_key(tunnel), 16).unwrap(), tunnel);
    }

    #[test]
    fn distinct_luids_never_share_a_key() {
        let a = luid_key(131u64 << 48);
        let b = luid_key((131u64 << 48) + 1);
        assert_ne!(a, b);
    }
}
