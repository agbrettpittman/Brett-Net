//! Name resolution and TCP reachability.
//!
//! The port check exists for two reasons. It answers "is this service up?",
//! which is the other half of what a network tool is asked. And it is the
//! fallback for a host that blocks ICMP entirely — the single risk that would
//! otherwise gut the ping graph on a corporate network.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::icmp::{EchoOutcome, PingBackend, PingStatus};

/// Ports offered as a starting point. Deliberately short — a full scan is a
/// different tool, and looks far more like an attack to anything watching.
pub const COMMON_PORTS: [u16; 12] = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3389, 8080];

/// Concurrent connection attempts.
///
/// This is what makes a wide scan finish in minutes rather than hours: at one
/// port at a time, 65,535 ports against a host that drops everything would take
/// a day and a half. Each worker is a thread blocked in `connect`, so they are
/// cheap in CPU and cost only their stack.
const MAX_WORKERS: usize = 256;

/// Workers only block on a socket, so they need almost no stack. The default
/// 1 MB reservation each would be 256 MB of address space for nothing.
const WORKER_STACK: usize = 64 * 1024;

/// Every TCP port. A scan is allowed to be as wide as the port space is.
pub const MAX_PORTS: usize = 65535;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    pub host: String,
    /// Every address the resolver returned, in its order — which is the order
    /// a client would try them.
    pub addresses: Vec<String>,
    /// How long resolution took.
    pub ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PortState {
    /// Connected. Something is listening.
    Open,
    /// Actively refused — nothing is listening, but **the host is up**, which
    /// is why this is not lumped in with a timeout.
    Refused,
    /// No answer at all. A firewall is dropping it, or the host is down.
    Filtered,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub port: u16,
    pub state: PortState,
    /// Time to the answer. `None` for a timeout, which measures the timeout
    /// rather than the network.
    pub ms: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortScanConfig {
    pub ports: Vec<u16>,
    pub timeout_ms: u64,
}

/// Resolves a hostname to every address the system resolver offers.
///
/// Blocks, so callers run it off the async runtime.
pub fn resolve(host: &str) -> Result<DnsResult, String> {
    let query = host.trim();
    if query.is_empty() {
        return Err("enter a hostname or IP".into());
    }

    let started = Instant::now();
    // The port is irrelevant; `ToSocketAddrs` just needs one to parse.
    let resolved = (query, 0u16)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {query}: {e}"))?;

    let mut addresses = Vec::new();
    for addr in resolved {
        let ip = addr.ip().to_string();
        // The resolver commonly repeats an address once per socket type.
        if !addresses.contains(&ip) {
            addresses.push(ip);
        }
    }

    if addresses.is_empty() {
        return Err(format!("{query} resolved to no addresses"));
    }

    Ok(DnsResult {
        host: query.to_string(),
        addresses,
        ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Attempts one TCP connection.
///
/// **A refusal is not always fast.** Measured on Windows here, a closed port on
/// loopback took a little over two seconds to come back `ConnectionRefused` —
/// so with a short timeout the refusal loses the race and the port is reported
/// as filtered instead. That is not wrong, but it does mean the interesting
/// distinction between "shut" and "dropped" only appears if the wait is long
/// enough for the answer to arrive. Hence a two-second default, and a
/// selectable wait in the UI.
pub fn check_port(ip: IpAddr, port: u16, timeout: Duration) -> PortResult {
    let started = Instant::now();
    let addr = SocketAddr::new(ip, port);
    let elapsed = || Some(started.elapsed().as_secs_f64() * 1000.0);

    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => PortResult {
            port,
            state: PortState::Open,
            ms: elapsed(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => PortResult {
            port,
            // Nothing is listening, but the host answered — which proves it is
            // reachable, and is why this is not lumped in with a timeout.
            state: PortState::Refused,
            ms: elapsed(),
        },
        // Anything else — timed out, unreachable, reset — is a failure to reach
        // the service either way. Three states is as much nuance as this is
        // worth.
        Err(_) => PortResult {
            port,
            state: PortState::Filtered,
            ms: None,
        },
    }
}

/// Tallies of what a scan found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub checked: usize,
    pub open: usize,
    pub refused: usize,
    pub filtered: usize,
}

/// Checks many ports, reporting each as it finishes.
///
/// Results arrive in completion order because the checks run concurrently, so
/// callers that care about port order must sort. The returned summary is
/// authoritative even when the caller chooses not to forward every result —
/// which it should not, for a wide scan.
pub fn scan<F>(
    ip: IpAddr,
    ports: &[u16],
    timeout: Duration,
    cancelled: &AtomicBool,
    on_result: F,
) -> ScanSummary
where
    F: Fn(PortResult) + Send + Sync,
{
    let next = AtomicUsize::new(0);
    let open = AtomicUsize::new(0);
    let refused = AtomicUsize::new(0);
    let filtered = AtomicUsize::new(0);
    let workers = MAX_WORKERS.min(ports.len()).max(1);

    let work = || loop {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let i = next.fetch_add(1, Ordering::Relaxed);
        let Some(&port) = ports.get(i) else { break };

        let result = check_port(ip, port, timeout);
        match result.state {
            PortState::Open => &open,
            PortState::Refused => &refused,
            PortState::Filtered => &filtered,
        }
        .fetch_add(1, Ordering::Relaxed);

        on_result(result);
    };

    std::thread::scope(|scope| {
        let mut spawned = 0;
        for _ in 0..workers {
            let started = std::thread::Builder::new()
                .stack_size(WORKER_STACK)
                .spawn_scoped(scope, work);
            if started.is_err() {
                break;
            }
            spawned += 1;
        }
        // A machine that will not hand over a single thread still gets its
        // scan, just serially.
        if spawned == 0 {
            work();
        }
    });

    let (open, refused, filtered) = (
        open.load(Ordering::Relaxed),
        refused.load(Ordering::Relaxed),
        filtered.load(Ordering::Relaxed),
    );
    ScanSummary {
        checked: open + refused + filtered,
        open,
        refused,
        filtered,
    }
}

/// Trims a port list to something a scan should actually attempt.
///
/// The text box is parsed on the frontend, next to the field it belongs to —
/// this is the backstop, so a malformed or hostile IPC payload cannot turn the
/// tool into a port sweeper.
pub fn sanitise_ports(ports: &[u16]) -> Vec<u16> {
    // A bitmap rather than `Vec::contains`. The whole port space is a legal
    // list now, and a linear scan per entry would be four billion comparisons
    // for a full-range scan — the guard would cost more than the scan.
    let mut seen = vec![false; 1 << 16];
    let mut out: Vec<u16> = Vec::with_capacity(ports.len().min(MAX_PORTS));

    for &p in ports {
        // Port 0 parses fine but means "any", which cannot be connected to.
        if p == 0 || seen[p as usize] {
            continue;
        }
        seen[p as usize] = true;
        out.push(p);
        if out.len() == MAX_PORTS {
            break;
        }
    }
    out
}

/// Monitors a host by opening a TCP connection instead of pinging it.
///
/// This is the answer when a network filters ICMP: a host that never replies to
/// a ping still completes a handshake on a port it is serving, so the latency
/// chart keeps working. It plugs into the same scheduler as the ICMP backend.
///
/// **The two are not directly comparable.** A handshake is a round trip *plus*
/// whatever the far end takes to accept, so TCP readings sit above ICMP ones on
/// the same path. Mixing modes on one chart compares unlike things, which is why
/// the host table shows which mode each row uses.
///
/// Each probe closes its connection, which leaves a local socket in `TIME_WAIT`
/// for a couple of minutes. That is one socket per probe: fine at a host or two
/// once a second, but a dozen TCP hosts at 250 ms would hold thousands at a
/// time, so a slower rate is the right call for a list of them.
pub struct TcpBackend {
    pub port: u16,
}

impl PingBackend for TcpBackend {
    /// `ttl` is ignored: setting a per-connection TTL needs a raw socket option
    /// that `std` does not expose, and traceroute — the only caller that varies
    /// it — always uses ICMP.
    fn echo(&self, target: Ipv4Addr, _ttl: u8, timeout: Duration) -> EchoOutcome {
        let ip = IpAddr::V4(target);
        let result = check_port(ip, self.port, timeout);
        // Microseconds, to match what the ICMP backend measures. Saturating
        // rather than wrapping: a wait long enough to overflow would otherwise
        // come back as a suspiciously fast reply.
        let rtt_us = result
            .ms
            .map(|ms| (ms * 1000.0).clamp(0.0, u32::MAX as f64) as u32);

        let (status, rtt_us) = match result.state {
            PortState::Open => (PingStatus::Success, rtt_us),
            // The host answered — it is demonstrably up — but the check it was
            // asked to make failed, so this is not graphed as a latency sample.
            // Its own status keeps it distinguishable from a host that is down.
            PortState::Refused => (PingStatus::Refused, rtt_us),
            PortState::Filtered => (PingStatus::TimedOut, None),
        };

        EchoOutcome {
            status,
            rtt_us,
            from: Some(ip),
            raw_status: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn sanitise_drops_port_zero_and_duplicates() {
        assert_eq!(sanitise_ports(&[80, 0, 443, 80]), vec![80, 443]);
    }

    #[test]
    fn sanitise_keeps_the_whole_port_space() {
        let every: Vec<u16> = (1..=65535).collect();
        assert_eq!(sanitise_ports(&every).len(), MAX_PORTS);
    }

    #[test]
    fn sanitise_collapses_a_huge_duplicate_payload_quickly() {
        // The dedup used to be a linear scan per entry. At this size that is
        // billions of comparisons, and the guard would cost more than the scan
        // it protects.
        let spam: Vec<u16> = (0..200_000).map(|i| (i % 1000 + 1) as u16).collect();

        let started = Instant::now();
        let got = sanitise_ports(&spam);
        let elapsed = started.elapsed();

        assert_eq!(got.len(), 1000);
        assert!(elapsed < Duration::from_millis(500), "took {elapsed:?}");
    }

    #[test]
    fn sanitise_keeps_a_reasonable_list_untouched() {
        assert_eq!(sanitise_ports(&COMMON_PORTS), COMMON_PORTS.to_vec());
    }

    #[test]
    fn an_open_port_is_reported_open() {
        // Bind one so there is definitely something listening.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        let got = check_port(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            Duration::from_secs(2),
        );
        assert_eq!(got.state, PortState::Open);
        assert_eq!(got.port, port);
        assert!(got.ms.is_some(), "a real answer carries a timing");
    }

    #[test]
    fn a_closed_port_on_a_live_host_is_refused_not_filtered() {
        // Bind then drop, so the port is almost certainly free and the loopback
        // stack refuses rather than dropping. This distinction is the point of
        // the tool: refused proves the host is up.
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };

        let got = check_port(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            Duration::from_secs(5),
        );
        assert_eq!(
            got.state,
            PortState::Refused,
            "a refusal must not be mistaken for a timeout — it proves the host is up"
        );
        assert!(got.ms.is_some());
    }

    #[test]
    fn too_short_a_wait_turns_a_refusal_into_a_filtered_port() {
        // Documents a real limit rather than a bug. A refusal here takes about
        // two seconds, so a 200ms wait cannot possibly see it — the answer has
        // not arrived yet. Worth pinning: it is the reason the default wait is
        // two seconds and the reason the UI lets you raise it.
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.local_addr().unwrap().port()
        };

        let got = check_port(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            Duration::from_millis(200),
        );
        assert_eq!(got.state, PortState::Filtered);
    }

    #[test]
    fn an_unroutable_host_times_out_as_filtered() {
        // RFC 5737 TEST-NET-2: reserved and guaranteed unroutable.
        let got = check_port(
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7)),
            80,
            Duration::from_millis(300),
        );
        assert_eq!(got.state, PortState::Filtered);
        assert_eq!(
            got.ms, None,
            "a timeout measures the timeout, not the network"
        );
    }

    #[test]
    fn scan_reports_every_port_once() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let open = listener.local_addr().unwrap().port();
        // The duplicate is deliberate: `scan` takes the list as given.
        let ports: Vec<u16> = vec![open, open, 1, 2, 3];

        let seen = std::sync::Mutex::new(Vec::new());
        let flag = AtomicBool::new(false);
        let summary = scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &ports,
            Duration::from_millis(500),
            &flag,
            |r| seen.lock().unwrap().push(r),
        );

        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), ports.len());
        assert_eq!(seen.iter().filter(|r| r.port == open).count(), 2);
        assert_eq!(summary.checked, ports.len());
        assert_eq!(summary.open, 2);
    }

    #[test]
    fn the_summary_counts_every_state() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let open = listener.local_addr().unwrap().port();
        let closed = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap().port()
        };

        let flag = AtomicBool::new(false);
        let summary = scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &[open, closed],
            Duration::from_secs(5),
            &flag,
            |_| {},
        );

        assert_eq!(summary.checked, 2);
        assert_eq!(summary.open, 1);
        assert_eq!(summary.refused, 1);
        assert_eq!(summary.filtered, 0);
    }

    #[test]
    fn a_cancelled_scan_stops_early() {
        let flag = AtomicBool::new(true);
        let seen = std::sync::Mutex::new(Vec::new());

        let summary = scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &(1..=50).collect::<Vec<u16>>(),
            Duration::from_secs(5),
            &flag,
            |r| seen.lock().unwrap().push(r),
        );

        assert!(seen.into_inner().unwrap().is_empty());
        assert_eq!(summary, ScanSummary::default());
    }

    #[test]
    fn scan_of_an_empty_list_returns_immediately() {
        // `MAX_WORKERS.min(0)` would spawn no workers; the `.max(1)` guard
        // keeps the scope valid and this must simply do nothing.
        let flag = AtomicBool::new(false);
        let summary = scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &[],
            Duration::from_millis(50),
            &flag,
            |_| panic!("nothing to check"),
        );
        assert_eq!(summary.checked, 0);
    }

    #[test]
    fn a_wide_scan_uses_many_workers_at_once() {
        // The point of the whole design: 600 dead ports must not be checked
        // one at a time. Serially this would take ten minutes; concurrently it
        // is a couple of seconds.
        let ports: Vec<u16> = (1..=600).collect();
        let flag = AtomicBool::new(false);

        let started = Instant::now();
        let summary = scan(
            // TEST-NET-2, reserved and guaranteed unroutable, so every port
            // takes the full timeout.
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7)),
            &ports,
            Duration::from_millis(500),
            &flag,
            |_| {},
        );
        let elapsed = started.elapsed();

        assert_eq!(summary.checked, 600);
        assert_eq!(summary.filtered, 600);
        assert!(
            elapsed < Duration::from_secs(20),
            "600 ports took {elapsed:?}; concurrency is not working"
        );
    }

    #[test]
    fn resolves_localhost() {
        let got = resolve("localhost").unwrap();
        assert!(!got.addresses.is_empty());
        assert!(got.ms >= 0.0);
    }

    #[test]
    fn an_ip_literal_resolves_to_itself() {
        let got = resolve("8.8.8.8").unwrap();
        assert_eq!(got.addresses, vec!["8.8.8.8"]);
    }

    #[test]
    fn addresses_are_not_repeated_per_socket_type() {
        // `to_socket_addrs` yields an entry per socket type, so a single-homed
        // host would otherwise appear two or three times.
        let got = resolve("127.0.0.1").unwrap();
        assert_eq!(got.addresses, vec!["127.0.0.1"]);
    }

    #[test]
    fn an_empty_query_is_rejected_before_the_resolver() {
        assert!(resolve("   ").is_err());
    }

    #[test]
    fn an_unresolvable_name_is_an_error() {
        assert!(resolve("nope.invalid").is_err());
    }

    #[test]
    fn tcp_backend_reports_a_listening_port_as_a_successful_probe() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let backend = TcpBackend {
            port: listener.local_addr().unwrap().port(),
        };

        let out = backend.echo(Ipv4Addr::LOCALHOST, 128, Duration::from_secs(2));
        assert_eq!(out.status, PingStatus::Success);
        assert!(out.rtt_us.is_some(), "a successful probe must carry an RTT");
        assert_eq!(out.from, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[test]
    fn tcp_backend_keeps_a_refusal_distinct_from_a_timeout() {
        // The point of the mode: on a network that filters ICMP, a refusal is
        // still proof the host is up, so it must not look like a dead host.
        let port = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let backend = TcpBackend { port };

        let out = backend.echo(Ipv4Addr::LOCALHOST, 128, Duration::from_secs(5));
        assert_eq!(out.status, PingStatus::Refused);
        assert!(
            out.rtt_us.is_some(),
            "the round trip happened, even though nothing was listening"
        );
    }

    #[test]
    fn tcp_backend_reports_an_unreachable_host_as_timed_out() {
        // TEST-NET-2, reserved and guaranteed unroutable.
        let backend = TcpBackend { port: 80 };
        let out = backend.echo(
            Ipv4Addr::new(198, 51, 100, 7),
            128,
            Duration::from_millis(300),
        );

        assert_eq!(out.status, PingStatus::TimedOut);
        assert_eq!(
            out.rtt_us, None,
            "a timeout measures the wait, not the path"
        );
    }
}
