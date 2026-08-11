//! Windows ICMP backend built on `IcmpSendEcho2` (iphlpapi.dll).
//!
//! Two details drive this implementation, both verified against a live
//! Windows 11 host running as a non-elevated standard user:
//!
//! 1. `ICMP_ECHO_REPLY::RoundTripTime` is integer milliseconds and is `0` for
//!    TTL-expired replies, so it is useless for both LAN latency and
//!    per-hop traceroute timing. We wall-clock the call instead.
//! 2. `ICMP_ECHO_REPLY::Address` is the address that *replied*, which for a
//!    TTL-expired reply is the intermediate router. That is what makes
//!    traceroute possible without raw sockets.

use std::ffi::c_void;
use std::mem::MaybeUninit;
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{
    IcmpCreateFile, IcmpSendEcho2, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION,
};

use super::{classify, EchoOutcome, PingBackend, PingStatus};

/// Payload size matching `ping.exe`'s default, so RTTs are comparable.
const PAYLOAD: [u8; 32] = [b'a'; 32];

/// Room for the reply struct, our echoed payload, and 8 bytes for a possible
/// ICMP error message, as the API documentation requires.
const REPLY_CAP: usize = size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8;

/// The reply buffer is reinterpreted as an `ICMP_ECHO_REPLY`, which contains
/// pointers and therefore needs pointer alignment. A bare `[u8; N]` is only
/// 1-byte aligned, so casting one is undefined behaviour — this wrapper forces
/// the alignment the struct actually requires.
#[repr(C, align(8))]
struct ReplyBuf([MaybeUninit<u8>; REPLY_CAP]);

const _: () = assert!(
    align_of::<ICMP_ECHO_REPLY>() <= 8,
    "ReplyBuf alignment no longer satisfies ICMP_ECHO_REPLY"
);

/// An `IcmpCreateFile` handle, closed on drop.
struct IcmpHandle(HANDLE);

impl Drop for IcmpHandle {
    fn drop(&mut self) {
        // SAFETY: self.0 came from a successful IcmpCreateFile and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub struct WindowsIcmp;

impl PingBackend for WindowsIcmp {
    fn echo(&self, target: Ipv4Addr, ttl: u8, timeout: Duration) -> EchoOutcome {
        // SAFETY: IcmpCreateFile takes no arguments and returns a handle or an error.
        let handle = match unsafe { IcmpCreateFile() } {
            Ok(h) => IcmpHandle(h),
            Err(_) => {
                return EchoOutcome {
                    status: PingStatus::Other,
                    rtt_us: None,
                    from: None,
                    raw_status: u32::MAX,
                }
            }
        };

        let options = IP_OPTION_INFORMATION {
            Ttl: ttl,
            Tos: 0,
            Flags: 0,
            OptionsSize: 0,
            OptionsData: std::ptr::null_mut(),
        };

        let mut reply = ReplyBuf([MaybeUninit::<u8>::uninit(); REPLY_CAP]);
        let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;

        // in_addr is little-endian-native here: the octets map directly onto the u32.
        let dest = u32::from_ne_bytes(target.octets());

        let started = Instant::now();
        // SAFETY: the handle is valid; the reply buffer is at least REPLY_CAP bytes;
        // passing None for both Event and ApcRoutine selects the synchronous form,
        // so the call returns only once the reply has been written or it times out.
        let replies = unsafe {
            IcmpSendEcho2(
                handle.0,
                None,
                None,
                None,
                dest,
                PAYLOAD.as_ptr() as *const c_void,
                PAYLOAD.len() as u16,
                Some(&options),
                reply.0.as_mut_ptr() as *mut c_void,
                REPLY_CAP as u32,
                timeout_ms,
            )
        };
        // Read the thread's last-error before anything else can clobber it;
        // Instant::elapsed() issues a syscall of its own.
        // SAFETY: GetLastError only reads thread-local state.
        let last_error = unsafe { GetLastError().0 };
        let elapsed = started.elapsed();

        if replies == 0 {
            // No reply landed in the buffer, so GetLastError carries the IP_STATUS.
            let raw = last_error;
            return EchoOutcome {
                status: classify(raw),
                rtt_us: None,
                from: None,
                raw_status: raw,
            };
        }

        // SAFETY: a non-zero return means at least one ICMP_ECHO_REPLY was written,
        // and ReplyBuf is aligned for it.
        let parsed = unsafe { &*(reply.0.as_ptr() as *const ICMP_ECHO_REPLY) };
        let status = classify(parsed.Status);

        EchoOutcome {
            status,
            // Any reply — success, TTL-expired, or unreachable — is a real
            // measured round trip. The traceroute view needs the timing on
            // TTL-expired hops, and the latency graph filters on status anyway.
            rtt_us: Some(elapsed.as_micros().min(u32::MAX as u128) as u32),
            from: (parsed.Address != 0)
                .then(|| IpAddr::V4(Ipv4Addr::from(parsed.Address.to_ne_bytes()))),
            raw_status: parsed.Status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_buffer_meets_documented_minimum() {
        assert!(REPLY_CAP >= size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8);
    }

    #[test]
    fn loopback_replies_quickly() {
        let out = WindowsIcmp.echo(Ipv4Addr::LOCALHOST, 128, Duration::from_secs(2));
        assert_eq!(out.status, PingStatus::Success, "raw={}", out.raw_status);
        assert!(out.rtt_us.is_some());
        assert_eq!(out.from, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    /// Diagnostic, not a correctness check: walks the TTL up and prints each
    /// responding hop. Run with `cargo test -- --ignored --nocapture` to see
    /// the path. Ignored by default because output depends on the network.
    #[test]
    #[ignore]
    fn print_path_to_public_dns() {
        let target = Ipv4Addr::new(8, 8, 8, 8);
        for ttl in 1..=8u8 {
            let out = WindowsIcmp.echo(target, ttl, Duration::from_secs(1));
            println!(
                "ttl={:<2} status={:<20} from={:<16} rtt={}",
                ttl,
                format!("{:?}", out.status),
                out.from
                    .map(|a| a.to_string())
                    .unwrap_or_else(|| "-".into()),
                out.rtt_us
                    .map(|u| format!("{:.2}ms", u as f64 / 1000.0))
                    .unwrap_or_else(|| "-".into()),
            );
            if out.status == PingStatus::Success {
                break;
            }
        }
    }

    #[test]
    fn ttl_of_one_expires_in_transit_or_reaches_a_local_host() {
        // Against a public address, TTL=1 should be dropped by the first hop,
        // which must identify itself. On an isolated machine it may simply
        // time out; both are acceptable, a panic is not.
        let out = WindowsIcmp.echo(Ipv4Addr::new(8, 8, 8, 8), 1, Duration::from_secs(2));
        assert!(
            matches!(
                out.status,
                PingStatus::TtlExpired | PingStatus::TimedOut | PingStatus::DestNetUnreachable
            ),
            "unexpected status {:?} (raw={})",
            out.status,
            out.raw_status
        );
        if out.status == PingStatus::TtlExpired {
            assert!(out.from.is_some(), "TTL-expired reply must name the router");
            assert!(
                out.rtt_us.is_some(),
                "TTL-expired reply must carry a measured RTT, or the traceroute \
                 view has no per-hop timings"
            );
        }
    }
}
