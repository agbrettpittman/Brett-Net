//! Name resolution and TCP reachability.
//!
//! The port check exists for two reasons. It answers "is this service up?",
//! which is the other half of what a network tool is asked. And it is the
//! fallback for a host that blocks ICMP entirely — the single risk that would
//! otherwise gut the ping graph on a corporate network.

use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Ports offered as a starting point. Deliberately short — a full scan is a
/// different tool, and looks far more like an attack to anything watching.
pub const COMMON_PORTS: [u16; 12] = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3389, 8080];

/// Concurrent connection attempts. Enough to keep a scan brisk, low enough not
/// to look like a port sweep.
const WORKERS: usize = 8;

pub const MAX_PORTS: usize = 128;

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

/// Checks many ports, reporting each as it finishes.
///
/// Runs a few at a time: sequentially, a dozen filtered ports at a two-second
/// timeout is nearly half a minute of staring at nothing. Results arrive in
/// completion order, so callers that care about port order must sort.
pub fn scan<F>(ip: IpAddr, ports: &[u16], timeout: Duration, cancelled: &AtomicBool, on_result: F)
where
    F: Fn(PortResult) + Send + Sync,
{
    let next = AtomicUsize::new(0);
    let workers = WORKERS.min(ports.len().max(1));

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(&port) = ports.get(i) else { break };
                on_result(check_port(ip, port, timeout));
            });
        }
    });
}

/// Trims a port list to something a scan should actually attempt.
///
/// The text box is parsed on the frontend, next to the field it belongs to —
/// this is the backstop, so a malformed or hostile IPC payload cannot turn the
/// tool into a port sweeper.
pub fn sanitise_ports(ports: &[u16]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(ports.len().min(MAX_PORTS));
    for &p in ports {
        // Port 0 parses fine but means "any", which cannot be connected to.
        if p == 0 || out.contains(&p) {
            continue;
        }
        out.push(p);
        if out.len() == MAX_PORTS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener};

    #[test]
    fn sanitise_drops_port_zero_and_duplicates() {
        assert_eq!(sanitise_ports(&[80, 0, 443, 80]), vec![80, 443]);
    }

    #[test]
    fn sanitise_caps_the_list() {
        let many: Vec<u16> = (1..=1000).collect();
        assert_eq!(sanitise_ports(&many).len(), MAX_PORTS);
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
        let ports: Vec<u16> = vec![open, open, 1, 2, 3];
        // The duplicate is deliberate: `scan` takes the list as given.
        let unique = 5;

        let seen = std::sync::Mutex::new(Vec::new());
        let flag = AtomicBool::new(false);
        scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &ports,
            Duration::from_millis(500),
            &flag,
            |r| seen.lock().unwrap().push(r),
        );

        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), unique);
        assert!(seen.iter().filter(|r| r.port == open).count() == 2);
        assert!(seen.iter().any(|r| r.state == PortState::Open));
    }

    #[test]
    fn a_cancelled_scan_stops_early() {
        let flag = AtomicBool::new(true);
        let seen = std::sync::Mutex::new(Vec::new());

        scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &(1..=50).collect::<Vec<u16>>(),
            Duration::from_secs(5),
            &flag,
            |r| seen.lock().unwrap().push(r),
        );

        assert!(seen.into_inner().unwrap().is_empty());
    }

    #[test]
    fn scan_of_an_empty_list_returns_immediately() {
        // `WORKERS.min(0)` would spawn no workers; the `.max(1)` guard keeps
        // the scope valid and this must simply do nothing.
        let flag = AtomicBool::new(false);
        scan(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &[],
            Duration::from_millis(50),
            &flag,
            |_| panic!("nothing to check"),
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
}
